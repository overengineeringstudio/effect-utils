/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PROPOSED API — DOES NOT EXIST YET.                                        │
 * │  This is a design artifact / seed spec for the PLANNED `notion schema      │
 * │  apply` feature (demo "3.2"). Nothing here is wired into the CLI. It is    │
 * │  the inverse of the shipped codegen path (`notion schema generate`):       │
 * │  there the live Notion DB is the source of truth; here THIS FILE is.       │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Minimal sketch of the module a real `@overeng/notion-cli/iac` would export so
 * that `tasks.notiondb.ts` (the desired-state file) reads as a natural extension
 * of the existing tool. It is grounded 1:1 in machinery that already exists:
 *
 *   - The property-type surface mirrors `AddPropertyDefinition`
 *     (packages/@overeng/notion-datasource-sync/src/core/commands.ts): the exact
 *     conservative subset the sync engine can already translate to a Notion
 *     `update_data_source` payload — rich_text, number, checkbox, date, url,
 *     email, phone_number, people, select, multi_select. Plus `title` (settable
 *     only at create time; every data source has exactly one).
 *
 *   - `OptionSpec` mirrors `CanonicalOptionValue`
 *     (packages/@overeng/notion-effect-schema/src/properties/canonical.ts), the
 *     option shape `AddProperty`/`AddSelectOptions` already consume.
 *
 * Deliberately ABSENT — because the underlying engine fails closed on them:
 *   status, relation, files, formula, rollup, and every computed type; and all
 *   destructive shapes (delete property, change type, remove option). A real
 *   `apply` surfaces these as BLOCKED plan lines, never as silent mutations.
 *
 * The identity helpers below carry NO apply logic — this file provisions
 * nothing. It only describes the desired shape.
 */
import { Schema } from 'effect'

// -----------------------------------------------------------------------------
// Desired-state schema (what a real loader would decode the file against)
// -----------------------------------------------------------------------------

/** A select / multi_select option. `color` is optional; Notion auto-assigns one. */
export const OptionSpec = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.String),
})
export type OptionSpec = typeof OptionSpec.Type

/**
 * The desired type of one property. Mirrors `AddPropertyDefinition` exactly,
 * plus the create-only `title`. Any type NOT in this union is out of scope on
 * purpose (see header) and a real loader would reject it at decode time.
 */
export const PropertyType = Schema.Union(
  Schema.TaggedStruct('title', {}),
  Schema.TaggedStruct('rich_text', {}),
  Schema.TaggedStruct('number', {}),
  Schema.TaggedStruct('checkbox', {}),
  Schema.TaggedStruct('date', {}),
  Schema.TaggedStruct('url', {}),
  Schema.TaggedStruct('email', {}),
  Schema.TaggedStruct('phone_number', {}),
  Schema.TaggedStruct('people', {}),
  Schema.TaggedStruct('select', { options: Schema.Array(OptionSpec) }),
  Schema.TaggedStruct('multi_select', { options: Schema.Array(OptionSpec) }),
)
export type PropertyType = typeof PropertyType.Type

/**
 * A declared property = its type + authoring metadata.
 *
 * `renamedFrom` is the honest answer to a real limitation: this file keys
 * properties by NAME, but Notion identifies them by id, and the engine's
 * `RenameProperty` op needs the old property id. Without a hint, the planner
 * cannot tell a rename from a delete-old + add-new (which would be destructive
 * and blocked). `renamedFrom: 'OldName'` tells `plan` to emit a `RenameProperty`
 * instead. It is authoring-only metadata, stripped before an `AddProperty`.
 */
export const PropertyDecl = Schema.extend(
  PropertyType,
  Schema.Struct({
    description: Schema.optional(Schema.String),
    renamedFrom: Schema.optional(Schema.String),
  }),
)
export type PropertyDecl = typeof PropertyDecl.Type

/** The desired state of one Notion database. */
export const DatabaseSpec = Schema.Struct({
  name: Schema.String,
  parent: Schema.Struct({ page: Schema.String }),
  properties: Schema.Record({ key: Schema.String, value: PropertyDecl }),
})
export type DatabaseSpec = typeof DatabaseSpec.Type

// -----------------------------------------------------------------------------
// Authoring helpers (the ergonomic surface a config author actually types)
// -----------------------------------------------------------------------------

type Meta = { readonly description?: string; readonly renamedFrom?: string }
type OptionInput = string | OptionSpec

/**
 * Property builders. One per supported type; the shape of each mirrors what the
 * sync engine can actually add. Nothing here is destructive-capable.
 */
export const property = {
  /** The single title property (create-only; Notion won't retype it later). */
  title: (meta: Meta = {}) => ({ _tag: 'title', ...meta }) as const,
  richText: (meta: Meta = {}) => ({ _tag: 'rich_text', ...meta }) as const,
  number: (meta: Meta = {}) => ({ _tag: 'number', ...meta }) as const,
  checkbox: (meta: Meta = {}) => ({ _tag: 'checkbox', ...meta }) as const,
  date: (meta: Meta = {}) => ({ _tag: 'date', ...meta }) as const,
  url: (meta: Meta = {}) => ({ _tag: 'url', ...meta }) as const,
  email: (meta: Meta = {}) => ({ _tag: 'email', ...meta }) as const,
  phoneNumber: (meta: Meta = {}) => ({ _tag: 'phone_number', ...meta }) as const,
  people: (meta: Meta = {}) => ({ _tag: 'people', ...meta }) as const,
  select: (opts: Meta & { options: readonly OptionInput[] }) =>
    ({ _tag: 'select', options: opts.options.map(toOption), ...stripOptions(opts) }) as const,
  multiSelect: (opts: Meta & { options: readonly OptionInput[] }) =>
    ({ _tag: 'multi_select', options: opts.options.map(toOption), ...stripOptions(opts) }) as const,
}

/** Parent page for a created database. Pass it from the environment — never
 *  hard-code a workspace id in a committed file (this is a public repo). */
export const parentPage = (pageId: string | undefined): DatabaseSpec['parent'] => {
  if (pageId === undefined || pageId === '') {
    throw new Error('parentPage: set DEMO_PARENT_PAGE to a page shared with the integration')
  }
  return { page: pageId }
}

/** Identity helper — full type-checking + autocomplete, no side effects. The
 *  real loader would `Schema.decodeUnknownSync(DatabaseSpec)` the result. */
export const defineDatabase = (spec: DatabaseSpec): DatabaseSpec => spec

// -----------------------------------------------------------------------------
// Internal (non-exported) — kept below the exported surface.
// -----------------------------------------------------------------------------

function toOption(input: OptionInput): OptionSpec {
  return typeof input === 'string' ? { name: input } : input
}

function stripOptions<T extends { options: readonly OptionInput[] }>(
  opts: T,
): Omit<T, 'options'> {
  const { options: _options, ...rest } = opts
  return rest
}
