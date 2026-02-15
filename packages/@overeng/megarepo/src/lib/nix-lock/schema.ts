/**
 * Nix Flake Lock File Schema
 *
 * Both flake.lock and devenv.lock use the same format (Nix flake lock version 7).
 * This module provides Effect Schema definitions for parsing and manipulating these files.
 *
 * Key insight from experiments:
 * - `narHash` and `lastModified` are OPTIONAL fields
 * - If present but incorrect, Nix evaluation FAILS with hash/timestamp mismatch
 * - If missing, Nix fetches metadata on demand (safe fallback)
 * - When updating `rev`, we MUST remove `narHash` and `lastModified` to avoid errors
 */

import { Schema } from 'effect'

// =============================================================================
// Locked Input Schemas (type-specific)
// =============================================================================

/**
 * GitHub-type locked input
 * Example: { "type": "github", "owner": "NixOS", "repo": "nixpkgs", "rev": "abc123" }
 */
export class GitHubLockedInput extends Schema.Class<GitHubLockedInput>('GitHubLockedInput')({
  type: Schema.Literal('github'),
  owner: Schema.String,
  repo: Schema.String,
  rev: Schema.String,
  ref: Schema.optional(Schema.String),
  /** NAR hash - optional, must be removed when updating rev */
  narHash: Schema.optional(Schema.String),
  /** Unix timestamp - optional, must be removed when updating rev */
  lastModified: Schema.optional(Schema.Number),
}) {}

/**
 * Git-type locked input (for arbitrary git URLs)
 * Example: { "type": "git", "url": "https://github.com/owner/repo", "rev": "abc123" }
 */
export class GitLockedInput extends Schema.Class<GitLockedInput>('GitLockedInput')({
  type: Schema.Literal('git'),
  url: Schema.String,
  rev: Schema.String,
  ref: Schema.optional(Schema.String),
  /** NAR hash - optional, must be removed when updating rev */
  narHash: Schema.optional(Schema.String),
  /** Unix timestamp - optional, must be removed when updating rev */
  lastModified: Schema.optional(Schema.Number),
  /** Whether the repo is shallow cloned */
  shallow: Schema.optional(Schema.Boolean),
  /** Submodules setting */
  submodules: Schema.optional(Schema.Boolean),
}) {}

/**
 * Path-type locked input (for local paths)
 * Example: { "type": "path", "path": "/nix/store/..." }
 */
export class PathLockedInput extends Schema.Class<PathLockedInput>('PathLockedInput')({
  type: Schema.Literal('path'),
  path: Schema.String,
  narHash: Schema.optional(Schema.String),
  lastModified: Schema.optional(Schema.Number),
}) {}

/**
 * Indirect-type input (for flake registry references)
 * These are resolved at evaluation time, not locked
 */
export class IndirectLockedInput extends Schema.Class<IndirectLockedInput>('IndirectLockedInput')({
  type: Schema.Literal('indirect'),
  id: Schema.String,
}) {}

/**
 * Union of all locked input types we support
 * Note: Nix supports more types (tarball, file, etc.) but these are the common ones
 */
export const LockedInput = Schema.Union(
  GitHubLockedInput,
  GitLockedInput,
  PathLockedInput,
  IndirectLockedInput,
)
export type LockedInput = typeof LockedInput.Type

/**
 * Generic locked input for types we don't specifically handle
 * This allows us to preserve unknown input types without losing data
 */
export const GenericLockedInput = Schema.Struct({
  type: Schema.String,
  rev: Schema.optional(Schema.String),
  narHash: Schema.optional(Schema.String),
  lastModified: Schema.optional(Schema.Number),
}).pipe(Schema.annotations({ identifier: 'GenericLockedInput' }))
export type GenericLockedInput = typeof GenericLockedInput.Type

// =============================================================================
// Flake Lock Node Schema
// =============================================================================

/**
 * A node in the flake lock file
 *
 * Each node represents either:
 * - A flake input with `locked` (resolved) and `original` (as specified) data
 * - The root node which only has `inputs` pointing to other nodes
 */
