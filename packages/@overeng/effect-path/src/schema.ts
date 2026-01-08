/**
 * Schema definitions for path types.
 *
 * Provides Schema types for parsing and validating paths with full Effect integration.
 * Supports configurable encoding (original vs normalized).
 */

import { Schema } from 'effect'

import type {
  AbsoluteDirPath as AbsoluteDirPathType,
  AbsoluteFilePath as AbsoluteFilePathType,
  AbsolutePath as AbsolutePathType,
  RelativeDirPath as RelativeDirPathType,
  RelativeFilePath as RelativeFilePathType,
  RelativePath as RelativePathType,
} from './brands.ts'
import type { Abs, Dir, File, Rel } from './brands.ts'
import {
  ensureTrailingSlash,
  extractBaseName,
  extractExtension,
  extractFullExtension,
  getFilename,
  hasNullByte,
  hasTrailingSlash,
  isEmpty,
  isWindowsReservedName,
  MAX_PATH_LENGTH,
  removeTrailingSlash,
  toSegments,
} from './internal/utils.ts'
import type {
  AbsoluteDirInfo as AbsoluteDirInfoType,
  AbsoluteFileInfo as AbsoluteFileInfoType,
  PathInfo,
  RelativeDirInfo as RelativeDirInfoType,
  RelativeFileInfo as RelativeFileInfoType,
} from './PathInfo.ts'

// ═══════════════════════════════════════════════════════════════════════════
// Basic Path Schemas (String validation only, no platform dependency)
// ═══════════════════════════════════════════════════════════════════════════

/** Validate basic path string (no null bytes, not empty, not too long) */
const PathStringSchema = Schema.String.pipe(
  Schema.filter((s) => !isEmpty(s), { message: () => 'Path cannot be empty' }),
  Schema.filter((s) => !hasNullByte(s), { message: () => 'Path cannot contain null bytes' }),
  Schema.filter((s) => s.length <= MAX_PATH_LENGTH, {
    message: () => `Path exceeds maximum length of ${MAX_PATH_LENGTH} characters`,
  }),
  Schema.filter(
    (s) => {
      const segments = toSegments(s)
      return !segments.some(isWindowsReservedName)
    },
    { message: () => 'Path contains Windows reserved name' },
  ),
)

// ═══════════════════════════════════════════════════════════════════════════
// Convention-Based Schemas (Use platform Path for isAbsolute check)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Schema for absolute paths.
 * Uses a heuristic for isAbsolute since we can't access Path service in Schema.
 */
const isAbsoluteHeuristic = (s: string): boolean => {
  // Unix absolute path
  if (s.startsWith('/')) return true
  // Windows absolute path (drive letter)
  if (/^[A-Za-z]:[\\/]/.test(s)) return true
  // Windows UNC path
  if (s.startsWith('\\\\')) return true
  return false
}

/** Schema for AbsolutePath (absolute, could be file or dir) */
export const AbsolutePath = PathStringSchema.pipe(
  Schema.filter(isAbsoluteHeuristic, {
    message: () => 'Expected absolute path (starting with / or drive letter)',
  }),
  Schema.brand('Abs'),
) as unknown as Schema.Schema<AbsolutePathType, string>

/** Schema for RelativePath (relative, could be file or dir) */
export const RelativePath = PathStringSchema.pipe(
  Schema.filter((s) => !isAbsoluteHeuristic(s), {
    message: () => 'Expected relative path (not starting with / or drive letter)',
  }),
  Schema.brand('Rel'),
) as unknown as Schema.Schema<RelativePathType, string>

/** Schema for AbsoluteFilePath (absolute file, no trailing slash) */
export const AbsoluteFilePath = AbsolutePath.pipe(
  Schema.filter((s) => !hasTrailingSlash(s), {
    message: () => 'File path must not end with a separator',
  }),
  Schema.brand('File'),
) as unknown as Schema.Schema<AbsoluteFilePathType, string>

/** Schema for AbsoluteDirPath (absolute directory, has trailing slash) */
export const AbsoluteDirPath = AbsolutePath.pipe(
  Schema.filter(hasTrailingSlash, {
    message: () => 'Directory path must end with a separator',
  }),
  Schema.brand('Dir'),
) as unknown as Schema.Schema<AbsoluteDirPathType, string>

/** Schema for RelativeFilePath (relative file, no trailing slash) */
export const RelativeFilePath = RelativePath.pipe(
  Schema.filter((s) => !hasTrailingSlash(s), {
    message: () => 'File path must not end with a separator',
  }),
  Schema.brand('File'),
) as unknown as Schema.Schema<RelativeFilePathType, string>

/** Schema for RelativeDirPath (relative directory, has trailing slash) */
export const RelativeDirPath = RelativePath.pipe(
  Schema.filter(hasTrailingSlash, {
    message: () => 'Directory path must end with a separator',
  }),
  Schema.brand('Dir'),
) as unknown as Schema.Schema<RelativeDirPathType, string>

// ═══════════════════════════════════════════════════════════════════════════
// PathInfo Schemas
// ═══════════════════════════════════════════════════════════════════════════

/** Options for PathInfo schema encoding */
export interface PathInfoSchemaOptions {
  /** Whether to encode as original or normalized path. Default: 'normalized' */
  readonly encodeAs?: 'original' | 'normalized'
}

/**
 * Build a PathInfo from a validated path string.
 * This is a pure function that doesn't require platform Path.
 */
