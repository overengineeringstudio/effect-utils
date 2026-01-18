/**
 * Internal utilities for path parsing and manipulation.
 *
 * Uses @effect/platform's Path service for cross-platform compatibility.
 */

import { Path as PlatformPath } from '@effect/platform'
import { Effect } from 'effect'

// ═══════════════════════════════════════════════════════════════════════════
// Platform Path Access
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the platform-specific path separator.
 * On Windows: "\", on Unix: "/"
 */
export const getSeparator = Effect.fnUntraced(function* () {
  const path = yield* PlatformPath.Path
  return path.sep
})()

/**
 * Check if a path is absolute using platform-specific rules.
 */
export const isAbsolutePath = Effect.fnUntraced(function* (p: string) {
  const path = yield* PlatformPath.Path
  return path.isAbsolute(p)
})

/**
 * Normalize a path lexically (resolve . and .., normalize separators).
 */
export const normalizePath = Effect.fnUntraced(function* (p: string) {
  const path = yield* PlatformPath.Path
  return path.normalize(p)
})

/**
 * Join path segments.
 */
export const joinPath = Effect.fnUntraced(function* (...segments: ReadonlyArray<string>) {
  const path = yield* PlatformPath.Path
  return path.join(...segments)
})

/**
 * Get the directory name of a path.
 */
export const dirnamePath = Effect.fnUntraced(function* (p: string) {
  const path = yield* PlatformPath.Path
  return path.dirname(p)
})

/**
 * Get the base name of a path.
 */
export const basenamePath = Effect.fnUntraced(function* (p: string) {
  const path = yield* PlatformPath.Path
  return path.basename(p)
})

/**
 * Get the extension of a path (with leading dot).
 */
export const extnamePath = Effect.fnUntraced(function* (p: string) {
  const path = yield* PlatformPath.Path
  return path.extname(p)
})

// ═══════════════════════════════════════════════════════════════════════════
// Pure Utilities (No Effect Dependencies)
// ═══════════════════════════════════════════════════════════════════════════

/** Check if path has a trailing slash (works for both / and \) */
export const hasTrailingSlash = (p: string): boolean => p.endsWith('/') || p.endsWith('\\')

const isPosixRoot = (p: string): boolean => /^\/+$/.test(p)

/** Ensure path has a trailing slash */
export const ensureTrailingSlash = (p: string): string =>
  hasTrailingSlash(p) || isPosixRoot(p) ? (isPosixRoot(p) ? '/' : p) : `${p}/`

/** Remove trailing slash if present */
export const removeTrailingSlash = (p: string): string => {
  if (!hasTrailingSlash(p)) {
    return p
  }

  if (isPosixRoot(p)) {
    return '/'
  }

  return p.slice(0, -1)
}

/** Check if path contains null bytes (invalid on all platforms) */
export const hasNullByte = (p: string): boolean => p.includes('\0')

/** Check if path is empty */
export const isEmpty = (p: string): boolean => p.length === 0

/**
 * Known compound extensions.
 * These are extensions that should be treated as a single unit.
 */
const COMPOUND_EXTENSIONS = new Set([
  'tar.gz',
  'tar.bz2',
  'tar.xz',
  'tar.zst',
  'd.ts',
  'd.mts',
  'd.cts',
  'spec.ts',
  'spec.tsx',
  'spec.js',
  'spec.jsx',
  'test.ts',
  'test.tsx',
  'test.js',
  'test.jsx',
  'stories.ts',
  'stories.tsx',
  'stories.js',
  'stories.jsx',
  'genie.ts',
  'genie.js',
])

/**
 * Extract single extension from filename (without leading dot).
 * Returns undefined if no extension.
 */
export const extractExtension = (filename: string): string | undefined => {
  const lastDot = filename.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return undefined
  }
  return filename.slice(lastDot + 1)
}

/**
 * Extract full compound extension from filename (without leading dot).
 * Returns undefined if no extension.
 *
 * NOTE: This heuristic may need refinement based on real-world usage.
 */
export const extractFullExtension = (filename: string): string | undefined => {
  const singleExt = extractExtension(filename)
  if (singleExt === undefined) {
    return undefined
  }

  // Try to find compound extensions by checking from the second-to-last dot
  const withoutSingleExt = filename.slice(0, -(singleExt.length + 1))
  const secondDot = withoutSingleExt.lastIndexOf('.')
  if (secondDot > 0) {
    const potentialCompound = filename.slice(secondDot + 1)
    if (COMPOUND_EXTENSIONS.has(potentialCompound)) {
      return potentialCompound
    }
  }

  return singleExt
}

/**
 * Extract base name from filename (filename without extension).
 * For compound extensions, removes the full compound extension.
 */
export const extractBaseName = (filename: string): string => {
  const fullExt = extractFullExtension(filename)
  if (fullExt === undefined) {
    return filename
  }
  return filename.slice(0, -(fullExt.length + 1))
}

/**
 * Split path into segments, handling both Unix and Windows separators.
 * Filters out empty segments.
 */
export const toSegments = (p: string): ReadonlyArray<string> =>
  p.split(/[/\\]/).filter((s) => s.length > 0 && s !== '.')

/**
 * Check if a string looks like it has an extension.
 * A simple heuristic: contains a dot after the last separator.
 */
export const hasExtension = (p: string): boolean => {
  const filename = getFilename(p)
  return filename.includes('.') && !filename.startsWith('.')
}

/**
 * Get the filename part of a path (after the last separator).
 */
export const getFilename = (p: string): string => {
  const lastSep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return lastSep === -1 ? p : p.slice(lastSep + 1)
}

/**
 * Windows reserved names that cannot be used as filenames.
 */
const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
])

/**
 * Check if a filename is a Windows reserved name.
 */
export const isWindowsReservedName = (name: string): boolean => {
  const upper = name.toUpperCase()
  // Check base name without extension
  const dotIndex = upper.indexOf('.')
  const baseName = dotIndex === -1 ? upper : upper.slice(0, dotIndex)
  return WINDOWS_RESERVED_NAMES.has(baseName)
}

/**
 * Maximum path length on most systems.
 * Windows: 260 (MAX_PATH), but can be longer with extended paths.
 * Unix: typically 4096 (PATH_MAX).
 */
export const MAX_PATH_LENGTH = 4096
