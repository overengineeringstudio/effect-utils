/**
 * Sandbox API for traversal-resistant path operations.
 *
 * Inspired by Go 1.24's os.Root API, this provides a secure way to
 * work with paths that prevents directory traversal attacks.
 *
 * All operations within a sandbox are guaranteed to stay within the root directory.
 */

import { FileSystem, type Path as PlatformPath } from '@effect/platform'
import { Effect, Either } from 'effect'

import type { AbsoluteDirPath, AbsolutePath, RelativePath } from './brands.ts'
import { PathNotFoundError, PermissionError, TraversalError, type SandboxError } from './errors.ts'
import {
  ensureTrailingSlash,
  hasTrailingSlash,
  removeTrailingSlash,
  toSegments,
} from './internal/utils.ts'
import { lexicalPure } from './normalize.ts'

// ═══════════════════════════════════════════════════════════════════════════
// Sandbox Interface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A sandboxed path context that prevents directory traversal attacks.
 *
 * All operations within the sandbox are guaranteed to stay within the root directory.
 * Symlinks are followed only if their target remains within the sandbox.
 */
export interface Sandbox {
  /** The root directory of this sandbox */
  readonly root: AbsoluteDirPath

  /**
   * Validate that a relative path stays within the sandbox.
   * This is a pure lexical check - does not access the filesystem.
   *
   * @returns The normalized relative path, or TraversalError if it escapes
   */
  validate(path: RelativePath): Either.Either<RelativePath, TraversalError>

  /**
   * Resolve a relative path to an absolute path within the sandbox.
   * This is a pure lexical operation - does not access the filesystem.
   *
   * @returns The absolute path, or TraversalError if it escapes
   */
  resolve(path: RelativePath): Either.Either<AbsolutePath, TraversalError>

  /**
   * Check if an absolute path is contained within this sandbox.
   * This is a pure lexical check.
   */
  contains(path: AbsolutePath): boolean

  /**
   * Read a file within the sandbox.
   * Follows symlinks only if they stay within the sandbox.
   */
  readFile(
    path: RelativePath,
  ): Effect.Effect<Uint8Array, SandboxError, FileSystem.FileSystem | PlatformPath.Path>

  /**
   * Read a file as text within the sandbox.
   */
  readFileString(args: {
    readonly path: RelativePath
    readonly encoding?: string
  }): Effect.Effect<string, SandboxError, FileSystem.FileSystem | PlatformPath.Path>

  /**
   * Check if a path exists within the sandbox.
   */
  exists(
    path: RelativePath,
  ): Effect.Effect<boolean, TraversalError, FileSystem.FileSystem | PlatformPath.Path>

  /**
   * List directory contents within the sandbox.
   */
  readDirectory(
    path: RelativePath,
  ): Effect.Effect<ReadonlyArray<string>, SandboxError, FileSystem.FileSystem | PlatformPath.Path>

  /**
   * Get file/directory info within the sandbox.
   */
  stat(
    path: RelativePath,
  ): Effect.Effect<FileSystem.File.Info, SandboxError, FileSystem.FileSystem | PlatformPath.Path>
}

// ═══════════════════════════════════════════════════════════════════════════
// Sandbox Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a sandbox rooted at the given directory.
 *
 * The sandbox provides traversal-resistant operations that ensure
 * all file access stays within the root directory.
 */