const buildPathInfoPure = <B extends Abs | Rel, T extends File | Dir>(
  original: string,
  isFile: boolean,
): PathInfo<B, T> => {
  // Simple normalization (just forward slashes, no platform-specific logic)
  const normalized = original.replace(/\\/g, '/').replace(/\/+/g, '/')

  const segments = toSegments(normalized)

  if (isFile) {
    const filename = getFilename(normalized)
    const parentPath = normalized.slice(0, -(filename.length + 1)) || '/'

    const fileInfo: PathInfo<B, File> = {
      original,
      normalized: normalized as string & B & File,
      segments,
      extension: extractExtension(filename) as PathInfo<B, File>['extension'],
      fullExtension: extractFullExtension(filename) as PathInfo<B, File>['fullExtension'],
      baseName: extractBaseName(filename),
      parent: buildPathInfoPure<B, Dir>(parentPath, false) as unknown as PathInfo<
        B,
        File
      >['parent'],
    }
    return fileInfo as PathInfo<B, T>
  }

  const dirName = segments.at(-1) ?? ''
  const normalizedDir = ensureTrailingSlash(normalized)
  const parentPath = removeTrailingSlash(normalized).split('/').slice(0, -1).join('/') || '/'
  const isRoot = parentPath === '/' || parentPath === normalized || segments.length === 0

  const dirInfo: PathInfo<B, Dir> = {
    original,
    normalized: normalizedDir as string & B & Dir,
    segments,
    extension: undefined as PathInfo<B, Dir>['extension'],
    fullExtension: undefined as PathInfo<B, Dir>['fullExtension'],
    baseName: dirName,
    parent: isRoot
      ? (undefined as PathInfo<B, Dir>['parent'])
      : (buildPathInfoPure<B, Dir>(ensureTrailingSlash(parentPath), false) as PathInfo<
          B,
          Dir
        >['parent']),
  }
  return dirInfo as PathInfo<B, T>
}

/** Schema for PathInfo<B, T> fields (without parent for recursive definition) */
const _PathInfoFieldsSchema = <B extends Abs | Rel, T extends File | Dir>(_isFile: boolean) =>
  Schema.Struct({
    original: Schema.String,
    normalized: Schema.String as unknown as Schema.Schema<string & B & T, string & B & T>,
    segments: Schema.Array(Schema.String),
    extension: _isFile
      ? Schema.UndefinedOr(Schema.String)
      : (Schema.Undefined as Schema.Schema<undefined>),
    fullExtension: _isFile
      ? Schema.UndefinedOr(Schema.String)
      : (Schema.Undefined as Schema.Schema<undefined>),
    baseName: Schema.String,
  })

/**
 * Create a schema that transforms a string into PathInfo.
 */
const createPathInfoSchema = <B extends Abs | Rel, T extends File | Dir>(
  baseSchema: Schema.Schema<string & B & T, string>,
  isFile: boolean,
  options: PathInfoSchemaOptions = {},
): Schema.Schema<PathInfo<B, T>, string> => {
  const encodeAs = options.encodeAs ?? 'normalized'

  return Schema.transform(baseSchema, Schema.Unknown as Schema.Schema<PathInfo<B, T>>, {
    strict: true,
    decode: (s) => buildPathInfoPure<B, T>(s, isFile),
    encode: (info) => (encodeAs === 'original' ? info.original : info.normalized) as string & B & T,
  })
}

/**
 * Schema for AbsoluteFileInfo with configurable encoding.
 */
export const AbsoluteFileInfo = (
  options?: PathInfoSchemaOptions,
): Schema.Schema<AbsoluteFileInfoType, string> =>
  createPathInfoSchema<Abs, File>(
    AbsoluteFilePath as Schema.Schema<AbsoluteFilePathType, string>,
    true,
    options,
  )

/**
 * Schema for AbsoluteDirInfo with configurable encoding.
 */
export const AbsoluteDirInfo = (
  options?: PathInfoSchemaOptions,
): Schema.Schema<AbsoluteDirInfoType, string> =>
  createPathInfoSchema<Abs, Dir>(
    AbsoluteDirPath as Schema.Schema<AbsoluteDirPathType, string>,
    false,
    options,
  )

/**
 * Schema for RelativeFileInfo with configurable encoding.
 */
export const RelativeFileInfo = (
  options?: PathInfoSchemaOptions,
): Schema.Schema<RelativeFileInfoType, string> =>
  createPathInfoSchema<Rel, File>(
    RelativeFilePath as Schema.Schema<RelativeFilePathType, string>,
    true,
    options,
  )

/**
 * Schema for RelativeDirInfo with configurable encoding.
 */
export const RelativeDirInfo = (
  options?: PathInfoSchemaOptions,
): Schema.Schema<RelativeDirInfoType, string> =>
  createPathInfoSchema<Rel, Dir>(
    RelativeDirPath as Schema.Schema<RelativeDirPathType, string>,
    false,
    options,
  )

// ═══════════════════════════════════════════════════════════════════════════
// Default PathInfo Schemas (normalized encoding)
// ═══════════════════════════════════════════════════════════════════════════

/** Default AbsoluteFileInfo schema (encodes as normalized) */
export const AbsoluteFileInfoDefault: Schema.Schema<AbsoluteFileInfoType, string> =
  AbsoluteFileInfo()

/** Default AbsoluteDirInfo schema (encodes as normalized) */
export const AbsoluteDirInfoDefault: Schema.Schema<AbsoluteDirInfoType, string> = AbsoluteDirInfo()

/** Default RelativeFileInfo schema (encodes as normalized) */
export const RelativeFileInfoDefault: Schema.Schema<RelativeFileInfoType, string> =
  RelativeFileInfo()

/** Default RelativeDirInfo schema (encodes as normalized) */
export const RelativeDirInfoDefault: Schema.Schema<RelativeDirInfoType, string> = RelativeDirInfo()
