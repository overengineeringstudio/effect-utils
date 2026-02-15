/**
 * Symlink operations for path handling.
 *
 * Provides utilities for detecting, reading, and resolving symbolic links.
 */

import { FileSystem, Path as PlatformPath, type Error as PlatformError } from '@effect/platform'
import { Effect, Either } from 'effect'

import type { AbsolutePath, Path } from './brands.ts'
import { NotASymlinkError, PathNotFoundError, PermissionError, SymlinkLoopError } from './errors.ts'
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
const mapFsError = (args: {
  readonly path: string
  readonly error: PlatformError.PlatformError
}): PathNotFoundError | PermissionError => {
  const { path, error } = args
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
export const isSymlink = Effect.fnUntraced(function* (path: AbsolutePath) {
  const fs = yield* FileSystem.FileSystem

  const handleReadLinkError = (
    error: PlatformError.PlatformError,
  ): Effect.Effect<boolean, PathNotFoundError | PermissionError, never> => {
    if (error._tag === 'SystemError') {
      if (error.reason === 'NotFound') {
        return Effect.fail(
          new PathNotFoundError({
            path,
            message: `Path not found: ${path}`,
            nearestExisting: undefined,
            expectedType: 'any',
          }),
        )
      }
      if (error.reason === 'PermissionDenied') {
        return Effect.fail(
          new PermissionError({
            path,
            message: `Permission denied: ${path}`,
            operation: 'stat',
          }),
        )
      }
    }

    // Likely not a symlink (EINVAL), treat as false.
    return Effect.succeed(false)
  }

  return yield* fs.readLink(path).pipe(Effect.as(true), Effect.catchAll(handleReadLinkError))
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
export const readLink = Effect.fnUntraced(function* (path: AbsolutePath) {
  const fs = yield* FileSystem.FileSystem

  const targetResult = yield* fs.readLink(path).pipe(Effect.either)
  if (Either.isRight(targetResult) === true) {
    return targetResult.right as Path
  }

  const error = targetResult.left
  if (error._tag === 'SystemError') {
    if (error.reason === 'NotFound') {
      return yield* new PathNotFoundError({
        path,
        message: `Path not found: ${path}`,
        nearestExisting: undefined,
        expectedType: 'any',
      })
    }
    if (error.reason === 'PermissionDenied') {
      return yield* new PermissionError({
        path,
        message: `Permission denied: ${path}`,
        operation: 'stat',
      })
    }
  }

  const statResult = yield* fs.stat(path).pipe(
    Effect.mapError((error) => mapFsError({ path, error })),
    Effect.either,
  )
  if (Either.isLeft(statResult) === true) {
    return yield* statResult.left
  }

  return yield* new NotASymlinkError({
    path,
    message: `Path is not a symbolic link: ${path}`,
    actualType: statResult.right.type === 'Directory' ? 'directory' : 'file',
  })
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
export const resolve = Effect.fnUntraced(function* (path: AbsolutePath) {
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
  if (hadTrailingSlash === true) {
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
export const chain = Effect.fnUntraced(function* (path: AbsolutePath) {
  const fs = yield* FileSystem.FileSystem
  const platformPath = yield* PlatformPath.Path

  const visited: AbsolutePath[] = [path]
  const seen = new Set<string>([path])
  let current = path

  for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth++) {
    const targetResult = yield* fs.readLink(current).pipe(Effect.either)
    if (Either.isLeft(targetResult) === true) {
      const error = targetResult.left
      if (
        error._tag === 'SystemError' &&
        (error.reason === 'NotFound' || error.reason === 'PermissionDenied')
      ) {
        return yield* mapFsError({ path: current, error })
      }

      // Likely not a symlink (EINVAL), we're done.
      return visited
    }

    const target = targetResult.right

    // Resolve to absolute if relative
    const absoluteTarget =
      platformPath.isAbsolute(target) === true
        ? target
        : platformPath.resolve(platformPath.dirname(current), target)

    // Check for loop
    if (seen.has(absoluteTarget) === true) {
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
