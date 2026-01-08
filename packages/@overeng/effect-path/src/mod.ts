/**
 * @module @overeng/effect-path
 *
 * Type-safe file path library for Effect.
 *
 * Provides branded types that distinguish between:
 * - Absolute vs Relative paths
 * - File vs Directory paths
 *
 * Features:
 * - Dual-mode verification (convention-based vs filesystem-verified)
 * - Rich PathInfo structures preserving original + normalized representations
 * - Deep Schema integration
 * - Symlink-aware operations
 * - Traversal-resistant sandbox API
 *
 * @example
 * ```ts
 * import { EffectPath } from '@overeng/effect-path'
 *
 * // Convention-based parsing (pure, no IO)
 * const dir = EffectPath.convention.absoluteDir('/home/user/src/')
 *
 * // Filesystem-verified parsing
 * const file = EffectPath.verified.absoluteFile('/home/user/src/mod.ts')
 *
 * // Type-safe operations
 * const joined = EffectPath.ops.join(dir, EffectPath.unsafe.relativeFile('index.ts'))
 *
 * // Schema integration
 * const parsed = Schema.decodeUnknown(EffectPath.schema.AbsoluteFilePath)(input)
 *
 * // Sandbox for secure file access
 * const sb = EffectPath.sandbox(EffectPath.unsafe.absoluteDir('/app/data/'))
 * const data = sb.readFile(EffectPath.unsafe.relativeFile('config.json'))
 * ```
 */

// ═══════════════════════════════════════════════════════════════════════════
// Re-exports: Types
// ═══════════════════════════════════════════════════════════════════════════

export type {
  // Brand markers
  Abs,
  Rel,
  File,
  Dir,
  Ambiguous,
  // Primary path types
  AbsolutePath,
  RelativePath,
  AbsoluteFilePath,
  AbsoluteDirPath,
  RelativeFilePath,
  RelativeDirPath,
  // Union types
  Path,
  FilePath,
  DirPath,
  AnyPath,
  // Ambiguous types
  AmbiguousAbsolutePath,
  AmbiguousRelativePath,
  AmbiguousPath,
  // Type utilities
  IsAbsolute,
  IsRelative,
  IsFile,
  IsDir,
  BaseOf,
  TargetOf,
} from './brands.ts'

export type {
  // PathInfo types
  PathInfo,
  AbsoluteFileInfo,
  AbsoluteDirInfo,
  RelativeFileInfo,
  RelativeDirInfo,
  AbsolutePathInfo,
  RelativePathInfo,
  FilePathInfo,
  DirPathInfo,
  AnyPathInfo,
} from './PathInfo.ts'

export type {
  // Error types
  InvalidPathReason,
  // Error unions
  ParseError,
  VerifyError,
  SymlinkError,
  SandboxError,
  AnyPathError,
} from './errors.ts'

/** Error classes exported for instanceof checks and construction */
export {
  InvalidPathError,
  NotAbsoluteError,
  NotRelativeError,
  NotAFileError,
  NotADirectoryError,
  ConventionError,
  PathNotFoundError,
  NotASymlinkError,
  SymlinkLoopError,
  TraversalError,
  PermissionError,
} from './errors.ts'

export type { Sandbox } from './Sandbox.ts'

// ═══════════════════════════════════════════════════════════════════════════
// Namespace Imports
// ═══════════════════════════════════════════════════════════════════════════

import * as convention from './convention.ts'
import * as normalize from './normalize.ts'
import * as ops from './ops.ts'
import { sandbox, withSandbox, validatePath, isContained } from './Sandbox.ts'
import * as schema from './schema.ts'
import * as symlink from './symlink.ts'
import * as unsafe from './unsafe.ts'
import * as verified from './verified.ts'

// ═══════════════════════════════════════════════════════════════════════════
// Main Path Namespace
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Main namespace for all path operations.
 *
 * Organized into sub-namespaces:
 * - `convention` - Pure parsing using trailing-slash convention
 * - `verified` - Filesystem-verified parsing
 * - `unsafe` - Unchecked constructors (use with caution)
 * - `ops` - Type-safe path operations
 * - `normalize` - Path normalization at different levels
 * - `symlink` - Symlink detection and resolution
 * - `schema` - Schema definitions for parsing/encoding
 * - `sandbox` - Create traversal-resistant sandbox
 */
