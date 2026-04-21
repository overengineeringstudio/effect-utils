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
    if (parsed.imports !== undefined && Object.keys(parsed.imports).length > 0) {
      return parsed.imports
    }
  } catch {
    // Ignore JSON parse errors and return empty map
  }

  return {}
}

const parseImportMapFromGenieSource = (sourceContent: string): ImportMap => {
  const importsMatch = sourceContent.match(/imports:\s*\{([^}]+)\}/)
  if (importsMatch === null) {
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
 * Synchronous version of findPackageJsonWithImports for Bun resolver hooks.
 */
export const findPackageJsonWithImportsSync = (fromPath: string): string | undefined => {
  let dir = path.dirname(fromPath)
  const root = path.parse(dir).root

  while (dir !== root) {
    const packageJsonPath = path.join(dir, 'package.json')

    if (fs.existsSync(packageJsonPath) === true) {
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
    if (fs.existsSync(genieSourcePath) === true) {
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
 * Synchronous import map extraction for resolver hooks.
 */
export const extractImportMapSync = (packageJsonPath: string): ImportMap => {
  if (fs.existsSync(packageJsonPath) === true) {
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
  if (fs.existsSync(genieSourcePath) === true) {
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

const MEGAREPO_MEMBER_PREFIX = '#mr/'
const GENIE_MEMBER_OVERRIDE_MAP_ENV = 'GENIE_MEMBER_OVERRIDE_MAP'
const GENIE_MEMBER_SOURCE_MAP_ENV = 'GENIE_MEMBER_SOURCE_MAP'

type MemberSourceMap = Record<string, string>

type MegarepoLockMember = {
  readonly url: string
  readonly ref: string
}

type MegarepoLock = {
  readonly members?: Record<string, MegarepoLockMember>
}

const parseMemberSourceMap = (value: string | undefined): MemberSourceMap => {
  if (value === undefined || value === '') return {}

  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed === null || typeof parsed !== 'object') return {}

    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([key, sourcePath]) =>
          key.length > 0 && typeof sourcePath === 'string' && sourcePath.length > 0,
      ),
    )
  } catch {
    return {}
  }
}

const parseMegarepoLockContent = (content: string): MegarepoLock => {
  try {
    return JSON.parse(content) as MegarepoLock
  } catch {
    return {}
  }
}

const classifyMegarepoRef = (ref: string): 'commit' | 'tag' | 'branch' => {
  if (/^[a-f0-9]{40}$/.test(ref) === true) return 'commit'
  if (/^v?\d+(?:\.\d+)*(?:[-+].+)?$/.test(ref) === true) return 'tag'
  return 'branch'
}

const refTypeToPathSegment = (refType: 'commit' | 'tag' | 'branch'): string => {
  switch (refType) {
    case 'commit':
      return 'commits'
    case 'tag':
      return 'tags'
    case 'branch':
      return 'heads'
  }
}

const parseMemberSpecifier = (
  specifier: string,
): { memberName: string; subPath: string } | undefined => {
  if (specifier.startsWith(MEGAREPO_MEMBER_PREFIX) === false) {
    return undefined
  }

  const remainder = specifier.slice(MEGAREPO_MEMBER_PREFIX.length)
  if (remainder.length === 0) return undefined

  const [memberName, ...rest] = remainder.split('/')
  if (memberName === undefined || memberName.length === 0) {
    return undefined
  }

  return {
    memberName,
    subPath: rest.join('/'),
  }
}

const joinMemberSubPath = ({
  memberRoot,
  subPath,
}: {
  memberRoot: string
  subPath: string
}): string => (subPath.length === 0 ? memberRoot : path.join(memberRoot, subPath))

const getMegarepoStoreBasePath = (): string =>
  process.env.MEGAREPO_STORE ?? path.join(process.env.HOME ?? '~', '.megarepo')

const deriveStoreWorktreePathFromLockMember = ({
  member,
}: {
  member: MegarepoLockMember
}): string | undefined => {
  const url = member.url.replace(/^https?:\/\//, '')
  const [host, owner, repo] = url.split('/')
  if (
    host === undefined ||
    host.length === 0 ||
    owner === undefined ||
    owner.length === 0 ||
    repo === undefined ||
    repo.length === 0
  ) {
    return undefined
  }

  const refType = classifyMegarepoRef(member.ref)
  return path.join(
    getMegarepoStoreBasePath(),
    host,
    owner,
    repo,
    'refs',
    refTypeToPathSegment(refType),
    member.ref,
  )
}

const findRepoRootSync = (fromPath: string): string | undefined => {
  let current = path.dirname(fromPath)
  let previous = ''

  while (current !== previous) {
    if (
      fs.existsSync(path.join(current, 'megarepo.lock')) === true ||
      fs.existsSync(path.join(current, 'megarepo.kdl')) === true ||
      fs.existsSync(path.join(current, 'megarepo.json')) === true ||
      fs.existsSync(path.join(current, '.git')) === true
    ) {
      return current
    }

    previous = current
    current = path.dirname(current)
  }

  return undefined
}

const resolveLocalMegarepoMemberRootSync = ({
  memberName,
  importerPath,
}: {
  memberName: string
  importerPath: string
}): string | undefined => {
  const repoRoot = findRepoRootSync(importerPath)
  if (repoRoot === undefined) return undefined

  const lockPath = path.join(repoRoot, 'megarepo.lock')
  if (fs.existsSync(lockPath) === true) {
    try {
      const lockContent = fs.readFileSync(lockPath, 'utf8')
      const lock = parseMegarepoLockContent(lockContent)
      const lockMember = lock.members?.[memberName]
      if (lockMember !== undefined) {
        const derivedPath = deriveStoreWorktreePathFromLockMember({ member: lockMember })
        if (derivedPath !== undefined && fs.existsSync(derivedPath) === true) {
          return derivedPath
        }
      }
    } catch {
      // Ignore lock parse/read errors and continue to local symlink fallback.
    }
  }

  const memberPath = path.join(repoRoot, 'repos', memberName)
  if (fs.existsSync(memberPath) === true) {
    try {
      return fs.realpathSync(memberPath)
    } catch {
      return memberPath
    }
  }

  return undefined
}

const resolveMegarepoMemberSpecifierSync = ({
  specifier,
  importerPath,
}: {
  specifier: string
  importerPath: string
}): string | undefined => {
  const parsed = parseMemberSpecifier(specifier)
  if (parsed === undefined) {
    return undefined
  }

  const overrideMap = parseMemberSourceMap(process.env[GENIE_MEMBER_OVERRIDE_MAP_ENV])
  const overrideRoot = overrideMap[parsed.memberName]
  if (overrideRoot !== undefined) {
    return joinMemberSubPath({ memberRoot: overrideRoot, subPath: parsed.subPath })
  }

  const localRoot = resolveLocalMegarepoMemberRootSync({
    memberName: parsed.memberName,
    importerPath,
  })
  if (localRoot !== undefined) {
    return joinMemberSubPath({ memberRoot: localRoot, subPath: parsed.subPath })
  }

  const sourceMap = parseMemberSourceMap(process.env[GENIE_MEMBER_SOURCE_MAP_ENV])
  const sourceRoot = sourceMap[parsed.memberName]
  if (sourceRoot !== undefined) {
    return joinMemberSubPath({ memberRoot: sourceRoot, subPath: parsed.subPath })
  }

  return undefined
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

  const resolvedMegarepoMember = resolveMegarepoMemberSpecifierSync({
    specifier,
    importerPath,
  })
  if (resolvedMegarepoMember !== undefined) {
    return resolvedMegarepoMember
  }

  const packageJsonPath = findPackageJsonWithImportsSync(importerPath)
  if (packageJsonPath === undefined) {
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
