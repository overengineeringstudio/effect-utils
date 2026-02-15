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

import fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { FileSystem } from '@effect/platform'
import { Effect, Option } from 'effect'

/** Parsed import map from package.json#imports */
export type ImportMap = Record<string, string>

const parseImportMapFromPackageJsonContent = (content: string): ImportMap => {
  try {
    const parsed = JSON.parse(content) as { imports?: ImportMap }
    if (parsed.imports && Object.keys(parsed.imports).length > 0) {
      return parsed.imports
    }
  } catch {
    // Ignore JSON parse errors and return empty map
  }

  return {}
}

const parseImportMapFromGenieSource = (sourceContent: string): ImportMap => {
  const importsMatch = sourceContent.match(/imports:\s*\{([^}]+)\}/)
  if (!importsMatch) {
    return {}
  }

  const importsBlock = importsMatch[1]!
  const importMap: ImportMap = {}
  const pairRegex = /'([^']+)':\s*'([^']+)'/g
  let match: RegExpExecArray | null = pairRegex.exec(importsBlock)
  while (match !== null) {
    importMap[match[1]!] = match[2]!
    match = pairRegex.exec(importsBlock)
  }

  return importMap
}

/**
 * Find the nearest package.json by walking up from the given file path.
 * Returns None if no package.json is found before reaching the filesystem root.
 */
export const findNearestPackageJson = Effect.fn('findNearestPackageJson')(function* (
  fromPath: string,
) {
  const fs = yield* FileSystem.FileSystem
  let dir = path.dirname(fromPath)
  const root = path.parse(dir).root

  while (dir !== root) {
    const packageJsonPath = path.join(dir, 'package.json')
    const exists = yield* fs.exists(packageJsonPath).pipe(Effect.orElseSucceed(() => false))
    if (exists) {
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
  const fs = yield* FileSystem.FileSystem
  let dir = path.dirname(fromPath)
  const root = path.parse(dir).root

  while (dir !== root) {
    const packageJsonPath = path.join(dir, 'package.json')

    // Check if package.json exists and has imports
    const pkgExists = yield* fs.exists(packageJsonPath).pipe(Effect.orElseSucceed(() => false))
    if (pkgExists) {
      const contentResult = yield* fs.readFileString(packageJsonPath).pipe(
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
    const genieExists = yield* fs.exists(genieSourcePath).pipe(Effect.orElseSucceed(() => false))
    if (genieExists) {
      const sourceResult = yield* fs.readFileString(genieSourcePath).pipe(
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
 * Synchronous version of findPackageJsonWithImports for Bun resolver hooks.
 */
export const findPackageJsonWithImportsSync = (fromPath: string): string | undefined => {
  let dir = path.dirname(fromPath)
  const root = path.parse(dir).root

  while (dir !== root) {
    const packageJsonPath = path.join(dir, 'package.json')

    if (fs.existsSync(packageJsonPath)) {
      try {
        const content = fs.readFileSync(packageJsonPath, 'utf8')
        const importMap = parseImportMapFromPackageJsonContent(content)
        if (Object.keys(importMap).length > 0) {
          return packageJsonPath
        }
      } catch {
        // Ignore parse/read errors and continue searching upward
      }
    }

    const genieSourcePath = path.join(dir, 'package.json.genie.ts')
    if (fs.existsSync(genieSourcePath)) {
      try {
        const sourceContent = fs.readFileSync(genieSourcePath, 'utf8')
        const importMap = parseImportMapFromGenieSource(sourceContent)
        if (Object.keys(importMap).length > 0) {
          return packageJsonPath
        }
      } catch {
        // Ignore read errors and continue searching upward
      }
    }

    dir = path.dirname(dir)
  }

  return undefined
}

/**
 * Extract the `imports` field from a package.json file.
 * Returns an empty object if the file doesn't exist or has no imports field.
 *
 * Also checks the corresponding package.json.genie.ts source file if the
 * package.json doesn't have imports. This enables bootstrapping when the
 * genie source has imports but the generated file hasn't been updated yet.
 */
export const extractImportMap = Effect.fn('extractImportMap')(function* (packageJsonPath: string) {
  const fs = yield* FileSystem.FileSystem

  // First try the generated package.json
  const pkgExists = yield* fs.exists(packageJsonPath).pipe(Effect.orElseSucceed(() => false))
  if (pkgExists) {
    const contentResult = yield* fs.readFileString(packageJsonPath).pipe(
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
  const genieExists = yield* fs.exists(genieSourcePath).pipe(Effect.orElseSucceed(() => false))
  if (genieExists) {
    const sourceResult = yield* fs.readFileString(genieSourcePath).pipe(
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
 * Synchronous import map extraction for resolver hooks.
 */
export const extractImportMapSync = (packageJsonPath: string): ImportMap => {
  if (fs.existsSync(packageJsonPath)) {
    try {
      const content = fs.readFileSync(packageJsonPath, 'utf8')
      const importMap = parseImportMapFromPackageJsonContent(content)
      if (Object.keys(importMap).length > 0) {
        return importMap
      }
    } catch {
      // Ignore parse/read errors and continue to genie source fallback
    }
  }

  const genieSourcePath = `${packageJsonPath}.genie.ts`
  if (fs.existsSync(genieSourcePath)) {
    try {
      const sourceContent = fs.readFileSync(genieSourcePath, 'utf8')
      const importMap = parseImportMapFromGenieSource(sourceContent)
      if (Object.keys(importMap).length > 0) {
        return importMap
      }
    } catch {
      // Ignore parse/read errors and return empty map
    }
  }

  return {}
}

/**
 * Check if a specifier is an import map specifier (starts with #).
 */
export const isImportMapSpecifier = (specifier: string): boolean => {
  return specifier.startsWith('#')
}

/**
 * Resolve an import map specifier to an absolute file path.
 *
 * Supports wildcard patterns like `#genie/*` -> `./path/to/*`
 *
 * @param specifier - The import specifier (e.g., `#genie/mod.ts`)
 * @param importMap - The parsed import map from package.json
 * @param packageJsonDir - The directory containing the package.json
 * @returns The resolved absolute path, or null if no match
 */
export const resolveImportMapSpecifier = ({
  specifier,
  importMap,
  packageJsonDir,
}: {
  specifier: string
  importMap: ImportMap
  packageJsonDir: string
}): string | null => {
  // Try exact match first
  if (specifier in importMap) {
    const target = importMap[specifier]!
    return path.resolve(packageJsonDir, target)
  }

  // Try wildcard patterns (e.g., #genie/* -> ./path/*)
  for (const [pattern, target] of Object.entries(importMap)) {
    if (pattern.endsWith('/*') === false || target.endsWith('/*') === false) continue

    const prefix = pattern.slice(0, -1) // Remove trailing *
    if (specifier.startsWith(prefix) === true) {
      const suffix = specifier.slice(prefix.length)
      const resolvedTarget = target.slice(0, -1) + suffix // Replace * with suffix
      return path.resolve(packageJsonDir, resolvedTarget)
    }
  }

  return null
}

/**
 * Resolve a `#...` import specifier based on the nearest package.json import map
 * to the importing file. Returns None when no matching import map applies.
 */
export const resolveImportMapSpecifierForImporter = Effect.fn(
  'genie.resolveImportMapSpecifierForImporter',
)(function* ({ specifier, importerPath }: { specifier: string; importerPath: string }) {
  if (isImportMapSpecifier(specifier) === false) {
    return Option.none()
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
 * Synchronous import map resolution for Bun resolver hooks.
 */
export const resolveImportMapSpecifierForImporterSync = ({
  specifier,
  importerPath,
}: {
  specifier: string
  importerPath: string
}): string | undefined => {
  if (isImportMapSpecifier(specifier) === false) {
    return undefined
  }

  const packageJsonPath = findPackageJsonWithImportsSync(importerPath)
  if (!packageJsonPath) {
    return undefined
  }

  const importMap = extractImportMapSync(packageJsonPath)
  if (Object.keys(importMap).length === 0) {
    return undefined
  }

  return (
    resolveImportMapSpecifier({
      specifier,
      importMap,
      packageJsonDir: path.dirname(packageJsonPath),
    }) ?? undefined
  )
}

/**
 * Regex to match import/export statements with string specifiers.
 * Captures: full match, quote char, specifier
 */
const IMPORT_REGEX = /(?:import|export)\s+(?:.*?\s+from\s+)?(['"])([^'"]+)\1/g

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
  const packageJsonPathOption = yield* findPackageJsonWithImports(sourcePath)
  if (Option.isNone(packageJsonPathOption) === true) {
    return sourceCode
  }
  const packageJsonPath = packageJsonPathOption.value

  const importMap = yield* extractImportMap(packageJsonPath)
  if (Object.keys(importMap).length === 0) {
    return sourceCode
  }

  const packageJsonDir = path.dirname(packageJsonPath)
  const sourceDir = path.dirname(sourcePath)
  const normalizeSpecifier = (filePath: string) =>
    resolveRelativeImports ? pathToFileURL(filePath).href : filePath

  return sourceCode.replace(IMPORT_REGEX, (match, quote, specifier) => {
    if (isImportMapSpecifier(specifier) === false) {
      if (resolveRelativeImports && (specifier.startsWith('./') === true || specifier.startsWith('../') === true)) {
        const resolvedRelative = path.resolve(sourceDir, specifier)
        return match.replace(specifier, normalizeSpecifier(resolvedRelative))
      }
      return match
    }

    const resolved = resolveImportMapSpecifier({
      specifier,
      importMap,
      packageJsonDir,
    })

    if (!resolved) {
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
