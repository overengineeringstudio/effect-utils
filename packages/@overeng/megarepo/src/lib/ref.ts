/**
 * Ref encoding and parsing utilities for megarepo
 *
 * Handles:
 * - URL encoding refs for filesystem-safe paths
 * - Extracting #ref from source strings
 * - Classifying refs as commit/tag/branch
 */

import { Option } from 'effect'

// =============================================================================
// Ref Encoding (for filesystem paths)
// =============================================================================

/**
 * Encode a git ref for use in filesystem paths.
 * Uses URL percent-encoding for safety.
 *
 * @example
 * encodeRef('main') // 'main'
 * encodeRef('feature/foo') // 'feature%2Ffoo'
 * encodeRef('100%complete') // '100%25complete'
 */
export const encodeRef = (ref: string): string => {
  // Use encodeURIComponent for most encoding, which handles /,%,etc.
  // But we want to keep alphanumerics, -, _, . unencoded for readability
  return encodeURIComponent(ref)
}

/**
 * Decode a URL-encoded ref back to its original form.
 *
 * @example
 * decodeRef('main') // 'main'
 * decodeRef('feature%2Ffoo') // 'feature/foo'
 * decodeRef('100%25complete') // '100%complete'
 */
export const decodeRef = (encoded: string): string => {
  return decodeURIComponent(encoded)
}

// =============================================================================
// Source Parsing
// =============================================================================

/** Result of parsing a source string */
export interface ParsedSource {
  /** The source URL/path without the ref */
  readonly source: string
  /** The ref if specified (after #) */
  readonly ref: Option.Option<string>
}

/**
 * Parse a source string to extract the optional #ref suffix.
 *
 * @example
 * parseSourceRef('effect-ts/effect') // { source: 'effect-ts/effect', ref: None }
 * parseSourceRef('effect-ts/effect#main') // { source: 'effect-ts/effect', ref: Some('main') }
 * parseSourceRef('effect-ts/effect#v3.0.0') // { source: 'effect-ts/effect', ref: Some('v3.0.0') }
 * parseSourceRef('https://github.com/org/repo#feature/foo') // { source: 'https://github.com/org/repo', ref: Some('feature/foo') }
 */
export const parseSourceRef = (sourceString: string): ParsedSource => {
  const hashIndex = sourceString.lastIndexOf('#')

  if (hashIndex === -1) {
    return { source: sourceString, ref: Option.none() }
  }

  const source = sourceString.slice(0, hashIndex)
  const ref = sourceString.slice(hashIndex + 1)

  // Empty ref after # is treated as no ref (strip the trailing #)
  if (ref === '') {
    return { source, ref: Option.none() }
  }

  return { source, ref: Option.some(ref) }
}

// =============================================================================
// Ref Classification
// =============================================================================

/** The type of a git ref */
export type RefType = 'commit' | 'tag' | 'branch'

/**
 * Check if a string is a valid 40-character git commit SHA.
 *
 * @example
 * isCommitSha('abc123def456789012345678901234567890abcd') // true
 * isCommitSha('main') // false
 * isCommitSha('abc123') // false (too short)
 */
export const isCommitSha = (ref: string): boolean => {
  return /^[0-9a-f]{40}$/i.test(ref)
}

/**
 * Semver-like pattern for tag detection (strict).
 * Matches: v1.0.0, v1.0, 1.0.0, 1.0, v1.0.0-rc.1, v1.2.3-beta.1, etc.
 * Allows optional prerelease suffix: -alpha, -beta.1, -rc.2, etc.
 */
