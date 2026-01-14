/**
 * Filesystem-verified path parsing.
 *
 * Unlike convention-based parsing, these functions verify paths against
 * the actual filesystem to ensure they exist and are of the correct type.
 */

import { FileSystem, Path as PlatformPath, type Error as PlatformError } from '@effect/platform'
import { Effect } from 'effect'

import type {
  Abs,
  AbsoluteDirPath,
  AbsoluteFilePath,
  Dir,
  File,
  Rel,
  RelativeDirPath,
  RelativeFilePath,
} from './brands.ts'
import {
  InvalidPathError,
  NotADirectoryError,
  NotAFileError,
  NotAbsoluteError,
  NotRelativeError,
  PathNotFoundError,
  PermissionError,
  type VerifyError,
} from './errors.ts'
import {
  ensureTrailingSlash,
  extractBaseName,
  extractExtension,
  extractFullExtension,
  getFilename,
  hasNullByte,
  isEmpty,
  isWindowsReservedName,
  MAX_PATH_LENGTH,
  removeTrailingSlash,
  toSegments,
} from './internal/utils.ts'
import type {
  AbsoluteDirInfo,
  AbsoluteFileInfo,
  PathInfo,
  RelativeDirInfo,
  RelativeFileInfo,
} from './PathInfo.ts'

// ═══════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Validate basic path string */
const validatePathString = (path: string): Effect.Effect<string, InvalidPathError> => {
  if (isEmpty(path)) {
    return Effect.fail(
      new InvalidPathError({
        path,
        message: 'Path cannot be empty',
        reason: 'empty',
        position: undefined,
      }),
    )
  }

  if (hasNullByte(path)) {
    return Effect.fail(
      new InvalidPathError({
        path,
        message: 'Path contains null byte',
        reason: 'null_byte',
        position: path.indexOf('\0'),
      }),
    )
  }

  if (path.length > MAX_PATH_LENGTH) {
    return Effect.fail(
      new InvalidPathError({
        path,
        message: `Path exceeds maximum length of ${MAX_PATH_LENGTH} characters`,
        reason: 'too_long',
        position: undefined,
      }),
    )
  }

  const segments = toSegments(path)
  for (const segment of segments) {
    if (isWindowsReservedName(segment)) {
      return Effect.fail(
        new InvalidPathError({
          path,
          message: `Path contains Windows reserved name: ${segment}`,
          reason: 'reserved_name',
          position: undefined,
        }),
      )
    }
  }

  return Effect.succeed(path)
}

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
  // Default to not found
  return new PathNotFoundError({
    path,
    message: `Cannot access path: ${path}`,
    nearestExisting: undefined,
    expectedType: 'any',
  })
}

/** Build PathInfo structure */
const buildPathInfo = <B extends Abs | Rel, T extends File | Dir>(args: {
  readonly original: string
  readonly normalized: string & B & T
  readonly isFile: boolean
  readonly platformPath: PlatformPath.Path
}): PathInfo<B, T> => {
  const { original, normalized, isFile, platformPath } = args
  const segments = toSegments(normalized)

  if (isFile) {
    const filename = getFilename(normalized)
    const parentPath = platformPath.dirname(normalized)

    const fileInfo: PathInfo<B, File> = {
      original,
      normalized: normalized as string & B & File,
      segments,
      extension: extractExtension(filename) as PathInfo<B, File>['extension'],
      fullExtension: extractFullExtension(filename) as PathInfo<B, File>['fullExtension'],
      baseName: extractBaseName(filename),
      parent: buildPathInfo<B, Dir>({
        original: parentPath,
        normalized: ensureTrailingSlash(parentPath) as string & B & Dir,
        isFile: false,
        platformPath,
      }) as PathInfo<B, File>['parent'],
    }
    return fileInfo as PathInfo<B, T>
  }

  const dirName = segments.at(-1) ?? ''
  const parentPath = platformPath.dirname(removeTrailingSlash(normalized))
  const isRoot = parentPath === normalized || parentPath === removeTrailingSlash(normalized)

  const dirInfo: PathInfo<B, Dir> = {
    original,
    normalized: ensureTrailingSlash(normalized) as string & B & Dir,
    segments,
    extension: undefined as PathInfo<B, Dir>['extension'],
    fullExtension: undefined as PathInfo<B, Dir>['fullExtension'],
    baseName: dirName,
    parent: isRoot
      ? (undefined as PathInfo<B, Dir>['parent'])
      : (buildPathInfo<B, Dir>({
          original: parentPath,
          normalized: ensureTrailingSlash(parentPath) as string & B & Dir,
          isFile: false,
          platformPath,
        }) as PathInfo<B, Dir>['parent']),
  }
  return dirInfo as PathInfo<B, T>
}