export const EffectPath = {
  // ─────────────────────────────────────────────────────────────────────────
  // Convention-Based Parsing (Pure, no IO)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Convention-based parsing using trailing-slash convention.
   *
   * - Directories must end with `/`
   * - Files must not end with `/`
   *
   * These are pure functions that don't access the filesystem.
   */
  convention: {
    /** Parse absolute directory path (must end with /) */
    absoluteDir: convention.absoluteDir,
    /** Parse absolute file path (must not end with /) */
    absoluteFile: convention.absoluteFile,
    /** Parse relative directory path (must end with /) */
    relativeDir: convention.relativeDir,
    /** Parse relative file path (must not end with /) */
    relativeFile: convention.relativeFile,
    /** Parse any absolute path, inferring type from convention */
    absolute: convention.absolute,
    /** Parse any relative path, inferring type from convention */
    relative: convention.relative,
    /** Assume ambiguous absolute path is a directory */
    assumeAbsoluteDir: convention.assumeAbsoluteDir,
    /** Assume ambiguous absolute path is a file */
    assumeAbsoluteFile: convention.assumeAbsoluteFile,
    /** Assume ambiguous relative path is a directory */
    assumeRelativeDir: convention.assumeRelativeDir,
    /** Assume ambiguous relative path is a file */
    assumeRelativeFile: convention.assumeRelativeFile,
    /** Assume any ambiguous path is a directory */
    assumeDir: convention.assumeDir,
    /** Assume any ambiguous path is a file */
    assumeFile: convention.assumeFile,
    /** Parse and build AbsoluteFileInfo */
    absoluteFileInfo: convention.absoluteFileInfo,
    /** Parse and build AbsoluteDirInfo */
    absoluteDirInfo: convention.absoluteDirInfo,
    /** Parse and build RelativeFileInfo */
    relativeFileInfo: convention.relativeFileInfo,
    /** Parse and build RelativeDirInfo */
    relativeDirInfo: convention.relativeDirInfo,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Filesystem-Verified Parsing
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Filesystem-verified parsing.
   *
   * These functions verify paths against the actual filesystem
   * to ensure they exist and are of the correct type.
   */
  verified: {
    /** Parse and verify absolute file exists */
    absoluteFile: verified.absoluteFile,
    /** Parse and verify absolute directory exists */
    absoluteDir: verified.absoluteDir,
    /** Parse and verify relative file exists (relative to base) */
    relativeFile: verified.relativeFile,
    /** Parse and verify relative directory exists (relative to base) */
    relativeDir: verified.relativeDir,
    /** Resolve ambiguous absolute path by checking filesystem */
    resolveAbsolute: verified.resolveAbsolute,
    /** Resolve ambiguous relative path by checking filesystem */
    resolveRelative: verified.resolveRelative,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Unsafe Constructors
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Unsafe constructors that bypass validation.
   *
   * Use only when you are certain the path is valid.
   * These are useful for known-good paths from trusted sources.
   */
  unsafe: {
    /** Create AbsolutePath without validation */
    absolutePath: unsafe.absolutePath,
    /** Create RelativePath without validation */
    relativePath: unsafe.relativePath,
    /** Create AbsoluteFilePath without validation */
    absoluteFile: unsafe.absoluteFile,
    /** Create AbsoluteDirPath without validation */
    absoluteDir: unsafe.absoluteDir,
    /** Create RelativeFilePath without validation */
    relativeFile: unsafe.relativeFile,
    /** Create RelativeDirPath without validation */
    relativeDir: unsafe.relativeDir,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Path Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Type-safe path operations.
   *
   * Operations preserve path type information through the type system.
   */
  ops: {
    /** Join directory with relative paths */
    join: ops.join,
    /** Join paths using platform-specific separator */
    joinPlatform: ops.joinPlatform,
    /** Resolve paths to absolute */
    resolve: ops.resolve,
    /** Get relative path between two absolute paths */
    relative: ops.relative,
    /** Get parent directory */
    parent: ops.parent,
    /** Get parent using platform-specific logic */
    parentPlatform: ops.parentPlatform,
    /** Get file name from file path */
    fileName: ops.fileName,
    /** Get base name (without extension) */
    baseName: ops.baseName,
    /** Get single extension */
    extension: ops.extension,
    /** Get full compound extension */
    fullExtension: ops.fullExtension,
    /** Get path segments */
    segments: ops.segments,
    /** Change file extension */
    withExtension: ops.withExtension,
    /** Change base name */
    withBaseName: ops.withBaseName,
    /** Add suffix to file name */
    addSuffix: ops.addSuffix,
    /** Check if path starts with directory */
    startsWith: ops.startsWith,
    /** Check if path ends with suffix */
    endsWith: ops.endsWith,
    /** Strip prefix directory from path */
    stripPrefix: ops.stripPrefix,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Normalization
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Path normalization at different levels.
   *
   * - `lexical` - Pure string normalization (no IO)
   * - `absolute` - Make path absolute without symlink resolution
   * - `canonical` - Full resolution including symlinks
   */
  normalize: {
    /** Lexical normalization (pure, no IO) */
    lexical: normalize.lexical,
    /** Lexical normalization without Effect */
    lexicalPure: normalize.lexicalPure,
    /** Convert relative to absolute (no symlink resolution) */
    absolute: normalize.absolute,
    /** Convert any path to absolute */
    toAbsolute: normalize.toAbsolute,
    /** Full canonical resolution (with symlinks) */
    canonical: normalize.canonical,
    /** Canonical or fallback to lexical if path doesn't exist */
    canonicalOrLexical: normalize.canonicalOrLexical,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Symlink Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Symlink detection and resolution.
   */
  symlink: {
    /** Check if path is a symlink */
    is: symlink.isSymlink,
    /** Check if path is a symlink (returns false if error) */
    isSafe: symlink.isSymlinkSafe,
    /** Read immediate symlink target */
    readLink: symlink.readLink,
    /** Resolve all symlinks to final target */
    resolve: symlink.resolve,
    /** Resolve symlinks safely (returns original on error) */
    resolveSafe: symlink.resolveSafe,
    /** Get full symlink chain */
    chain: symlink.chain,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Schema Definitions
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Schema definitions for parsing and encoding paths.
   */
  schema: {
    /** Schema for AbsolutePath */
    AbsolutePath: schema.AbsolutePath,
    /** Schema for RelativePath */
    RelativePath: schema.RelativePath,
    /** Schema for AbsoluteFilePath */
    AbsoluteFilePath: schema.AbsoluteFilePath,
    /** Schema for AbsoluteDirPath */
    AbsoluteDirPath: schema.AbsoluteDirPath,
    /** Schema for RelativeFilePath */
    RelativeFilePath: schema.RelativeFilePath,
    /** Schema for RelativeDirPath */
    RelativeDirPath: schema.RelativeDirPath,
    /** Schema for AbsoluteFileInfo (configurable encoding) */
    AbsoluteFileInfo: schema.AbsoluteFileInfo,
    /** Schema for AbsoluteDirInfo (configurable encoding) */
    AbsoluteDirInfo: schema.AbsoluteDirInfo,
    /** Schema for RelativeFileInfo (configurable encoding) */
    RelativeFileInfo: schema.RelativeFileInfo,
    /** Schema for RelativeDirInfo (configurable encoding) */
    RelativeDirInfo: schema.RelativeDirInfo,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Sandbox
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a traversal-resistant sandbox.
   *
   * All operations within the sandbox are guaranteed to stay within the root directory.
   * Symlinks are followed only if their target remains within the sandbox.
   */
  sandbox,

  /** Create sandbox and perform operation */
  withSandbox,

  /** Validate path stays within directory (convenience) */
  validatePath,

  /** Check if path is contained in directory (convenience) */
  isContained,
} as const
