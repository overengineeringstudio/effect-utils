/**
 * Megarepo configuration schema and types
 *
 * A megarepo uses a single `megarepo.json` config file that declares:
 * - Members: repos to include (via GitHub shorthand, URL, or local path)
 * - Generators: optional config file generators (envrc, vscode, flake, devenv)
 */

import { JSONSchema, Schema } from 'effect'

// =============================================================================
// Member Configuration
// =============================================================================

/**
 * Configuration for a member repository.
 *
 * Member source priority: `github` > `url` > `path` (only one should be specified)
 */
export class MemberConfig extends Schema.Class<MemberConfig>('MemberConfig')({
  /** GitHub shorthand: "owner/repo" */
  github: Schema.optional(Schema.String),

  /** Full git URL (for non-GitHub remotes) */
  url: Schema.optional(Schema.String),

  /** Local file path (for repos without remote) */
  path: Schema.optional(Schema.String),

  /** Pin to specific ref (tag, branch, commit) */
  pin: Schema.optional(Schema.String),

  /** Isolate: create worktree at this branch instead of symlink */
  isolated: Schema.optional(Schema.String),
}) {}

// =============================================================================
// Generator Configuration
// =============================================================================

/** envrc generator configuration */
export class EnvrcGeneratorConfig extends Schema.Class<EnvrcGeneratorConfig>('EnvrcGeneratorConfig')({
  /** Enable/disable the generator (default: true) */
  enabled: Schema.optional(Schema.Boolean),
}) {}

/** VSCode workspace generator configuration */
export class VscodeGeneratorConfig extends Schema.Class<VscodeGeneratorConfig>('VscodeGeneratorConfig')({
  /** Enable/disable the generator (default: false) */
  enabled: Schema.optional(Schema.Boolean),
  /** Members to exclude from workspace */
  exclude: Schema.optional(Schema.Array(Schema.String)),
}) {}

/** Nix flake generator configuration */
export class FlakeGeneratorConfig extends Schema.Class<FlakeGeneratorConfig>('FlakeGeneratorConfig')({
  /** Enable/disable the generator (default: false) */
  enabled: Schema.optional(Schema.Boolean),
  /** Members to skip in flake */
  skip: Schema.optional(Schema.Array(Schema.String)),
}) {}

/** devenv generator configuration */
export class DevenvGeneratorConfig extends Schema.Class<DevenvGeneratorConfig>('DevenvGeneratorConfig')({
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

/** Main megarepo configuration schema */
export class MegarepoConfig extends Schema.Class<MegarepoConfig>('MegarepoConfig')({
  /** JSON Schema reference (optional, for editor support) */
  $schema: Schema.optional(Schema.String),

  /** Members: repos to include in this megarepo */
  members: Schema.Record({ key: Schema.String, value: MemberConfig }),

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
// Utility Types
// =============================================================================

/** Parsed member source (derived from config) */
export type MemberSource =
  | { readonly type: 'github'; readonly owner: string; readonly repo: string }
  | { readonly type: 'url'; readonly url: string }
  | { readonly type: 'path'; readonly path: string }

/**
 * Parse member config to determine source type
 */
export const parseMemberSource = (config: MemberConfig): MemberSource | undefined => {
  if (config.github !== undefined) {
    const parts = config.github.split('/')
    if (parts.length === 2 && parts[0] !== undefined && parts[1] !== undefined) {
      return { type: 'github', owner: parts[0], repo: parts[1] }
    }
    return undefined
  }
  if (config.url !== undefined) {
    return { type: 'url', url: config.url }
  }
  if (config.path !== undefined) {
    return { type: 'path', path: config.path }
  }
  return undefined
}

/**
 * Get the store path for a member based on its source
 */
export const getStorePath = (source: MemberSource): string => {
  switch (source.type) {
    case 'github':
      return `github.com/${source.owner}/${source.repo}`
    case 'url':
      return parseUrlToStorePath(source.url)
    case 'path':
      return `local/${source.path.split('/').pop() ?? 'unknown'}`
  }
}

/**
 * Parse a git URL to a store path
 */
const parseUrlToStorePath = (url: string): string => {
  // Handle SSH URLs: git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
  if (sshMatch?.[1] !== undefined && sshMatch[2] !== undefined) {
    return `${sshMatch[1]}/${sshMatch[2]}`
  }

  // Handle HTTPS URLs: https://github.com/owner/repo.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (httpsMatch?.[1] !== undefined && httpsMatch[2] !== undefined) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`
  }

  // Fallback: use the URL hash or basename
  const basename = url.split('/').pop()?.replace('.git', '') ?? 'unknown'
  return `other/${basename}`
}