// ═══════════════════════════════════════════════════════════════════════════
// Verified Parsing - Absolute Paths
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse and verify an absolute file path exists and is a file.
 */
export const absoluteFile = (
  path: string,
): Effect.Effect<AbsoluteFileInfo, VerifyError, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const validated = yield* validatePathString(path)
    const platformPath = yield* PlatformPath.Path
    const fs = yield* FileSystem.FileSystem

    if (!platformPath.isAbsolute(validated)) {
      return yield* new NotAbsoluteError({
        path: validated,
        message: 'Expected absolute path',
        suggestedAbsolute: platformPath.resolve(validated),
      })
    }

    const normalized = platformPath.normalize(validated)

    // Verify it exists and is a file
    const stat = yield* fs
      .stat(normalized)
      .pipe(Effect.mapError((error) => mapFsError({ path, error })))

    if (stat.type === 'Directory') {
      return yield* new NotAFileError({
        path: normalized,
        message: `Expected file but found directory: ${normalized}`,
        actualType: 'directory',
      })
    }

    return buildPathInfo<Abs, File>({
      original: path,
      normalized: normalized as AbsoluteFilePath,
      isFile: true,
      platformPath,
    })
  })

/**
 * Parse and verify an absolute directory path exists and is a directory.
 */
export const absoluteDir = (
  path: string,
): Effect.Effect<AbsoluteDirInfo, VerifyError, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const validated = yield* validatePathString(path)
    const platformPath = yield* PlatformPath.Path
    const fs = yield* FileSystem.FileSystem

    if (!platformPath.isAbsolute(validated)) {
      return yield* new NotAbsoluteError({
        path: validated,
        message: 'Expected absolute path',
        suggestedAbsolute: platformPath.resolve(validated),
      })
    }

    const normalized = platformPath.normalize(removeTrailingSlash(validated))

    // Verify it exists and is a directory
    const stat = yield* fs
      .stat(normalized)
      .pipe(Effect.mapError((error) => mapFsError({ path, error })))

    if (stat.type !== 'Directory') {
      return yield* new NotADirectoryError({
        path: normalized,
        message: `Expected directory but found file: ${normalized}`,
        actualType: 'file',
      })
    }

    const normalizedDir = ensureTrailingSlash(normalized) as AbsoluteDirPath
    return buildPathInfo<Abs, Dir>({
      original: path,
      normalized: normalizedDir,
      isFile: false,
      platformPath,
    })
  })

// ═══════════════════════════════════════════════════════════════════════════
// Verified Parsing - Relative Paths
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse and verify a relative file path exists relative to a base directory.
 */
export const relativeFile = (args: {
  readonly path: string
  readonly base: AbsoluteDirPath
}): Effect.Effect<RelativeFileInfo, VerifyError, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const { path, base } = args
    const validated = yield* validatePathString(path)
    const platformPath = yield* PlatformPath.Path
    const fs = yield* FileSystem.FileSystem

    if (platformPath.isAbsolute(validated)) {
      return yield* new NotRelativeError({
        path: validated,
        message: 'Expected relative path',
        absolutePrefix: validated.slice(0, validated.indexOf('/') + 1) || validated.slice(0, 3),
      })
    }

    // Resolve against base to verify
    const absolutePath = platformPath.join(removeTrailingSlash(base), validated)
    const normalized = platformPath.normalize(validated)

    // Verify it exists and is a file
    const stat = yield* fs
      .stat(absolutePath)
      .pipe(Effect.mapError((error) => mapFsError({ path, error })))

    if (stat.type === 'Directory') {
      return yield* new NotAFileError({
        path: absolutePath,
        message: `Expected file but found directory: ${absolutePath}`,
        actualType: 'directory',
      })
    }

    return buildPathInfo<Rel, File>({
      original: path,
      normalized: normalized as RelativeFilePath,
      isFile: true,
      platformPath,
    })
  })

/**
 * Parse and verify a relative directory path exists relative to a base directory.
 */
