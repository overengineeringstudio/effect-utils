/**
 * Symlink operations for path handling.
 *
 * Provides utilities for detecting, reading, and resolving symbolic links.
 */

import { FileSystem, Path as PlatformPath, Error as PlatformError } from '@effect/platform'
import { Effect } from 'effect'

import type { AbsolutePath, Path } from './brands.ts'
import {
  NotASymlinkError,
  PathNotFoundError,
  PermissionError,
  SymlinkLoopError,
  type SymlinkError,
} from './errors.ts'
import { ensureTrailingSlash, hasTrailingSlash } from './internal/utils.ts'

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Maximum symlink chain depth to prevent infinite loops */
const MAX_SYMLINK_DEPTH = 40

// ═══════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Map filesystem errors to our error types */
const mapFsError = (
  path: string,
  error: PlatformError.PlatformError,
): PathNotFoundError | PermissionError => {
  if (error._tag === 'SystemError') {
    if (error.reason === 'NotFound') {
      return new PathNotFoundError({
        path,
        message: `Path not found: ${path}`,
        nearestExisting: undefined,
        expectedType: 'any',
      })
    }
    if (error.reason === 'PermissionDenied') {
      return new PermissionError({
        path,
        message: `Permission denied: ${path}`,
        operation: 'stat',
      })
    }
  }
  return new PathNotFoundError({
    path,
    message: `Cannot access path: ${path}`,
    nearestExisting: undefined,
    expectedType: 'any',
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// Symlink Detection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a path is a symbolic link.
 *
 * Returns false if the path doesn't exist.
 */
export const isSymlink = (
  path: AbsolutePath,
): Effect.Effect<boolean, PathNotFoundError | PermissionError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Use lstat to not follow symlinks
    const stat = yield* fs.stat(path).pipe(Effect.mapError((e) => mapFsError(path, e)))

    return stat.type === 'SymbolicLink'
  })

/**
 * Check if a path is a symbolic link, returning false if it doesn't exist.
 */
export const isSymlinkSafe = (
  path: AbsolutePath,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  isSymlink(path).pipe(Effect.orElse(() => Effect.succeed(false)))

// ═══════════════════════════════════════════════════════════════════════════
// Symlink Reading
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Read the immediate target of a symbolic link.
 *
 * Does NOT follow symlink chains - returns the direct target.
 */
export const readLink = (
  path: AbsolutePath,
): Effect.Effect<
  Path,
  PathNotFoundError | NotASymlinkError | PermissionError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // First check if it's a symlink
    const stat = yield* fs.stat(path).pipe(Effect.mapError((e) => mapFsError(path, e)))

    if (stat.type !== 'SymbolicLink') {
      return yield* new NotASymlinkError({
        path,
        message: `Path is not a symbolic link: ${path}`,
        actualType: stat.type === 'Directory' ? 'directory' : 'file',
      })
    }

    // Read the symlink target
    const target = yield* fs.readLink(path).pipe(Effect.mapError((e) => mapFsError(path, e)))

    return target as Path
  })

// ═══════════════════════════════════════════════════════════════════════════
// Symlink Resolution
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve all symlinks to get the final target path.
 *
 * Follows the entire symlink chain until reaching a non-symlink path.
 * Detects and reports symlink loops.
 */
export const resolve = (
  path: AbsolutePath,
): Effect.Effect<AbsolutePath, SymlinkError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const hadTrailingSlash = hasTrailingSlash(path)

    // Use realPath for efficient symlink resolution
    const realPath = yield* fs.realPath(path).pipe(
      Effect.mapError((error) => {
        if (error._tag === 'SystemError') {
          if (error.reason === 'NotFound') {
            return new PathNotFoundError({
              path,
              message: `Path not found: ${path}`,
              nearestExisting: undefined,
              expectedType: 'any',
            })
          }
          if (error.reason === 'PermissionDenied') {
            return new PermissionError({
              path,
              message: `Permission denied: ${path}`,
              operation: 'stat',
            })
          }
        }
        // ELOOP or other errors
        return new SymlinkLoopError({
          path,
          message: `Symlink loop detected: ${path}`,
          chain: [path],
          loopingLink: path,
        })
      }),
    )

    // Preserve trailing slash
    if (hadTrailingSlash) {
      return ensureTrailingSlash(realPath) as AbsolutePath
    }
    return realPath as AbsolutePath
  })

/**
 * Get the full symlink chain from a path to its final target.
 *
 * Returns an array of all paths visited, starting from the input
 * and ending with the final non-symlink target.
 */
export const chain = (
  path: AbsolutePath,
): Effect.Effect<
  ReadonlyArray<AbsolutePath>,
  SymlinkError,
  FileSystem.FileSystem | PlatformPath.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const platformPath = yield* PlatformPath.Path

    const visited: AbsolutePath[] = [path]
    const seen = new Set<string>([path])
    let current = path

    for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth++) {
      // Check if current is a symlink
      const stat = yield* fs.stat(current).pipe(Effect.mapError((e) => mapFsError(current, e)))

      if (stat.type !== 'SymbolicLink') {
        // Reached a non-symlink, we're done
        return visited
      }

      // Read symlink target
      const target = yield* fs
        .readLink(current)
        .pipe(Effect.mapError((e) => mapFsError(current, e)))

      // Resolve to absolute if relative
      const absoluteTarget = platformPath.isAbsolute(target)
        ? target
        : platformPath.resolve(platformPath.dirname(current), target)

      // Check for loop
      if (seen.has(absoluteTarget)) {
        return yield* new SymlinkLoopError({
          path,
          message: `Symlink loop detected: ${current} -> ${absoluteTarget}`,
          chain: [...visited],
          loopingLink: current,
        })
      }

      seen.add(absoluteTarget)
      visited.push(absoluteTarget as AbsolutePath)
      current = absoluteTarget as AbsolutePath
    }

    // Exceeded max depth
    return yield* new SymlinkLoopError({
      path,
      message: `Symlink chain exceeded maximum depth of ${MAX_SYMLINK_DEPTH}`,
      chain: [...visited],
      loopingLink: current,
    })
  })

/**
 * Resolve symlinks, but return original path if not a symlink or doesn't exist.
 *
 * This is a safe version that never fails - useful for normalization.
 */
export const resolveSafe = (
  path: AbsolutePath,
): Effect.Effect<AbsolutePath, never, FileSystem.FileSystem> =>
  resolve(path).pipe(Effect.orElse(() => Effect.succeed(path)))
