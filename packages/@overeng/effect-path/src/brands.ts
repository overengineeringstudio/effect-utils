/**
 * Branded type definitions for type-safe file paths.
 *
 * Uses Effect's Brand system to distinguish between:
 * - Absolute vs Relative paths
 * - File vs Directory paths
 *
 * Inspired by Haskell's `path` library phantom types approach.
 */

import type { Brand } from 'effect'

// ═══════════════════════════════════════════════════════════════════════════
// Brand Markers (Phantom Types)
// ═══════════════════════════════════════════════════════════════════════════

/** Marker brand for absolute paths (start from root) */
export type Abs = Brand.Brand<'Abs'>

/** Marker brand for relative paths (relative to some base) */
export type Rel = Brand.Brand<'Rel'>

/** Marker brand for file paths (point to a file) */
export type File = Brand.Brand<'File'>

/** Marker brand for directory paths (point to a directory, end with separator) */
export type Dir = Brand.Brand<'Dir'>

// ═══════════════════════════════════════════════════════════════════════════
// Primary Branded Path Types
// ═══════════════════════════════════════════════════════════════════════════

/** An absolute path (starts from filesystem root) */
export type AbsolutePath = string & Abs

/** A relative path (relative to some base directory) */
export type RelativePath = string & Rel

/** An absolute path pointing to a file */
export type AbsoluteFilePath = string & Abs & File

/** An absolute path pointing to a directory */
export type AbsoluteDirPath = string & Abs & Dir

/** A relative path pointing to a file */
export type RelativeFilePath = string & Rel & File

/** A relative path pointing to a directory */
export type RelativeDirPath = string & Rel & Dir

// ═══════════════════════════════════════════════════════════════════════════
// Union Types for Flexibility
// ═══════════════════════════════════════════════════════════════════════════

/** Any path (absolute or relative) */
export type Path = AbsolutePath | RelativePath

/** Any file path (absolute or relative) */
export type FilePath = AbsoluteFilePath | RelativeFilePath

/** Any directory path (absolute or relative) */
export type DirPath = AbsoluteDirPath | RelativeDirPath

/** Any specific path (file or directory, absolute or relative) */
export type AnyPath = AbsoluteFilePath | AbsoluteDirPath | RelativeFilePath | RelativeDirPath

// ═══════════════════════════════════════════════════════════════════════════
// Type Guards
// ═══════════════════════════════════════════════════════════════════════════

/** Check if a path type is absolute */
export type IsAbsolute<P> = P extends Abs ? true : false

/** Check if a path type is relative */
export type IsRelative<P> = P extends Rel ? true : false

/** Check if a path type is a file */
export type IsFile<P> = P extends File ? true : false

/** Check if a path type is a directory */
export type IsDir<P> = P extends Dir ? true : false

// ═══════════════════════════════════════════════════════════════════════════
// Type Extraction
// ═══════════════════════════════════════════════════════════════════════════

/** Extract the base type (Abs or Rel) from a path */
export type BaseOf<P> = P extends Abs ? Abs : P extends Rel ? Rel : never

/** Extract the target type (File or Dir) from a path */
export type TargetOf<P> = P extends File ? File : P extends Dir ? Dir : never

// ═══════════════════════════════════════════════════════════════════════════
// Ambiguous Path Type
// ═══════════════════════════════════════════════════════════════════════════

/** Marker for paths that could be either file or directory (no trailing slash, no extension) */
export type Ambiguous = Brand.Brand<'Ambiguous'>

/** An absolute path that could be either file or directory */
export type AmbiguousAbsolutePath = string & Abs & Ambiguous

/** A relative path that could be either file or directory */
export type AmbiguousRelativePath = string & Rel & Ambiguous

/** Any ambiguous path */
export type AmbiguousPath = AmbiguousAbsolutePath | AmbiguousRelativePath
