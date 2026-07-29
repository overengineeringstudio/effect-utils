/**
 * Import map resolution for Node.js subpath imports.
 *
 * When genie imports a .genie.ts file, it needs to resolve `#...` import specifiers
 * using the package.json `imports` field from the source file's nearest package.json,
 * not the CWD's package.json.
 *
 * This module provides utilities to:
 * 1. Find the nearest package.json to a source file
 * 2. Extract and parse the `imports` field
 * 3. Resolve `#...` specifiers to their actual file paths
 */

import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { FileSystem } from 'effect/FileSystem'
import { Effect, Option } from 'effect'

import * as Observability from '../observability.ts'
import {
  type ImportMap,
  isImportMapSpecifier,
  parseImportMapFromGenieSource,
  parseImportMapFromPackageJsonContent,
  resolveImportMapSpecifier,
  resolveMegarepoMemberSpecifierSync,
} from './sync-resolver.ts'

// Re-export the bootstrap-safe sync API (now defined in ./sync-resolver.ts) so existing consumers
// that import these from ./mod.ts keep working unchanged.
export type { ImportMap }
export { isImportMapSpecifier, resolveImportMapSpecifier }
export {
  extractImportMapSync,
  findPackageJsonWithImportsSync,
  resolveImportMapSpecifierForImporterSync,
} from './sync-resolver.ts'

/**
 * Find the nearest package.json by walking up from the given file path.
 * Returns None if no package.json is found before reaching the filesystem root.
 */
export const findNearestPackageJson = Effect.fn('findNearestPackageJson')(function* (
  fromPath: string,
) {
  yield* Observability.annotatePath({ label: 'package.json', path: fromPath })
  const effectFs = yield* FileSystem.FileSystem
  let dir = path.dirname(fromPath)
  const root = path.parse(dir).root

  while (dir !== root) {
    const packageJsonPath = path.join(dir, 'package.json')
    const exists = yield* effectFs.exists(packageJsonPath).pipe(Effect.orElseSucceed(() => false))
    if (exists === true) {
      return Option.some(packageJsonPath)
    }
    dir = path.dirname(dir)
  }

  return Option.none()
})

/**
 * Find a package.json with an imports field by walking up from the given file path.
 * This searches for the nearest package.json that actually has import maps defined,
 * which is typically the monorepo root rather than individual package directories.
 *
 * Returns None if no package.json with imports is found.
 */
export const findPackageJsonWithImports = Effect.fn('findPackageJsonWithImports')(function* (
  fromPath: string,
) {
  yield* Observability.annotatePath({ label: 'imports', path: fromPath })
  const effectFs = yield* FileSystem.FileSystem
  let dir = path.dirname(fromPath)
  const root = path.parse(dir).root

  while (dir !== root) {
    const packageJsonPath = path.join(dir, 'package.json')

    // Check if package.json exists and has imports
    const pkgExists = yield* effectFs
      .exists(packageJsonPath)
      .pipe(Effect.orElseSucceed(() => false))
    if (pkgExists === true) {
      const contentResult = yield* effectFs.readFileString(packageJsonPath).pipe(
        Effect.either,
        Effect.orElseSucceed(() => ({ _tag: 'Left' as const, left: null })),
      )
      if (contentResult._tag === 'Right') {
        const importMap = parseImportMapFromPackageJsonContent(contentResult.right)
        if (Object.keys(importMap).length > 0) {
          return Option.some(packageJsonPath)
        }
      }
    }

    // Also check for package.json.genie.ts with imports (bootstrap case)
    const genieSourcePath = path.join(dir, 'package.json.genie.ts')
    const genieExists = yield* effectFs
      .exists(genieSourcePath)
      .pipe(Effect.orElseSucceed(() => false))
    if (genieExists === true) {
      const sourceResult = yield* effectFs.readFileString(genieSourcePath).pipe(
        Effect.either,
        Effect.orElseSucceed(() => ({ _tag: 'Left' as const, left: null })),
      )
      if (sourceResult._tag === 'Right') {
        const importMap = parseImportMapFromGenieSource(sourceResult.right)
        if (Object.keys(importMap).length > 0) {
          return Option.some(packageJsonPath)
        }
      }
    }

    dir = path.dirname(dir)
  }

  return Option.none()
})

/**
 * Extract the `imports` field from a package.json file.
 * Returns an empty object if the file doesn't exist or has no imports field.
 *
 * Also checks the corresponding package.json.genie.ts source file if the
 * package.json doesn't have imports. This enables bootstrapping when the
 * genie source has imports but the generated file hasn't been updated yet.
 */
