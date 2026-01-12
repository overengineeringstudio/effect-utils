/**
 * dotdot configuration schema and types
 *
 * Config files are JSON: `dotdot.json`
 */

import { JSONSchema, Schema } from 'effect'

/** Configuration for a package within a repo */
export const PackageConfigSchema = Schema.Struct({
  /** Path within the repo to the package */
  path: Schema.String,
  /** Command to run after repo install (e.g., "pnpm build") */
  install: Schema.optional(Schema.String),
})

export type PackageConfig = typeof PackageConfigSchema.Type

/** Configuration for a single repo */
export const RepoConfigSchema = Schema.Struct({
  /** Git clone URL */
  url: Schema.String,
  /** Pinned commit SHA */
  rev: Schema.optional(Schema.String),
  /** Command to run after cloning (e.g., "bun install") */
  install: Schema.optional(Schema.String),
  /** Packages to expose as symlinks at workspace root */
  packages: Schema.optional(Schema.Record({ key: Schema.String, value: PackageConfigSchema })),
})

export type RepoConfig = typeof RepoConfigSchema.Type

/** Root dotdot configuration */
export const DotdotConfigSchema = Schema.Struct({
  /** JSON Schema reference (optional, for editor support) */
  $schema: Schema.optional(Schema.String),
  /** Declared repositories */
  repos: Schema.Record({ key: Schema.String, value: RepoConfigSchema }),
})

export type DotdotConfig = typeof DotdotConfigSchema.Type

/** Config file name (user-authored) */
export const CONFIG_FILE_NAME = 'dotdot.json'

/** Generated config file name (auto-generated, read-only) */
export const GENERATED_CONFIG_FILE_NAME = 'dotdot.generated.json'

/** Warning message for generated config */
export const GENERATED_CONFIG_WARNING =
  'AUTO-GENERATED FILE - DO NOT EDIT. Run `dotdot sync` to regenerate.'

/** JSON Schema URL for editor support */
export const JSON_SCHEMA_URL =
  'https://raw.githubusercontent.com/overengineeringstudio/dotdot/main/schema/dotdot.schema.json'

/** Generate JSON Schema from Effect Schema */
export const generateJsonSchema = () => JSONSchema.make(DotdotConfigSchema)