export const relativeDir = (args: {
  readonly path: string
  readonly base: AbsoluteDirPath
}): Effect.Effect<RelativeDirInfo, VerifyError, FileSystem.FileSystem | PlatformPath.Path> =>
  Effect.gen(function* () {
    const { path, base } = args
    const validated = yield* validatePathString(path)
    const platformPath = yield* PlatformPath.Path
    const fs = yield* FileSystem.FileSystem

    if (platformPath.isAbsolute(validated)) {
      return yield* new NotRelativeError({
        path: validated,
        message: 'Expected relative path',
        absolutePrefix: validated.slice(0, validated.indexOf('/') + 1) || validated.slice(0, 3),
      })
    }

    // Resolve against base to verify
    const absolutePath = platformPath.join(
      removeTrailingSlash(base),
      removeTrailingSlash(validated),
    )
    const normalized = platformPath.normalize(removeTrailingSlash(validated))

    // Verify it exists and is a directory
    const stat = yield* fs
      .stat(absolutePath)
      .pipe(Effect.mapError((error) => mapFsError({ path, error })))

    if (stat.type !== 'Directory') {
      return yield* new NotADirectoryError({
        path: absolutePath,
        message: `Expected directory but found file: ${absolutePath}`,
        actualType: 'file',
      })
    }

    const normalizedDir = ensureTrailingSlash(normalized) as RelativeDirPath
    return buildPathInfo<Rel, Dir>({
      original: path,
      normalized: normalizedDir,
      isFile: false,
      platformPath,
    })
  })

// ═══════════════════════════════════════════════════════════════════════════
// Ambiguous Path Resolution
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve an ambiguous absolute path by checking the filesystem.
 */
export const resolveAbsolute = (
  path: string,
): Effect.Effect<
  AbsoluteFileInfo | AbsoluteDirInfo,
  VerifyError,
  FileSystem.FileSystem | PlatformPath.Path
> =>
  Effect.gen(function* () {
    const validated = yield* validatePathString(path)
    const platformPath = yield* PlatformPath.Path
    const fs = yield* FileSystem.FileSystem

    if (!platformPath.isAbsolute(validated)) {
      return yield* new NotAbsoluteError({
        path: validated,
        message: 'Expected absolute path',
        suggestedAbsolute: platformPath.resolve(validated),
      })
    }

    const normalized = platformPath.normalize(removeTrailingSlash(validated))

    // Check what type it is
    const stat = yield* fs
      .stat(normalized)
      .pipe(Effect.mapError((error) => mapFsError({ path, error })))

    if (stat.type === 'Directory') {
      const normalizedDir = ensureTrailingSlash(normalized) as AbsoluteDirPath
      return buildPathInfo<Abs, Dir>({
        original: path,
        normalized: normalizedDir,
        isFile: false,
        platformPath,
      })
    }

    return buildPathInfo<Abs, File>({
      original: path,
      normalized: normalized as AbsoluteFilePath,
      isFile: true,
      platformPath,
    })
  })

/**
 * Resolve an ambiguous relative path by checking the filesystem.
 */
export const resolveRelative = (args: {
  readonly path: string
  readonly base: AbsoluteDirPath
}): Effect.Effect<
  RelativeFileInfo | RelativeDirInfo,
  VerifyError,
  FileSystem.FileSystem | PlatformPath.Path
> =>
  Effect.gen(function* () {
    const { path, base } = args
    const validated = yield* validatePathString(path)
    const platformPath = yield* PlatformPath.Path
    const fs = yield* FileSystem.FileSystem

    if (platformPath.isAbsolute(validated)) {
      return yield* new NotRelativeError({
        path: validated,
        message: 'Expected relative path',
        absolutePrefix: validated.slice(0, validated.indexOf('/') + 1) || validated.slice(0, 3),
      })
    }

    // Resolve against base to verify
    const absolutePath = platformPath.join(
      removeTrailingSlash(base),
      removeTrailingSlash(validated),
    )
    const normalized = platformPath.normalize(removeTrailingSlash(validated))

    // Check what type it is
    const stat = yield* fs
      .stat(absolutePath)
      .pipe(Effect.mapError((error) => mapFsError({ path, error })))

    if (stat.type === 'Directory') {
      const normalizedDir = ensureTrailingSlash(normalized) as RelativeDirPath
      return buildPathInfo<Rel, Dir>({
        original: path,
        normalized: normalizedDir,
        isFile: false,
        platformPath,
      })
    }

    return buildPathInfo<Rel, File>({
      original: path,
      normalized: normalized as RelativeFilePath,
      isFile: true,
      platformPath,
    })
  })
