/**
 * Megarepo configuration schema and types
 *
 * A megarepo uses a single `megarepo.json` config file that declares:
 * - Members: repos to include (via unified source string format)
 * - Generators: optional config file generators (nix, vscode)
 *
 * Source string format:
 * - GitHub shorthand: "owner/repo" or "owner/repo#ref"
 * - HTTPS URL: "https://github.com/owner/repo" or "https://github.com/owner/repo#ref"
 * - SSH URL: "git@github.com:owner/repo" or "git@github.com:owner/repo#ref"
 * - Local path: "./path", "../path", "/absolute/path"
 */

import { JSONSchema, Option, Schema } from 'effect'

import { EffectPath, type AbsoluteDirPath, type RelativeDirPath } from '@overeng/effect-path'

import { parseSourceRef } from './ref.ts'

// =============================================================================
// Path Type Re-exports
// =============================================================================

// Re-export commonly used path types for convenience
export type {
  AbsoluteDirPath,
  AbsoluteFilePath,
  RelativeDirPath,
  RelativeFilePath,
} from '@overeng/effect-path'
export { EffectPath }

// =============================================================================
// Generator Configuration
// =============================================================================

/**
 * VSCode workspace generator configuration
 *
 * Design: Option B - Typed shortcuts + settings escape hatch
 *
 * Tradeoffs:
 * - `color`: Convenient typed shorthand for the common "branded workspace" pattern.
 *   Auto-generates titleBar, activityBar, and statusBar colors with sensible foregrounds.
 * - `settings`: Raw passthrough for any VSCode workspace settings. No type-safety,
 *   but provides an escape hatch for edge cases and new VSCode features we haven't typed yet.
 *
 * Alternatives considered:
 * - Option A (settings only): Simpler but verbose for common color theming use case
 * - Option C (fully typed): Better DX but high maintenance, would lag behind VSCode
 * - Option D (transform fn): Maximum flexibility but only works in .genie.ts, not JSON
 */
export class VscodeGeneratorConfig extends Schema.Class<VscodeGeneratorConfig>(
  'VscodeGeneratorConfig',
)({
  /** Enable/disable the generator (default: false) */
  enabled: Schema.optional(Schema.Boolean),
  /** Members to exclude from workspace */
  exclude: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Primary accent color for the workspace (hex format, e.g. "#372d8e").
   * Auto-generates titleBar, activityBar, and statusBar background colors
   * with white foreground for contrast.
   */
  color: Schema.optional(Schema.String),
  /**
   * Raw VSCode workspace settings passthrough.
   * Merged with (and overrides) auto-generated settings.
   * Use this for any settings not covered by typed shortcuts above.
   *
   * @example { "editor.formatOnSave": true }
   */
  settings: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
}) {}

/**
 * Configuration for syncing flake.lock and devenv.lock files
 *
 * When enabled, megarepo will update the `rev` fields in member repos'
 * flake.lock and devenv.lock files to match the commits in megarepo.lock.
 * This keeps all lock files in sync with megarepo as the source of truth.
 */
export class NixLockSyncConfig extends Schema.Class<NixLockSyncConfig>('NixLockSyncConfig')({
  /**
   * Enable/disable lock sync (default: true when nix generator is enabled)
   * Set to false to opt-out of automatic lock file synchronization
   */
  enabled: Schema.optional(Schema.Boolean),
  /**
   * Members to exclude from lock sync
   * These members' lock files will not be modified
   */
  exclude: Schema.optional(Schema.Array(Schema.String)),
}) {}

/** Nix workspace generator configuration */
export class NixGeneratorConfig extends Schema.Class<NixGeneratorConfig>('NixGeneratorConfig')({
  /** Enable/disable the generator (default: false) */
  enabled: Schema.optional(Schema.Boolean),
  /** Workspace directory (relative to megarepo root) */
  workspaceDir: Schema.optional(Schema.String),
  /**
   * Configuration for syncing flake.lock and devenv.lock files
   * When nix generator is enabled, lock sync is enabled by default
   */
  lockSync: Schema.optional(NixLockSyncConfig),
}) {}

/** All generator configurations */
export class GeneratorsConfig extends Schema.Class<GeneratorsConfig>('GeneratorsConfig')({
  nix: Schema.optional(NixGeneratorConfig),
  vscode: Schema.optional(VscodeGeneratorConfig),
}) {}

// =============================================================================
// Megarepo Configuration
// =============================================================================

/**
 * Main megarepo configuration schema
 *
 * Members use unified source string format:
 * - "owner/repo" - GitHub shorthand, default branch
 * - "owner/repo#ref" - GitHub shorthand, specific ref
 * - "https://..." - HTTPS URL
 * - "git@host:path" - SSH URL
 * - "./path", "../path", "/path" - Local path
 */