export const extractImportMap = Effect.fn('extractImportMap')(function* (packageJsonPath: string) {
  yield* Observability.annotatePath({ label: 'import-map', path: packageJsonPath })
  const effectFs = yield* FileSystem.FileSystem

  // First try the generated package.json
  const pkgExists = yield* effectFs.exists(packageJsonPath).pipe(Effect.orElseSucceed(() => false))
  if (pkgExists === true) {
    const contentResult = yield* effectFs.readFileString(packageJsonPath).pipe(
      Effect.either,
      Effect.orElseSucceed(() => ({ _tag: 'Left' as const, left: null })),
    )
    if (contentResult._tag === 'Right') {
      const importMap = parseImportMapFromPackageJsonContent(contentResult.right)
      if (Object.keys(importMap).length > 0) {
        return importMap
      }
    }
  }

  // Fallback: try to extract from package.json.genie.ts source
  // This enables bootstrapping when genie source has imports but generated file doesn't
  const genieSourcePath = `${packageJsonPath}.genie.ts`
  const genieExists = yield* effectFs
    .exists(genieSourcePath)
    .pipe(Effect.orElseSucceed(() => false))
  if (genieExists === true) {
    const sourceResult = yield* effectFs.readFileString(genieSourcePath).pipe(
      Effect.either,
      Effect.orElseSucceed(() => ({ _tag: 'Left' as const, left: null })),
    )
    if (sourceResult._tag === 'Right') {
      const importMap = parseImportMapFromGenieSource(sourceResult.right)
      if (Object.keys(importMap).length > 0) {
        return importMap
      }
    }
  }

  return {}
})

/**
 * Resolve a `#...` import specifier based on the nearest package.json import map
 * to the importing file. Returns None when no matching import map applies.
 */
export const resolveImportMapSpecifierForImporter = Effect.fn(
  'genie.resolveImportMapSpecifierForImporter',
)(function* ({ specifier, importerPath }: { specifier: string; importerPath: string }) {
  yield* Observability.annotatePath({ label: specifier, path: importerPath })
  if (isImportMapSpecifier(specifier) === false) {
    return Option.none()
  }

  const resolvedMegarepoMember = resolveMegarepoMemberSpecifierSync({
    specifier,
    importerPath,
  })
  if (resolvedMegarepoMember !== undefined) {
    return Option.some(resolvedMegarepoMember)
  }

  const packageJsonPathOption = yield* findPackageJsonWithImports(importerPath)
  if (Option.isNone(packageJsonPathOption) === true) {
    return Option.none()
  }

  const packageJsonPath = packageJsonPathOption.value
  const importMap = yield* extractImportMap(packageJsonPath)
  if (Object.keys(importMap).length === 0) {
    return Option.none()
  }

  const resolved = resolveImportMapSpecifier({
    specifier,
    importMap,
    packageJsonDir: path.dirname(packageJsonPath),
  })

  if (resolved === null) {
    return Option.none()
  }

  return Option.some(resolved)
})

/**
 * Regex to match import/export statements with string specifiers.
 * Captures: full match, quote char, specifier
 */
const IMPORT_REGEX = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?(['"])([^'"]+)\1/g

/**
 * Transform source code by resolving all `#...` import specifiers.
 *
 * @param sourceCode - The TypeScript source code
 * @param sourcePath - Absolute path to the source file (used to find package.json)
 * @param resolveRelativeImports - When true, converts relative imports to absolute file URLs.
 * @returns The transformed source code with resolved import paths
 */
export const resolveImportMapsInSource = Effect.fn('resolveImportMapsInSource')(function* ({
  sourceCode,
  sourcePath,
  resolveRelativeImports = false,
}: {
  sourceCode: string
  sourcePath: string
  resolveRelativeImports?: boolean
}) {
  yield* Observability.annotatePath({ label: 'resolve-imports', path: sourcePath })
  const packageJsonPathOption = yield* findPackageJsonWithImports(sourcePath)
  const packageJsonPath = Option.getOrUndefined(packageJsonPathOption)
  const importMap = packageJsonPath === undefined ? {} : yield* extractImportMap(packageJsonPath)
  const packageJsonDir = packageJsonPath === undefined ? undefined : path.dirname(packageJsonPath)
  const sourceDir = path.dirname(sourcePath)
  const normalizeSpecifier = (filePath: string) =>
    resolveRelativeImports === true ? pathToFileURL(filePath).href : filePath

  return sourceCode.replace(IMPORT_REGEX, (match, quote, specifier) => {
    if (isImportMapSpecifier(specifier) === false) {
      if (
        resolveRelativeImports === true &&
        (specifier.startsWith('./') === true || specifier.startsWith('../') === true)
      ) {
        const resolvedRelative = path.resolve(sourceDir, specifier)
        return match.replace(specifier, normalizeSpecifier(resolvedRelative))
      }
      return match
    }

    const resolved =
      resolveMegarepoMemberSpecifierSync({
        specifier,
        importerPath: sourcePath,
      }) ??
      (packageJsonDir === undefined || Object.keys(importMap).length === 0
        ? null
        : resolveImportMapSpecifier({
            specifier,
            importMap,
            packageJsonDir,
          }))

    if (resolved === null) {
      return match
    }

    // Replace the specifier in the match
    return match.replace(specifier, normalizeSpecifier(resolved))
  })
})

/**
 * Get the import map context for a source file.
 * Returns None if no package.json with imports is found.
 */
