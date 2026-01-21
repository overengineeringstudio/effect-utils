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
 * Semver-like pattern for tag detection.
 * Matches: v1.0.0, v1.0, 1.0.0, 1.0
 */
const SEMVER_PATTERN = /^v?\d+\.\d+(\.\d+)?/

/**
 * Check if a ref looks like a semantic version tag.
 * Uses heuristic: starts with optional 'v' followed by major.minor[.patch]
 *
 * @example
 * looksLikeTag('v1.0.0') // true
 * looksLikeTag('v1.0') // true
 * looksLikeTag('1.0.0') // true
 * looksLikeTag('main') // false
 * looksLikeTag('release-1.0') // false
 */
export const looksLikeTag = (ref: string): boolean => {
  return SEMVER_PATTERN.test(ref)
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