export class MegarepoConfig extends Schema.Class<MegarepoConfig>('MegarepoConfig')({
  /** JSON Schema reference (optional, for editor support) */
  $schema: Schema.optional(Schema.String),

  /** Members: repos to include in this megarepo (name -> source string) */
  members: Schema.Record({ key: Schema.String, value: Schema.String }),

  /** Generators: optional config file generation */
  generators: Schema.optional(GeneratorsConfig),
}) {}

// =============================================================================
// Constants
// =============================================================================

/** Config file name */
export const CONFIG_FILE_NAME = 'megarepo.json'

/** Default store location */
export const DEFAULT_STORE_PATH = '~/.megarepo'

/** Directory holding member symlinks/materialized repos in a megarepo */
export const MEMBER_ROOT_DIR = 'repos'

/** Environment variable names */
export const ENV_VARS = {
  /** Path to the outermost megarepo root */
  ROOT_OUTERMOST: 'MEGAREPO_ROOT_OUTERMOST',
  /** Path to the nearest megarepo root */
  ROOT_NEAREST: 'MEGAREPO_ROOT_NEAREST',
  /** Global store location */
  STORE: 'MEGAREPO_STORE',
  /** Comma-separated list of member names */
  MEMBERS: 'MEGAREPO_MEMBERS',
  /** Local Nix workspace path for generated flake */
  NIX_WORKSPACE: 'MEGAREPO_NIX_WORKSPACE',
} as const

// =============================================================================
// Path Helpers
// =============================================================================

/** Get the members root directory within a megarepo */
export const getMembersRoot = (megarepoRoot: AbsoluteDirPath): AbsoluteDirPath =>
  EffectPath.ops.join(megarepoRoot, EffectPath.unsafe.relativeDir(`${MEMBER_ROOT_DIR}/`))

/** Get the path to a member within a megarepo */
export const getMemberPath = ({
  megarepoRoot,
  name,
}: {
  megarepoRoot: AbsoluteDirPath
  name: string
}): AbsoluteDirPath =>
  EffectPath.ops.join(megarepoRoot, EffectPath.unsafe.relativeDir(`${MEMBER_ROOT_DIR}/${name}/`))

// =============================================================================
// JSON Schema Generation
// =============================================================================

/** Generate JSON Schema from Effect Schema */
export const generateJsonSchema = () => JSONSchema.make(MegarepoConfig)

// =============================================================================
// Member Name Validation
// =============================================================================

/** Check if a string contains control characters (0x00-0x1f) */
const hasControlCharacters = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code <= 0x1f) return true
  }
  return false
}

/**
 * Validate that a member name is safe to use as a directory name.
 * Prevents path traversal attacks and filesystem issues.
 */
export const isValidMemberName = (name: string): boolean => {
  // Must not be empty
  if (name.length === 0) return false

  // Must not contain path separators or traversal sequences
  if (name.includes('/') || name.includes('\\')) return false
  if (name === '.' || name === '..') return false
  if (name.includes('..')) return false

  // Must not start with a dot (hidden files) or hyphen (could be confused with flags)
  if (name.startsWith('.') || name.startsWith('-')) return false

  // Must not contain null bytes or other control characters
  if (hasControlCharacters(name)) return false

  return true
}

/**
 * Validate a member name and return an error message if invalid.
 */
export const validateMemberName = (name: string): string | undefined => {
  if (name.length === 0) return 'Member name cannot be empty'
  if (name.includes('/') || name.includes('\\')) return 'Member name cannot contain path separators'
  if (name === '.' || name === '..') return 'Member name cannot be . or ..'
  if (name.includes('..')) return 'Member name cannot contain ..'
  if (name.startsWith('.')) return 'Member name cannot start with a dot'
  if (name.startsWith('-')) return 'Member name cannot start with a hyphen'
  if (hasControlCharacters(name)) return 'Member name cannot contain control characters'
  return undefined
}

// =============================================================================
// Source Parsing
// =============================================================================

/** Parsed member source with optional ref */
export type MemberSource =
  | {
      readonly type: 'github'
      readonly owner: string
      readonly repo: string
      readonly ref: Option.Option<string>
    }
  | {
      readonly type: 'url'
      readonly url: string
      readonly ref: Option.Option<string>
    }
  | { readonly type: 'path'; readonly path: string }

/** Result of parsing a source string */
export interface ParsedMemberSource {
  readonly source: MemberSource
  readonly ref: Option.Option<string>
}

/**
 * Check if a string looks like a GitHub shorthand (owner/repo)
 * Must have exactly one slash with non-empty segments, and not start with protocol or path indicators
 */
