/**
 * Type-safe path operations.
 *
 * Provides operations that preserve path type information through the type system.
 * Uses @effect/platform's Path service for cross-platform compatibility.
 */

import { Path as PlatformPath } from '@effect/platform'
import { Effect } from 'effect'

import type {
  AbsoluteDirPath,
  AbsoluteFilePath,
  AbsolutePath,
  DirPath,
  FilePath,
  Path,
  RelativeDirPath,
  RelativeFilePath,
  RelativePath,
} from './brands.ts'
import {
  ensureTrailingSlash,
  extractBaseName,
  extractExtension,
  extractFullExtension,
  getFilename,
  hasTrailingSlash,
  removeTrailingSlash,
  toSegments,
} from './internal/utils.ts'

// ═══════════════════════════════════════════════════════════════════════════
// Join Operations
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Join a directory path with relative path segments.
 *
 * The return type is determined by:
 * - Base type (Abs/Rel) is preserved from the first argument
 * - Target type (File/Dir) is determined by the last segment
 *
 * NOTE: This uses rest parameters which may require lint exception.
 *
 * @example
 * ```ts
 * // AbsoluteDirPath + RelativeFilePath = AbsoluteFilePath
 * join(absDir, relFile)
 *
 * // RelativeDirPath + RelativeDirPath = RelativeDirPath
 * join(relDir, relDir2)
 * ```
 */
export function join(
  base: AbsoluteDirPath,
  // biome-ignore lint/style/useRestParameters: Variadic design decision - preserves type safety across segments
  ...segments: RelativeFilePath[]
): AbsoluteFilePath
export function join(
  base: AbsoluteDirPath,
  // biome-ignore lint/style/useRestParameters: Variadic design decision
  ...segments: RelativeDirPath[]
): AbsoluteDirPath
export function join(
  base: AbsoluteDirPath,
  // biome-ignore lint/style/useRestParameters: Variadic design decision
  ...segments: RelativePath[]
): AbsolutePath
export function join(
  base: RelativeDirPath,
  // biome-ignore lint/style/useRestParameters: Variadic design decision
  ...segments: RelativeFilePath[]
): RelativeFilePath
export function join(
  base: RelativeDirPath,
  // biome-ignore lint/style/useRestParameters: Variadic design decision
  ...segments: RelativeDirPath[]
): RelativeDirPath
export function join(
  base: RelativeDirPath,
  // biome-ignore lint/style/useRestParameters: Variadic design decision
  ...segments: RelativePath[]
): RelativePath
export function join(
  base: DirPath,
  // biome-ignore lint/style/useRestParameters: Variadic design decision
  ...segments: RelativePath[]
): Path {
  if (segments.length === 0) {
    return base
  }

  // Simple join using forward slashes (cross-platform safe for most cases)
  const joined = [removeTrailingSlash(base), ...segments.map(removeTrailingSlash)].join('/')

  // Preserve trailing slash from last segment
  const lastSegment = segments.at(-1)!
  if (hasTrailingSlash(lastSegment)) {
    return ensureTrailingSlash(joined) as Path
  }

  return joined as Path
}

/**
 * Join paths using platform-specific separator.
 * Returns an Effect that requires the Path service.
 */
export const joinPlatform = (
  base: DirPath,
  // biome-ignore lint/style/useRestParameters: Variadic design decision
  ...segments: RelativePath[]
): Effect.Effect<Path, never, PlatformPath.Path> =>
  Effect.gen(function* () {
    if (segments.length === 0) {
      return base
    }

    const platformPath = yield* PlatformPath.Path
    const allParts = [removeTrailingSlash(base), ...segments.map(removeTrailingSlash)]
    const joined = platformPath.join(...allParts)

    // Preserve trailing slash from last segment
    const lastSegment = segments.at(-1)!
    if (hasTrailingSlash(lastSegment)) {
      return ensureTrailingSlash(joined) as Path
    }

    return joined as Path
  })

// ═══════════════════════════════════════════════════════════════════════════
// Resolution Operations
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve paths to an absolute path.
 * Uses platform-specific path resolution.
 */
export const resolve = (
  // biome-ignore lint/style/useRestParameters: Variadic design decision
  ...paths: Path[]
): Effect.Effect<AbsolutePath, never, PlatformPath.Path> =>
  Effect.gen(function* () {
    const platformPath = yield* PlatformPath.Path
    const resolved = platformPath.resolve(...paths)
    return resolved as AbsolutePath
  })

/**
 * Get the relative path from one absolute path to another.
 */
export const relative = (
  from: AbsoluteDirPath,
  to: AbsolutePath,
): Effect.Effect<RelativePath, never, PlatformPath.Path> =>
  Effect.gen(function* () {
    const platformPath = yield* PlatformPath.Path
    const rel = platformPath.relative(removeTrailingSlash(from), to)
    return rel as RelativePath
  })

// ═══════════════════════════════════════════════════════════════════════════
// Parent/Child Navigation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the parent directory of a path.
 *
 * For files: always returns the containing directory
 * For directories: returns parent directory, or undefined for root
 */
