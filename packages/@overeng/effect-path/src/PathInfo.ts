/**
 * Rich path information structure that preserves both original and normalized representations.
 *
 * Design decision: Parent is computed eagerly at construction time for simplicity,
 * since paths are typically short and consistency is more valuable than micro-optimization.
 */

import type { Abs, Dir, File, Rel } from './brands.ts'

// ═══════════════════════════════════════════════════════════════════════════
// PathInfo Interface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Rich path representation that preserves original input while providing
 * normalized form for consistent operations.
 *
 * @template B - Base type: Abs (absolute) or Rel (relative)
 * @template T - Target type: File or Dir
 */
export interface PathInfo<B extends Abs | Rel, T extends File | Dir> {
  /** Original path string as provided (before normalization) */
  readonly original: string

  /** Normalized path (. and .. resolved, consistent separators) */
  readonly normalized: string & B & T

  /** Individual path segments (excluding root and separators) */
  readonly segments: ReadonlyArray<string>

  /**
   * Single file extension (without dot).
   * For `file.tar.gz` this would be `"gz"`.
   * `undefined` for directories or files without extensions.
   */
  readonly extension: T extends File ? string | undefined : undefined

  /**
   * Full compound extension (without leading dot).
   * For `file.tar.gz` this would be `"tar.gz"`.
   * `undefined` for directories or files without extensions.
   *
   * NOTE: The compound extension detection heuristic may need refinement
   * based on real-world usage. Currently uses common patterns like .tar.gz, .d.ts, etc.
   */
  readonly fullExtension: T extends File ? string | undefined : undefined

  /**
   * Base name of the path.
   * - For files: filename without extension (e.g., "file" from "file.txt")
   * - For directories: directory name (e.g., "src" from "/home/user/src/")
   */
  readonly baseName: string

  /**
   * Parent directory path.
   * - For files: always defined (the containing directory)
   * - For directories: undefined if this is the root directory
   */
  readonly parent: T extends File ? PathInfo<B, Dir> : PathInfo<B, Dir> | undefined
}

// ═══════════════════════════════════════════════════════════════════════════
// Type Aliases for Common PathInfo Types
// ═══════════════════════════════════════════════════════════════════════════

/** PathInfo for an absolute file path */
export type AbsoluteFileInfo = PathInfo<Abs, File>

/** PathInfo for an absolute directory path */
export type AbsoluteDirInfo = PathInfo<Abs, Dir>

/** PathInfo for a relative file path */
export type RelativeFileInfo = PathInfo<Rel, File>

/** PathInfo for a relative directory path */
export type RelativeDirInfo = PathInfo<Rel, Dir>

/** PathInfo for any absolute path */
export type AbsolutePathInfo = AbsoluteFileInfo | AbsoluteDirInfo

/** PathInfo for any relative path */
export type RelativePathInfo = RelativeFileInfo | RelativeDirInfo

/** PathInfo for any file path */
export type FilePathInfo = AbsoluteFileInfo | RelativeFileInfo

/** PathInfo for any directory path */
export type DirPathInfo = AbsoluteDirInfo | RelativeDirInfo

/** PathInfo for any path */
export type AnyPathInfo = AbsoluteFileInfo | AbsoluteDirInfo | RelativeFileInfo | RelativeDirInfo