export const sandbox = (root: AbsoluteDirPath): Sandbox => {
  const normalizedRoot = removeTrailingSlash(lexicalPure(root))

  /**
   * Validate that a path doesn't escape the sandbox.
   * Returns the normalized relative path.
   */
  const validate = (path: RelativePath): Either.Either<RelativePath, TraversalError> => {
    // Normalize the path first
    const normalized = lexicalPure(path)

    // Reject absolute paths (POSIX semantics)
    if (normalized.startsWith('/') === true) {
      return Either.left(
        new TraversalError({
          path,
          message: `Expected relative path (must not start with '/'): ${path}`,
          sandboxRoot: root,
          escapedTo: normalized,
          escapingSegments: [],
        }),
      )
    }

    const segments = toSegments(normalized)

    // Track depth - if we go negative, we've escaped
    let depth = 0
    const escapingSegments: string[] = []

    for (const segment of segments) {
      if (segment === '..') {
        if (depth === 0) {
          escapingSegments.push(segment)
        } else {
          depth--
        }
      } else if (segment !== '.') {
        depth++
      }
    }

    if (escapingSegments.length > 0) {
      return Either.left(
        new TraversalError({
          path,
          message: `Path escapes sandbox root: ${path}`,
          sandboxRoot: root,
          escapedTo: undefined,
          escapingSegments,
        }),
      )
    }

    // Preserve trailing slash
    if (hasTrailingSlash(path) === true) {
      return Either.right(ensureTrailingSlash(normalized) as RelativePath)
    }
    return Either.right(normalized as RelativePath)
  }

  /**
   * Resolve a relative path to absolute within the sandbox.
   */
  const resolve = (path: RelativePath): Either.Either<AbsolutePath, TraversalError> => {
    const validatedResult = validate(path)
    if (Either.isLeft(validatedResult) === true) {
      return Either.left(validatedResult.left)
    }

    const validated = validatedResult.right
    const relativePart = removeTrailingSlash(validated)
    if (relativePart === '.') {
      return Either.right(ensureTrailingSlash(normalizedRoot) as AbsolutePath)
    }

    const normalizedRelative = relativePart.replace(/^\/+/, '')
    const absolutePath =
      normalizedRoot === '/' ? `/${normalizedRelative}` : `${normalizedRoot}/${normalizedRelative}`

    if (hasTrailingSlash(validated) === true) {
      return Either.right(ensureTrailingSlash(absolutePath) as AbsolutePath)
    }
    return Either.right(absolutePath as AbsolutePath)
  }

  /**
   * Check if an absolute path is within the sandbox.
   */
  const contains = (path: AbsolutePath): boolean => {
    const normalizedPath = removeTrailingSlash(lexicalPure(path))

    if (normalizedRoot === '/') {
      return normalizedPath.startsWith('/')
    }

    // Must start with root and be followed by separator or be exactly root
    if (normalizedPath === normalizedRoot) {
      return true
    }

    if (normalizedPath.startsWith(normalizedRoot + '/') === true) {
      return true
    }

    return false
  }

  /**
   * Validate symlink target stays within sandbox.
   */
  const validateRealPath = (args: {
    readonly originalPath: RelativePath
    readonly realPath: string
  }): Effect.Effect<AbsolutePath, TraversalError, never> => {
    const { originalPath, realPath } = args
    const normalizedReal = removeTrailingSlash(lexicalPure(realPath as AbsolutePath))

    if (contains(normalizedReal as AbsolutePath) === false) {
      return Effect.fail(
        new TraversalError({
          path: originalPath,
          message: `Symlink target escapes sandbox: ${realPath}`,
          sandboxRoot: root,
          escapedTo: realPath,
          escapingSegments: [],
        }),
      )
    }

    if (hasTrailingSlash(originalPath) === true) {
      return Effect.succeed(ensureTrailingSlash(normalizedReal) as AbsolutePath)
    }
    return Effect.succeed(normalizedReal as AbsolutePath)
  }

  /**
   * Get the real path (resolving symlinks) and validate it stays in sandbox.
   */
  const getSafeRealPath = Effect.fnUntraced(function* (path: RelativePath) {
    // First do lexical validation
    const resolveResult = resolve(path)
    if (Either.isLeft(resolveResult) === true) {
      return yield* resolveResult.left
    }
    const resolved = resolveResult.right

    const fs = yield* FileSystem.FileSystem

    // Get real path (follows symlinks)
    const realPath = yield* fs.realPath(resolved).pipe(
      Effect.mapError((error) => {
        if (error._tag === 'SystemError') {
          if (error.reason === 'NotFound') {
            return new PathNotFoundError({
              path: resolved,
              message: `Path not found: ${resolved}`,
              nearestExisting: undefined,
              expectedType: 'any',
            })
          }
          if (error.reason === 'PermissionDenied') {
            return new PermissionError({
              path: resolved,
              message: `Permission denied: ${resolved}`,
              operation: 'stat',
            })
          }
        }
        return new PathNotFoundError({
          path: resolved,
          message: `Cannot access path: ${resolved}`,
          nearestExisting: undefined,
          expectedType: 'any',
        })
      }),
    )

    // Validate the real path is still within sandbox
    return yield* validateRealPath({ originalPath: path, realPath })
  })

  return {
    root,
    validate,
    resolve,
    contains,

    readFile: Effect.fnUntraced(function* (path) {
      const safePath = yield* getSafeRealPath(path)
      const fs = yield* FileSystem.FileSystem
      return yield* fs.readFile(safePath).pipe(
        Effect.mapError(
          () =>
            new PermissionError({
              path: safePath,
              message: `Cannot read file: ${safePath}`,
              operation: 'read',
            }),
        ),
      )
    }),

    readFileString: Effect.fnUntraced(function* (args) {
      const safePath = yield* getSafeRealPath(args.path)
      const fs = yield* FileSystem.FileSystem
      return yield* fs.readFileString(safePath, args.encoding).pipe(
        Effect.mapError(
          () =>
            new PermissionError({
              path: safePath,
              message: `Cannot read file: ${safePath}`,
              operation: 'read',
            }),
        ),
      )
    }),

    exists: Effect.fnUntraced(function* (path) {
      const resolveResult = resolve(path)
      if (Either.isLeft(resolveResult) === true) {
        return yield* resolveResult.left
      }
      const resolved = resolveResult.right
      const fs = yield* FileSystem.FileSystem
      const exists = yield* fs.exists(resolved).pipe(Effect.orElse(() => Effect.succeed(false)))
      if (exists === false) {
        return false
      }

      return yield* fs.realPath(resolved).pipe(
        Effect.flatMap((realPath) =>
          validateRealPath({ originalPath: path, realPath }).pipe(Effect.as(true)),
        ),
        Effect.orElse(() => Effect.succeed(false)),
      )
    }),

    readDirectory: Effect.fnUntraced(function* (path) {
      const safePath = yield* getSafeRealPath(path)
      const fs = yield* FileSystem.FileSystem
      return yield* fs.readDirectory(safePath).pipe(
        Effect.mapError(
          () =>
            new PermissionError({
              path: safePath,
              message: `Cannot read directory: ${safePath}`,
              operation: 'read',
            }),
        ),
      )
    }),

    stat: Effect.fnUntraced(function* (path) {
      const safePath = yield* getSafeRealPath(path)
      const fs = yield* FileSystem.FileSystem
      return yield* fs.stat(safePath).pipe(
        Effect.mapError((error) => {
          if (error._tag === 'SystemError' && error.reason === 'NotFound') {
            return new PathNotFoundError({
              path: safePath,
              message: `Path not found: ${safePath}`,
              nearestExisting: undefined,
              expectedType: 'any',
            })
          }
          return new PermissionError({
            path: safePath,
            message: `Cannot stat: ${safePath}`,
            operation: 'stat',
          })
        }),
      )
    }),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Convenience Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a sandbox and immediately perform an operation.
 */
export const withSandbox = <A, E, R>(args: {
  readonly root: AbsoluteDirPath
  readonly f: (sandbox: Sandbox) => Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R> => args.f(sandbox(args.root))

/**
 * Validate that a path doesn't escape a directory.
 * Convenience function for one-off validation.
 */
export const validatePath = (args: {
  readonly root: AbsoluteDirPath
  readonly path: RelativePath
}): Either.Either<RelativePath, TraversalError> => sandbox(args.root).validate(args.path)

/**
 * Check if a path would stay within a directory.
 * Convenience function for one-off checks.
 */
export const isContained = (args: {
  readonly root: AbsoluteDirPath
  readonly path: AbsolutePath
}): boolean => sandbox(args.root).contains(args.path)