const SEMVER_STRICT_PATTERN = /^v?\d+\.\d+(\.\d+)?(-[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*)?$/

/**
 * Extended pattern for tag detection (includes prefixed versions).
 * Matches: jq-1.6, release-v1.0, prefix-1.2.3, release-v1.2.3-beta.1
 * Also matches multi-word prefixes: my-app-1.0.0, my-cool-app-v2.0
 * Also matches prefixes with numbers: app2-v1.0.0, thing3-1.2.3
 * Allows optional prerelease suffix after the version.
 *
 * Pattern breakdown:
 * - ^[a-zA-Z][a-zA-Z0-9]*  : starts with letter, then alphanumeric
 * - (-[a-zA-Z][a-zA-Z0-9]*)* : zero or more additional word segments (each starting with letter)
 * - -v?\d+\.\d+(\.\d+)?  : version number with optional v prefix
 * - (-[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*)? : optional prerelease suffix
 */
const SEMVER_EXTENDED_PATTERN =
  /^[a-zA-Z][a-zA-Z0-9]*(-[a-zA-Z][a-zA-Z0-9]*)*-v?\d+\.\d+(\.\d+)?(-[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*)?$/

/**
 * Check if a ref looks like a semantic version tag.
 * Uses heuristic: starts with optional 'v' followed by major.minor[.patch]
 * Also matches prefixed versions like 'jq-1.6' or 'release-v1.0'
 * Supports multi-word prefixes like 'my-app-1.0.0' or 'my-cool-app-v2.0'
 * Supports prefixes with numbers like 'app2-v1.0.0' or 'node18-v1.0.0'
 * Supports prerelease suffixes like -alpha, -beta.1, -rc.2
 *
 * @example
 * looksLikeTag('v1.0.0') // true
 * looksLikeTag('v1.0') // true
 * looksLikeTag('1.0.0') // true
 * looksLikeTag('v1.0.0-rc.1') // true
 * looksLikeTag('v1.2.3-beta.1') // true
 * looksLikeTag('jq-1.6') // true
 * looksLikeTag('release-v1.0') // true
 * looksLikeTag('my-app-1.0.0') // true
 * looksLikeTag('app2-v1.0.0') // true
 * looksLikeTag('main') // false
 */
export const looksLikeTag = (ref: string): boolean => {
  return SEMVER_STRICT_PATTERN.test(ref) || SEMVER_EXTENDED_PATTERN.test(ref)
}

/**
 * Classify a ref as commit, tag, or branch.
 *
 * Classification rules:
 * 1. 40-char hex string → commit (immutable)
 * 2. Semver-like pattern → tag (immutable)
 * 3. Otherwise → branch (mutable)
 *
 * @example
 * classifyRef('abc123def456789012345678901234567890abcd') // 'commit'
 * classifyRef('v1.0.0') // 'tag'
 * classifyRef('main') // 'branch'
 * classifyRef('feature/foo') // 'branch'
 */
export const classifyRef = (ref: string): RefType => {
  if (isCommitSha(ref)) {
    return 'commit'
  }
  if (looksLikeTag(ref)) {
    return 'tag'
  }
  return 'branch'
}

/**
 * Get the store path segment for a ref type.
 *
 * @example
 * refTypeToPathSegment('commit') // 'commits'
 * refTypeToPathSegment('tag') // 'tags'
 * refTypeToPathSegment('branch') // 'heads'
 */
export const refTypeToPathSegment = (type: RefType): string => {
  switch (type) {
    case 'commit':
      return 'commits'
    case 'tag':
      return 'tags'
    case 'branch':
      return 'heads'
  }
}

/**
 * Check if a ref type represents an immutable ref.
 * Commits and tags are immutable; branches are mutable.
 */
export const isImmutableRef = (type: RefType): boolean => {
  return type === 'commit' || type === 'tag'
}

// =============================================================================
// Symlink Path Parsing
// =============================================================================

/**
 * Result of extracting a ref from a symlink path
 */
export interface ExtractedSymlinkRef {
  /** The decoded ref (e.g., 'refactor/genie-igor-ci') */
  readonly ref: string
  /** The type of ref based on the path segment */
  readonly type: 'branch' | 'tag' | 'commit'
}

/**
 * Extract a git ref from a megarepo store symlink path.
 *
 * Store paths follow the pattern:
 * - `~/.megarepo/<url>/refs/heads/<branch>` for branches
 * - `~/.megarepo/<url>/refs/tags/<tag>` for tags
 * - `~/.megarepo/<url>/commits/<sha>` for commits
 *
 * Branch names with `/` are URL-encoded as `%2F`.
 *
 * @example
 * extractRefFromSymlinkPath('/Users/foo/.megarepo/github.com/org/repo/refs/heads/main')
 * // { ref: 'main', type: 'branch' }
 *
 * extractRefFromSymlinkPath('/Users/foo/.megarepo/github.com/org/repo/refs/heads/refactor%2Fgenie-igor-ci')
 * // { ref: 'refactor/genie-igor-ci', type: 'branch' }
 *
 * extractRefFromSymlinkPath('/Users/foo/.megarepo/github.com/org/repo/refs/tags/v1.0.0')
 * // { ref: 'v1.0.0', type: 'tag' }
 *
 * extractRefFromSymlinkPath('/Users/foo/.megarepo/github.com/org/repo/commits/abc123def456789012345678901234567890abcd')
 * // { ref: 'abc123def456789012345678901234567890abcd', type: 'commit' }
 *
 * extractRefFromSymlinkPath('/some/other/path')
 * // undefined
 */
export const extractRefFromSymlinkPath = (symlinkTarget: string): ExtractedSymlinkRef | undefined => {
  // Path format: .../refs/heads/<branch> or .../refs/tags/<tag> or .../commits/<sha>
  // Branch names with / are URL-encoded as %2F
  const refsMatch = symlinkTarget.match(/\/refs\/heads\/([^/]+(?:\/[^/]+)*)(?:\/)?$/)
  const tagsMatch = symlinkTarget.match(/\/refs\/tags\/([^/]+)(?:\/)?$/)
  const commitsMatch = symlinkTarget.match(/\/commits\/([a-f0-9]+)(?:\/)?$/)

  if (refsMatch) {
    // Decode URL-encoded branch names (e.g., refactor%2Fgenie-igor-ci -> refactor/genie-igor-ci)
    return { ref: decodeURIComponent(refsMatch[1]!), type: 'branch' }
  }
  if (tagsMatch) {
    return { ref: tagsMatch[1]!, type: 'tag' }
  }
  if (commitsMatch) {
    return { ref: commitsMatch[1]!, type: 'commit' }
  }
  return undefined
}
