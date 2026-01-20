/**
 * Megarepo configuration schema and types
 *
 * A megarepo uses a single `megarepo.json` config file that declares:
 * - Members: repos to include (via unified source string format)
 * - Generators: optional config file generators (envrc, vscode, flake, devenv)
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

/** envrc generator configuration */
export class EnvrcGeneratorConfig extends Schema.Class<EnvrcGeneratorConfig>(
  'EnvrcGeneratorConfig',
)({
  /** Enable/disable the generator (default: true) */
  enabled: Schema.optional(Schema.Boolean),
}) {}

/** VSCode workspace generator configuration */
export class VscodeGeneratorConfig extends Schema.Class<VscodeGeneratorConfig>(
  'VscodeGeneratorConfig',
)({
  /** Enable/disable the generator (default: false) */
  enabled: Schema.optional(Schema.Boolean),
  /** Members to exclude from workspace */
  exclude: Schema.optional(Schema.Array(Schema.String)),
}) {}

/** Nix flake generator configuration */
export class FlakeGeneratorConfig extends Schema.Class<FlakeGeneratorConfig>(
  'FlakeGeneratorConfig',
)({
  /** Enable/disable the generator (default: false) */
  enabled: Schema.optional(Schema.Boolean),
  /** Members to skip in flake */
  skip: Schema.optional(Schema.Array(Schema.String)),
}) {}

/** devenv generator configuration */
export class DevenvGeneratorConfig extends Schema.Class<DevenvGeneratorConfig>(
  'DevenvGeneratorConfig',
)({
  /** Enable/disable the generator (default: false) */
  enabled: Schema.optional(Schema.Boolean),
}) {}

/** All generator configurations */
export class GeneratorsConfig extends Schema.Class<GeneratorsConfig>('GeneratorsConfig')({
  envrc: Schema.optional(EnvrcGeneratorConfig),
  vscode: Schema.optional(VscodeGeneratorConfig),
  flake: Schema.optional(FlakeGeneratorConfig),
  devenv: Schema.optional(DevenvGeneratorConfig),
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

/** Environment variable names */
export const ENV_VARS = {
  /** Path to the megarepo root */
  ROOT: 'MEGAREPO_ROOT',
  /** Global store location */
  STORE: 'MEGAREPO_STORE',
  /** Comma-separated list of member names */
  MEMBERS: 'MEGAREPO_MEMBERS',
} as const

// =============================================================================
// JSON Schema Generation
// =============================================================================

/** Generate JSON Schema from Effect Schema */
export const generateJsonSchema = () => JSONSchema.make(MegarepoConfig)

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
  | { readonly type: 'url'; readonly url: string; readonly ref: Option.Option<string> }
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
