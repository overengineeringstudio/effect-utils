/**
 * Convention-based path parsing (pure, no filesystem access).
 *
 * Uses trailing-slash convention to distinguish files from directories:
 * - Directories end with `/` or `\`
 * - Files do not end with a separator
 *
 * This module provides parsing functions that use the @effect/platform Path service.
 */

import { Path as PlatformPath } from '@effect/platform'
import { Effect } from 'effect'

import type {
  Abs,
  AbsoluteDirPath,
  AbsoluteFilePath,
  AmbiguousAbsolutePath,
  AmbiguousPath,
  AmbiguousRelativePath,
  Dir,
  File,
  Rel,
  RelativeDirPath,
  RelativeFilePath,
} from './brands.ts'
import {
  ConventionError,
  InvalidPathError,
  NotAbsoluteError,
  NotRelativeError,
  type ParseError,
} from './errors.ts'
import {
  ensureTrailingSlash,
  extractBaseName,
  extractExtension,
  extractFullExtension,
  getFilename,
  hasExtension,
  hasNullByte,
  hasTrailingSlash,
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
// Validation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate a path string for basic correctness.
 * Returns Effect with InvalidPathError if invalid.
 */
const validatePath = (path: string): Effect.Effect<string, InvalidPathError> => {
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
    const position = path.indexOf('\0')
    return Effect.fail(
      new InvalidPathError({
        path,
        message: 'Path contains null byte',
        reason: 'null_byte',
        position,
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

  // Check for Windows reserved names in path segments
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

// ═══════════════════════════════════════════════════════════════════════════
// Convention Parsing (Effect-based for platform abstraction)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse an absolute directory path using convention (must end with separator).
 */
export const absoluteDir = (
  path: string,
): Effect.Effect<AbsoluteDirPath, ParseError, PlatformPath.Path> =>
  Effect.gen(function* () {
    const validated = yield* validatePath(path)
    const platformPath = yield* PlatformPath.Path

    if (!platformPath.isAbsolute(validated)) {
      return yield* new NotAbsoluteError({
        path: validated,
        message: 'Expected absolute path',
        suggestedAbsolute: undefined,
      })
    }

    if (!hasTrailingSlash(validated)) {
      return yield* new ConventionError({
        path: validated,
        message: 'Directory path must end with a separator',
        expected: 'directory',
        violation: 'no_trailing_slash_on_directory',
      })
    }

    const normalized = platformPath.normalize(validated)
    return ensureTrailingSlash(normalized) as AbsoluteDirPath
  })

/**
 * Parse an absolute file path using convention (must not end with separator).
 */
export const absoluteFile = (
  path: string,
): Effect.Effect<AbsoluteFilePath, ParseError, PlatformPath.Path> =>
  Effect.gen(function* () {
    const validated = yield* validatePath(path)
    const platformPath = yield* PlatformPath.Path

    if (!platformPath.isAbsolute(validated)) {
      return yield* new NotAbsoluteError({
        path: validated,
        message: 'Expected absolute path',
        suggestedAbsolute: undefined,
      })
    }

    if (hasTrailingSlash(validated)) {
      return yield* new ConventionError({
        path: validated,
        message: 'File path must not end with a separator',
        expected: 'file',
        violation: 'trailing_slash_on_file',
      })
    }

    const normalized = platformPath.normalize(validated)
    return normalized as AbsoluteFilePath
  })

/**
 * Parse a relative directory path using convention (must end with separator).
 */
export const relativeDir = (
  path: string,
): Effect.Effect<RelativeDirPath, ParseError, PlatformPath.Path> =>
  Effect.gen(function* () {
    const validated = yield* validatePath(path)
    const platformPath = yield* PlatformPath.Path

    if (platformPath.isAbsolute(validated)) {
      // Extract the absolute prefix for error context
      const firstSep = Math.max(validated.indexOf('/'), validated.indexOf('\\'))
      const prefix = firstSep === -1 ? validated : validated.slice(0, firstSep + 1)
      return yield* new NotRelativeError({
        path: validated,
        message: 'Expected relative path',
        absolutePrefix: prefix,
      })
    }

    if (!hasTrailingSlash(validated)) {
      return yield* new ConventionError({
        path: validated,
        message: 'Directory path must end with a separator',
        expected: 'directory',
        violation: 'no_trailing_slash_on_directory',
      })
    }

    const normalized = platformPath.normalize(validated)
    return ensureTrailingSlash(normalized) as RelativeDirPath
  })

/**
 * Parse a relative file path using convention (must not end with separator).
 */
export const relativeFile = (
  path: string,
): Effect.Effect<RelativeFilePath, ParseError, PlatformPath.Path> =>
  Effect.gen(function* () {
    const validated = yield* validatePath(path)
    const platformPath = yield* PlatformPath.Path

    if (platformPath.isAbsolute(validated)) {
      const firstSep = Math.max(validated.indexOf('/'), validated.indexOf('\\'))
      const prefix = firstSep === -1 ? validated : validated.slice(0, firstSep + 1)
      return yield* new NotRelativeError({
        path: validated,
        message: 'Expected relative path',
        absolutePrefix: prefix,
      })
    }

    if (hasTrailingSlash(validated)) {
      return yield* new ConventionError({
        path: validated,
        message: 'File path must not end with a separator',
        expected: 'file',
        violation: 'trailing_slash_on_file',
      })
    }

    const normalized = platformPath.normalize(validated)
    return normalized as RelativeFilePath
  })

/**
 * Parse any absolute path, inferring file vs directory from convention.
 * Returns AmbiguousAbsolutePath if the path has no trailing slash and no extension.
 */
export const absolute = (
  path: string,
): Effect.Effect<
  AbsoluteFilePath | AbsoluteDirPath | AmbiguousAbsolutePath,
  InvalidPathError | NotAbsoluteError,
  PlatformPath.Path
> =>
  Effect.gen(function* () {
    const validated = yield* validatePath(path)
    const platformPath = yield* PlatformPath.Path

    if (!platformPath.isAbsolute(validated)) {
      return yield* new NotAbsoluteError({
        path: validated,
        message: 'Expected absolute path',
        suggestedAbsolute: undefined,
      })
    }

    const normalized = platformPath.normalize(validated)

    if (hasTrailingSlash(validated)) {
      return ensureTrailingSlash(normalized) as AbsoluteDirPath
    }

    if (hasExtension(normalized)) {
      return normalized as AbsoluteFilePath
    }

    // Ambiguous: no trailing slash, no extension
    return normalized as AmbiguousAbsolutePath
  })

/**
 * Parse any relative path, inferring file vs directory from convention.
 * Returns AmbiguousRelativePath if the path has no trailing slash and no extension.
 */
export const relative = (
  path: string,
): Effect.Effect<
  RelativeFilePath | RelativeDirPath | AmbiguousRelativePath,
  InvalidPathError | NotRelativeError,
  PlatformPath.Path
> =>
  Effect.gen(function* () {
    const validated = yield* validatePath(path)
    const platformPath = yield* PlatformPath.Path

    if (platformPath.isAbsolute(validated)) {
      const firstSep = Math.max(validated.indexOf('/'), validated.indexOf('\\'))
      const prefix = firstSep === -1 ? validated : validated.slice(0, firstSep + 1)
      return yield* new NotRelativeError({
        path: validated,
        message: 'Expected relative path',
        absolutePrefix: prefix,
      })
    }

    const normalized = platformPath.normalize(validated)

    if (hasTrailingSlash(validated)) {
      return ensureTrailingSlash(normalized) as RelativeDirPath
    }

    if (hasExtension(normalized)) {
      return normalized as RelativeFilePath
    }

    // Ambiguous: no trailing slash, no extension
    return normalized as AmbiguousRelativePath
  })

// ═══════════════════════════════════════════════════════════════════════════
// Ambiguous Path Resolution
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve an ambiguous absolute path by assuming it's a directory.
 */
export const assumeAbsoluteDir = (path: AmbiguousAbsolutePath): AbsoluteDirPath =>
  ensureTrailingSlash(path) as AbsoluteDirPath

/**
 * Resolve an ambiguous absolute path by assuming it's a file.
 */
export const assumeAbsoluteFile = (path: AmbiguousAbsolutePath): AbsoluteFilePath =>
  removeTrailingSlash(path) as AbsoluteFilePath

/**
 * Resolve an ambiguous relative path by assuming it's a directory.
 */
export const assumeRelativeDir = (path: AmbiguousRelativePath): RelativeDirPath =>
  ensureTrailingSlash(path) as RelativeDirPath

/**
 * Resolve an ambiguous relative path by assuming it's a file.
 */
export const assumeRelativeFile = (path: AmbiguousRelativePath): RelativeFilePath =>
  removeTrailingSlash(path) as RelativeFilePath

/**
 * Resolve any ambiguous path by assuming it's a directory.
 */
export const assumeDir = <P extends AmbiguousPath>(
  path: P,
): P extends AmbiguousAbsolutePath ? AbsoluteDirPath : RelativeDirPath =>
  ensureTrailingSlash(path) as P extends AmbiguousAbsolutePath ? AbsoluteDirPath : RelativeDirPath

/**
 * Resolve any ambiguous path by assuming it's a file.
 */
export const assumeFile = <P extends AmbiguousPath>(
  path: P,
): P extends AmbiguousAbsolutePath ? AbsoluteFilePath : RelativeFilePath =>
  removeTrailingSlash(path) as P extends AmbiguousAbsolutePath ? AbsoluteFilePath : RelativeFilePath

// ═══════════════════════════════════════════════════════════════════════════
// PathInfo Construction
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build PathInfo for a directory path.
 */
const buildDirInfo = <B extends Abs | Rel>(
  original: string,
  normalized: string & B & Dir,
  platformPath: PlatformPath.Path,
): PathInfo<B, Dir> => {
  const segments = toSegments(normalized)
  const dirName = segments.at(-1) ?? ''

  // Compute parent
  const parentPath = platformPath.dirname(removeTrailingSlash(normalized))
  const isRoot = parentPath === normalized || parentPath === removeTrailingSlash(normalized)

  return {
    original,
    normalized,
    segments,
    extension: undefined as PathInfo<B, Dir>['extension'],
    fullExtension: undefined as PathInfo<B, Dir>['fullExtension'],
    baseName: dirName,
    parent: isRoot
      ? (undefined as PathInfo<B, Dir>['parent'])
      : (buildDirInfo(
          parentPath,
          ensureTrailingSlash(parentPath) as string & B & Dir,
          platformPath,
        ) as PathInfo<B, Dir>['parent']),
  }
}

/**
 * Build PathInfo for a file path.
 */
const buildFileInfo = <B extends Abs | Rel>(
  original: string,
  normalized: string & B & File,
  platformPath: PlatformPath.Path,
): PathInfo<B, File> => {
  const segments = toSegments(normalized)
  const filename = getFilename(normalized)

  // Compute parent directory
  const parentPath = platformPath.dirname(normalized)
  const parentNormalized = ensureTrailingSlash(parentPath) as string & B & Dir

  return {
    original,
    normalized,
    segments,
    extension: (extractExtension(filename) ?? undefined) as PathInfo<B, File>['extension'],
    fullExtension: (extractFullExtension(filename) ?? undefined) as PathInfo<
      B,
      File
    >['fullExtension'],
    baseName: extractBaseName(filename),
    parent: buildDirInfo(parentPath, parentNormalized, platformPath) as PathInfo<B, File>['parent'],
  }
}

/**
 * Parse and build AbsoluteFileInfo.
 */
export const absoluteFileInfo = (
  path: string,
): Effect.Effect<AbsoluteFileInfo, ParseError, PlatformPath.Path> =>
  Effect.gen(function* () {
    const normalized = yield* absoluteFile(path)
    const platformPath = yield* PlatformPath.Path
    return buildFileInfo<Abs>(path, normalized, platformPath)
  })

/**
 * Parse and build AbsoluteDirInfo.
 */
export const absoluteDirInfo = (
  path: string,
): Effect.Effect<AbsoluteDirInfo, ParseError, PlatformPath.Path> =>
  Effect.gen(function* () {
    const normalized = yield* absoluteDir(path)
    const platformPath = yield* PlatformPath.Path
    return buildDirInfo<Abs>(path, normalized, platformPath)
  })

/**
 * Parse and build RelativeFileInfo.
 */
export const relativeFileInfo = (
  path: string,
): Effect.Effect<RelativeFileInfo, ParseError, PlatformPath.Path> =>
  Effect.gen(function* () {
    const normalized = yield* relativeFile(path)
    const platformPath = yield* PlatformPath.Path
    return buildFileInfo<Rel>(path, normalized, platformPath)
  })

/**
 * Parse and build RelativeDirInfo.
 */
export const relativeDirInfo = (
  path: string,
): Effect.Effect<RelativeDirInfo, ParseError, PlatformPath.Path> =>
  Effect.gen(function* () {
    const normalized = yield* relativeDir(path)
    const platformPath = yield* PlatformPath.Path
    return buildDirInfo<Rel>(path, normalized, platformPath)
  })