export function parent(path: AbsoluteFilePath): AbsoluteDirPath
export function parent(path: RelativeFilePath): RelativeDirPath
export function parent(path: AbsoluteDirPath): AbsoluteDirPath | undefined
export function parent(path: RelativeDirPath): RelativeDirPath | undefined
export function parent(path: Path): DirPath | undefined {
  const isFile = !hasTrailingSlash(path)
  const normalized = removeTrailingSlash(path)

  // Find last separator
  const lastSep = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))

  if (lastSep === -1) {
    // No separator - this is a root-level item
    return isFile ? ('./' as DirPath) : undefined
  }

  if (lastSep === 0) {
    // Root directory
    return isFile ? ('/' as AbsoluteDirPath) : undefined
  }

  const parentPath = normalized.slice(0, lastSep)
  return ensureTrailingSlash(parentPath) as DirPath
}

/**
 * Get parent directory using platform-specific logic.
 */
export const parentPlatform = (
  path: Path,
): Effect.Effect<DirPath | undefined, never, PlatformPath.Path> =>
  Effect.gen(function* () {
    const platformPath = yield* PlatformPath.Path
    const isFile = !hasTrailingSlash(path)
    const dirname = platformPath.dirname(removeTrailingSlash(path))

    // Check if we're at root
    if (dirname === path || dirname === removeTrailingSlash(path)) {
      return isFile ? (ensureTrailingSlash(dirname) as DirPath) : undefined
    }

    return ensureTrailingSlash(dirname) as DirPath
  })

// ═══════════════════════════════════════════════════════════════════════════
// Path Component Extraction
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the file name from a file path.
 */
export const fileName = (path: FilePath): string => getFilename(path)

/**
 * Get the base name (without extension) from a path.
 */
export const baseName = (path: Path): string => {
  const name = getFilename(removeTrailingSlash(path))
  return extractBaseName(name)
}

/**
 * Get the single extension from a file path (without leading dot).
 */
export const extension = (path: FilePath): string | undefined => {
  const name = getFilename(path)
  return extractExtension(name)
}

/**
 * Get the full compound extension from a file path (without leading dot).
 */
export const fullExtension = (path: FilePath): string | undefined => {
  const name = getFilename(path)
  return extractFullExtension(name)
}

/**
 * Get all path segments.
 */
export const segments = (path: Path): ReadonlyArray<string> => toSegments(path)

// ═══════════════════════════════════════════════════════════════════════════
// Path Modification
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Change the extension of a file path.
 * Pass empty string to remove extension.
 */
export const withExtension = <P extends FilePath>(path: P, ext: string): P => {
  const name = getFilename(path)
  const base = extractBaseName(name)
  const dir = path.slice(0, -name.length)

  const newName = ext === '' ? base : `${base}.${ext.replace(/^\./, '')}`
  return `${dir}${newName}` as P
}

/**
 * Change the base name of a path (preserving extension for files).
 */
export const withBaseName = <P extends Path>(path: P, name: string): P => {
  const isDir = hasTrailingSlash(path)
  const oldName = getFilename(removeTrailingSlash(path))
  const ext = isDir ? undefined : extractFullExtension(oldName)
  const dir = path.slice(0, -(oldName.length + (isDir ? 1 : 0)))

  if (isDir) {
    return ensureTrailingSlash(`${dir}${name}`) as P
  }

  const newName = ext === undefined ? name : `${name}.${ext}`
  return `${dir}${newName}` as P
}

/**
 * Add a suffix to the base name of a file (before extension).
 */
export const addSuffix = <P extends FilePath>(path: P, suffix: string): P => {
  const name = getFilename(path)
  const base = extractBaseName(name)
  const fullExt = extractFullExtension(name)
  const dir = path.slice(0, -name.length)

  const newName = fullExt === undefined ? `${base}${suffix}` : `${base}${suffix}.${fullExt}`
  return `${dir}${newName}` as P
}

// ═══════════════════════════════════════════════════════════════════════════
// Path Comparison
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a path starts with another path.
 */
export const startsWith = (path: Path, prefix: DirPath): boolean => {
  const normalizedPath = path.replace(/\\/g, '/')
  const normalizedPrefix = removeTrailingSlash(prefix).replace(/\\/g, '/')
  return (
    normalizedPath.startsWith(normalizedPrefix) &&
    (normalizedPath.length === normalizedPrefix.length ||
      normalizedPath[normalizedPrefix.length] === '/')
  )
}

/**
 * Check if a path ends with a given suffix.
 */
export const endsWith = (path: Path, suffix: string): boolean => {
  const normalizedPath = removeTrailingSlash(path).replace(/\\/g, '/')
  const normalizedSuffix = suffix.replace(/\\/g, '/')
  return normalizedPath.endsWith(normalizedSuffix)
}

/**
 * Strip a prefix directory from a path.
 * Returns undefined if path doesn't start with prefix.
 */
export const stripPrefix = (path: Path, prefix: DirPath): RelativePath | undefined => {
  if (!startsWith(path, prefix)) {
    return undefined
  }

  const normalizedPath = path.replace(/\\/g, '/')
  const normalizedPrefix = removeTrailingSlash(prefix).replace(/\\/g, '/')

  const relative = normalizedPath.slice(normalizedPrefix.length)
  // Remove leading slash if present
  const result = relative.startsWith('/') ? relative.slice(1) : relative

  return (result || './') as RelativePath
}