export class FlakeLockNode extends Schema.Class<FlakeLockNode>('FlakeLockNode')({
  /**
   * Resolved/locked input data
   * Contains the exact revision and optional integrity info (narHash, lastModified)
   */
  locked: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),

  /**
   * Original input specification (as written in flake.nix)
   * Preserved for reference but not used during evaluation
   */
  original: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),

  /**
   * Map of input names to node names in this lock file
   * Used to resolve transitive dependencies
   */
  inputs: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),

  /**
   * Whether this input is a flake (default: true)
   * Non-flake inputs are just source trees without outputs
   */
  flake: Schema.optional(Schema.Boolean),
}) {}

// =============================================================================
// Flake Lock File Schema
// =============================================================================

/**
 * Complete flake.lock / devenv.lock file structure
 */
export class FlakeLock extends Schema.Class<FlakeLock>('FlakeLock')({
  /**
   * Map of node names to node data
   * The "root" node is special and represents the flake itself
   */
  nodes: Schema.Record({ key: Schema.String, value: FlakeLockNode }),

  /**
   * Name of the root node (always "root" in practice)
   */
  root: Schema.String,

  /**
   * Lock file format version (currently 7)
   */
  version: Schema.Number,
}) {}

// =============================================================================
// Helper Types
// =============================================================================

/**
 * Result of parsing a locked input's type-specific data
 */
export interface ParsedLockedInput {
  readonly type: string
  readonly rev: string | undefined
  readonly owner: string | undefined // GitHub
  readonly repo: string | undefined // GitHub
  readonly url: string | undefined // Git
  readonly narHash: string | undefined
  readonly lastModified: number | undefined
}

/**
 * Parse the `locked` field of a FlakeLockNode into a structured type
 */
export const parseLockedInput = (
  locked: Record<string, unknown> | undefined,
): ParsedLockedInput | undefined => {
  if (locked === undefined) return undefined

  const type = locked['type']
  if (typeof type !== 'string') return undefined

  return {
    type,
    rev: typeof locked['rev'] === 'string' ? locked['rev'] : undefined,
    owner: typeof locked['owner'] === 'string' ? locked['owner'] : undefined,
    repo: typeof locked['repo'] === 'string' ? locked['repo'] : undefined,
    url: typeof locked['url'] === 'string' ? locked['url'] : undefined,
    narHash: typeof locked['narHash'] === 'string' ? locked['narHash'] : undefined,
    lastModified: typeof locked['lastModified'] === 'number' ? locked['lastModified'] : undefined,
  }
}

/** Metadata fetched from Nix for a flake input */
export interface NixFlakeMetadata {
  /** NAR hash (e.g., "sha256-ERK+4WsCALO93XrYzVBo7HJs373ifvbVU3A/y1spy6A=") */
  readonly narHash: string
  /** Unix timestamp of last modification */
  readonly lastModified: number
}

/**
 * Create an updated locked input with new rev, optionally updating metadata (narHash, lastModified).
 *
 * When metadata is provided, narHash and lastModified are updated to the new values.
 * When metadata is omitted, narHash and lastModified are removed from the output.
 *
 * This function preserves the original key order of the object.
 */
export const updateLockedInputRev = ({
  locked,
  newRev,
  metadata,
}: {
  locked: Record<string, unknown>
  newRev: string
  metadata?: NixFlakeMetadata
}): Record<string, unknown> => {
  const result: Record<string, unknown> = {}

  for (const key of Object.keys(locked)) {
    if (key === 'rev') {
      result['rev'] = newRev
    } else if (key === 'narHash') {
      if (metadata !== undefined) result['narHash'] = metadata.narHash
    } else if (key === 'lastModified') {
      if (metadata !== undefined) result['lastModified'] = metadata.lastModified
    } else {
      result[key] = locked[key]
    }
  }

  // Ensure required fields are present
  if (!('rev' in result)) result['rev'] = newRev
  if (metadata !== undefined) {
    if (!('narHash' in result)) result['narHash'] = metadata.narHash
    if (!('lastModified' in result)) result['lastModified'] = metadata.lastModified
  }

  return result
}
