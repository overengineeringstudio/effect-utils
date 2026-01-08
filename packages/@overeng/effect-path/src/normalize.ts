/**
 * Path normalization operations.
 *
 * Provides three levels of normalization:
 * 1. Lexical - Pure string manipulation (no IO)
 * 2. Absolute - Make path absolute without symlink resolution
 * 3. Canonical - Full resolution including symlinks (requires FileSystem)
 */

import { FileSystem, Path as PlatformPath } from '@effect/platform'
import { Effect } from 'effect'

import type { AbsolutePath, Path, RelativePath } from './brands.ts'
import { PathNotFoundError, SymlinkLoopError } from './errors.ts'
import { ensureTrailingSlash, hasTrailingSlash } from './internal/utils.ts'

// ═══════════════════════════════════════════════════════════════════════════
// Lexical Normalization (Pure, No IO)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalize a path lexically without filesystem access.
 *
 * This resolves `.` and `..` segments and normalizes separators,
 * but does NOT follow symlinks.
 *
 * WARNING: For paths containing symlinks, lexical normalization may
 * produce different results than filesystem-aware canonicalization.
 * For example, `a/b/../c` and `a/c` are different if `b` is a symlink.
 */
export const lexical = <P extends Path>(path: P): Effect.Effect<P, never, PlatformPath.Path> =>
  Effect.gen(function* () {
    const platformPath = yield* PlatformPath.Path
    const normalized = platformPath.normalize(path)

    // Preserve trailing slash for directories
    if (hasTrailingSlash(path)) {
      return ensureTrailingSlash(normalized) as P
    }
    return normalized as P
  })

/**
 * Lexical normalization without platform dependency.
 * Uses simple forward slash normalization.
 */
export const lexicalPure = <P extends Path>(path: P): P => {
  const hadTrailingSlash = hasTrailingSlash(path)

  // Normalize to forward slashes
  let normalized = path.replace(/\\/g, '/')

  // Remove duplicate slashes (except for leading // which could be UNC)
  if (normalized.startsWith('//')) {
    normalized = '/' + normalized.slice(2).replace(/\/+/g, '/')
  } else {
    normalized = normalized.replace(/\/+/g, '/')
  }

  // Resolve . and ..
  const parts = normalized.split('/')
  const result: string[] = []
  const isAbsolute = normalized.startsWith('/')

  for (const part of parts) {
    if (part === '' || part === '.') {
      continue
    }
    if (part === '..') {
      if (result.length > 0 && result.at(-1) !== '..') {
        result.pop()
      } else if (!isAbsolute) {
        result.push('..')
      }
      continue
    }
    result.push(part)
  }

  let finalPath = result.join('/')
  if (isAbsolute) {
    finalPath = '/' + finalPath
  }
  if (finalPath === '') {
    finalPath = isAbsolute ? '/' : '.'
  }

  if (hadTrailingSlash && !finalPath.endsWith('/')) {
    finalPath = finalPath + '/'
  }

  return finalPath as P
}

// ═══════════════════════════════════════════════════════════════════════════
// Absolute Conversion (No Symlink Resolution)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert a relative path to absolute without resolving symlinks.
 *
 * This prepends the current working directory but does NOT access
 * the filesystem or follow symlinks. Safe for paths that don't exist.
 */
export const absolute = (
  path: RelativePath,
): Effect.Effect<AbsolutePath, never, PlatformPath.Path> =>
  Effect.gen(function* () {
    const platformPath = yield* PlatformPath.Path
    const resolved = platformPath.resolve(path)

    // Preserve trailing slash
    if (hasTrailingSlash(path)) {
      return ensureTrailingSlash(resolved) as AbsolutePath
    }
    return resolved as AbsolutePath
  })

/**
 * Convert any path to absolute.
 * If already absolute, just normalizes it.
 */
export const toAbsolute = (path: Path): Effect.Effect<AbsolutePath, never, PlatformPath.Path> =>
  Effect.gen(function* () {
    const platformPath = yield* PlatformPath.Path

    if (platformPath.isAbsolute(path)) {
      // Already absolute, just normalize
      const normalized = platformPath.normalize(path)
      if (hasTrailingSlash(path)) {
        return ensureTrailingSlash(normalized) as AbsolutePath
      }
      return normalized as AbsolutePath
    }

    return yield* absolute(path as RelativePath)
  })

// ═══════════════════════════════════════════════════════════════════════════
// Canonical Resolution (With Symlink Resolution)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve a path to its canonical form.
 *
 * This resolves the path to an absolute path and follows all symlinks
 * to get the final "real" path. Requires the path to exist.
 *
 * Uses the filesystem's realpath operation which:
 * - Makes the path absolute
 * - Resolves all symlinks
 * - Normalizes . and .. segments
 */
export const canonical = (
  path: Path,
): Effect.Effect<
  AbsolutePath,
  PathNotFoundError | SymlinkLoopError,
  FileSystem.FileSystem | PlatformPath.Path
> =>
  Effect.gen(function* () {
    const platformPath = yield* PlatformPath.Path
    const fs = yield* FileSystem.FileSystem

    // First make it absolute
    const absolutePath = platformPath.isAbsolute(path) ? path : platformPath.resolve(path)

    // Use realpath to resolve symlinks
    const realPath = yield* fs.realPath(absolutePath).pipe(
      Effect.mapError((error) => {
        // Map platform errors to our error types
        if (error._tag === 'SystemError' && error.reason === 'NotFound') {
          return new PathNotFoundError({
            path: absolutePath,
            message: `Path not found: ${absolutePath}`,
            nearestExisting: undefined,
            expectedType: 'any',
          })
        }
        // For other errors (like ELOOP), treat as symlink loop
        return new SymlinkLoopError({
          path: absolutePath,
          message: `Symlink loop or error resolving path: ${absolutePath}`,
          chain: [absolutePath],
          loopingLink: absolutePath,
        })
      }),
    )

    // Preserve trailing slash for directories
    if (hasTrailingSlash(path)) {
      return ensureTrailingSlash(realPath) as AbsolutePath
    }
    return realPath as AbsolutePath
  })

/**
 * Attempt canonical resolution, falling back to lexical normalization if path doesn't exist.
 *
 * This is useful when you want to normalize a path but it might not exist yet.
 */
export const canonicalOrLexical = (
  path: Path,
): Effect.Effect<AbsolutePath, never, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const platformPath = yield* PlatformPath.Path

    // First make it absolute
    const absolutePath = platformPath.isAbsolute(path)
      ? (path as AbsolutePath)
      : (platformPath.resolve(path) as AbsolutePath)

    // Try canonical first
    const result = yield* canonical(path).pipe(
      Effect.orElse(() =>
        // Fall back to lexical normalization
        lexical(absolutePath),
      ),
    )

    return result as AbsolutePath
  })
