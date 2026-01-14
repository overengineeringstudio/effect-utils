/**
 * dotdot configuration schema and types
 *
 * Two config types:
 * - Member config (`dotdot.json`): Self-description (exposes) + dependencies (deps)
 * - Root config (`dotdot-root.json`): Aggregated repos + packages index
 */

import { JSONSchema, Schema } from 'effect'

// =============================================================================
// Shared Types
// =============================================================================

/** Configuration for a package exposure (in member config) */
export const PackageExposeSchema = Schema.Struct({
  /** Path within the repo to the package */
  path: Schema.String,
  /** Command to run after repo install (e.g., "pnpm build") */
  install: Schema.optional(Schema.String),
})

export type PackageExpose = typeof PackageExposeSchema.Type

/** Configuration for a dependency repo (in member config) */
export const DepConfigSchema = Schema.Struct({
  /** Git clone URL */
  url: Schema.String,
  /** Pinned commit SHA */
  rev: Schema.optional(Schema.String),
})

export type DepConfig = typeof DepConfigSchema.Type

// =============================================================================
// Member Config (dotdot.json)
// =============================================================================

/** Member repo configuration - describes what a repo exposes and depends on */
export const MemberConfigSchema = Schema.Struct({
  /** JSON Schema reference (optional, for editor support) */
  $schema: Schema.optional(Schema.String),
  /** Packages this repo exposes to the workspace */
  exposes: Schema.optional(Schema.Record({ key: Schema.String, value: PackageExposeSchema })),
  /** Other repos this repo depends on */
  deps: Schema.optional(Schema.Record({ key: Schema.String, value: DepConfigSchema })),
})

export type MemberConfig = typeof MemberConfigSchema.Type

// =============================================================================
// Root Config (dotdot-root.json)
// =============================================================================

/** Configuration for a repo in the root config (aggregated) */
export const RepoConfigSchema = Schema.Struct({
  /** Git clone URL */
  url: Schema.String,
  /** Pinned commit SHA */
  rev: Schema.optional(Schema.String),
  /** Command to run after cloning (e.g., "bun install") */
  install: Schema.optional(Schema.String),
})

export type RepoConfig = typeof RepoConfigSchema.Type

/** Package index entry - tracks which repo exposes which package */
export const PackageIndexEntrySchema = Schema.Struct({
  /** Name of the repo that exposes this package */
  repo: Schema.String,
  /** Path within the repo to the package */
  path: Schema.String,
  /** Command to run after repo install (e.g., "pnpm build") */
  install: Schema.optional(Schema.String),
})

export type PackageIndexEntry = typeof PackageIndexEntrySchema.Type

/** Root dotdot configuration (aggregated from all member configs) */
export const RootConfigSchema = Schema.Struct({
  /** JSON Schema reference (optional, for editor support) */
  $schema: Schema.optional(Schema.String),
  /** Warning message for generated file */
  _: Schema.optional(Schema.String),
  /** All declared repositories (flat list) */
  repos: Schema.Record({ key: Schema.String, value: RepoConfigSchema }),
  /** Package index - maps package names to their source repos */
  packages: Schema.optional(Schema.Record({ key: Schema.String, value: PackageIndexEntrySchema })),
})

export type RootConfig = typeof RootConfigSchema.Type

/** Config file name (user-authored) */
export const CONFIG_FILE_NAME = 'dotdot.json'

/** Root config file name (auto-generated, read-only) */
export const GENERATED_CONFIG_FILE_NAME = 'dotdot-root.json'

/** Warning message for generated config */
export const GENERATED_CONFIG_WARNING =
  'AUTO-GENERATED FILE - DO NOT EDIT. Run `dotdot sync` to regenerate.'

/** JSON Schema URL for editor support */
export const JSON_SCHEMA_URL =
  'https://raw.githubusercontent.com/overengineeringstudio/dotdot/main/schema/dotdot.schema.json'

/** Generate JSON Schema from Effect Schema */
export const generateJsonSchema = () => JSONSchema.make(RootConfigSchema)