const isGitHubShorthand = (s: string): boolean => {
  // Not a URL (no protocol)
  if (s.includes('://') || s.startsWith('git@')) return false
  // Not a path
  if (s.startsWith('./') || s.startsWith('../') || s.startsWith('/') || s.startsWith('~'))
    return false
  // Has exactly one slash with content on both sides
  const parts = s.split('/')
  return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0
}

/**
 * Check if a string is a local path
 */
const isLocalPath = (s: string): boolean => {
  return s.startsWith('./') || s.startsWith('../') || s.startsWith('/') || s.startsWith('~')
}

/**
 * Parse a source string into a MemberSource.
 * Handles:
 * - GitHub shorthand: "owner/repo" or "owner/repo#ref"
 * - HTTPS URL: "https://..." or "https://...#ref"
 * - SSH URL: "git@host:path" or "git@host:path#ref"
 * - Local path: "./...", "../...", "/...", "~..." (no #ref support)
 */
export const parseSourceString = (sourceString: string): MemberSource | undefined => {
  // Local paths don't support #ref syntax - the entire string is the path
  if (isLocalPath(sourceString)) {
    return { type: 'path', path: sourceString }
  }

  // For non-local sources, extract any #ref suffix
  const { source, ref } = parseSourceRef(sourceString)

  // GitHub shorthand: owner/repo
  if (isGitHubShorthand(source)) {
    const parts = source.split('/')
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { type: 'github', owner: parts[0], repo: parts[1], ref }
    }
    return undefined
  }

  // URL (HTTPS or SSH)
  if (source.includes('://') || source.startsWith('git@')) {
    return { type: 'url', url: source, ref }
  }

  return undefined
}

/**
 * Get the canonical URL for a member source (expands GitHub shorthand)
 */
export const getSourceUrl = (source: MemberSource): string | undefined => {
  switch (source.type) {
    case 'github':
      return `https://github.com/${source.owner}/${source.repo}`
    case 'url':
      return source.url
    case 'path':
      return undefined // Local paths don't have URLs
  }
}

/**
 * Get the store path for a member based on its source.
 * Returns a relative directory path from the store root.
 */
export const getStorePath = (source: MemberSource): RelativeDirPath => {
  switch (source.type) {
    case 'github':
      return EffectPath.unsafe.relativeDir(`github.com/${source.owner}/${source.repo}/`)
    case 'url':
      return parseUrlToStorePath(source.url)
    case 'path':
      return EffectPath.unsafe.relativeDir(
        `local/${source.path.split('/').findLast(Boolean) ?? 'unknown'}/`,
      )
  }
}

/**
 * Parse a git URL to a store path.
 * Returns a relative directory path from the store root.
 */
const parseUrlToStorePath = (url: string): RelativeDirPath => {
  // Handle SSH URLs: git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
  if (sshMatch?.[1] !== undefined && sshMatch[2] !== undefined) {
    return EffectPath.unsafe.relativeDir(`${sshMatch[1]}/${sshMatch[2]}/`)
  }

  // Handle HTTPS URLs: https://github.com/owner/repo.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (httpsMatch?.[1] !== undefined && httpsMatch[2] !== undefined) {
    return EffectPath.unsafe.relativeDir(`${httpsMatch[1]}/${httpsMatch[2]}/`)
  }

  // Fallback: use the URL hash or basename
  const basename = url.split('/').pop()?.replace('.git', '') ?? 'unknown'
  return EffectPath.unsafe.relativeDir(`other/${basename}/`)
}

/**
 * Get the ref from a member source (if specified)
 */
export const getSourceRef = (source: MemberSource): Option.Option<string> => {
  switch (source.type) {
    case 'github':
    case 'url':
      return source.ref
    case 'path':
      return Option.none()
  }
}

/**
 * Check if a source is a remote source (not a local path)
 */
export const isRemoteSource = (source: MemberSource): boolean => {
  return source.type !== 'path'
}

/**
 * Build a source string with a new ref.
 * Takes the base source (without ref) and appends the new ref.
 *
 * @example
 * buildSourceStringWithRef('owner/repo', 'main') // 'owner/repo#main'
 * buildSourceStringWithRef('owner/repo#old', 'new') // 'owner/repo#new'
 * buildSourceStringWithRef('https://github.com/o/r', 'v1.0') // 'https://github.com/o/r#v1.0'
 */
export const buildSourceStringWithRef = (sourceString: string, newRef: string): string => {
  const { source } = parseSourceRef(sourceString)
  return `${source}#${newRef}`
}

/**
 * Get the base source string without any ref.
 *
 * @example
 * getBaseSourceString('owner/repo#main') // 'owner/repo'
 * getBaseSourceString('owner/repo') // 'owner/repo'
 */
export const getBaseSourceString = (sourceString: string): string => {
  const { source } = parseSourceRef(sourceString)
  return source
}
