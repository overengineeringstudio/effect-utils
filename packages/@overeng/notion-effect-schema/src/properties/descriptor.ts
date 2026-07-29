/**
 * Compact, non-authoritative property descriptors carried by `.nmd` page files.
 *
 * A descriptor identifies *which* Notion property a visible field claims to edit
 * (stable ID, name, type, owning data source, and a config-identity hash). It is
 * one evidence source for stable property identity, never sync-control proof:
 * freshness, base completeness, relation availability, convergence, outbox, and
 * settlement all stay with higher packages (see requirements R10/R11).
 *
 * This package only *models and canonicalizes* descriptors and their hashes — it
 * never fetches a schema or computes a live hash. The hash *values* are produced
 * by higher layers; here they are validated `sha256:<hex64>` strings so a
 * malformed identity fails closed at the schema boundary (R13).
 *
 * @module
 */

import { Schema } from 'effect'

import { DataSourceId, NotionPropertyType, PropertyId, PropertyName } from './canonical.ts'

/** Validated `sha256:<hex64>` content-hash form shared by the descriptor identity hashes. */
const Sha256Hash = Schema.Trimmed.check(Schema.isNonEmpty()).check(
  Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
)

/**
 * Identity of a property's current schema *configuration* (options, format,
 * relation target, …). Higher layers compare it for config staleness; a mismatch
 * means the descriptor's claimed configuration no longer holds.
 */
export const ConfigHash = Sha256Hash.pipe(
  Schema.brand('Notion.ConfigHash'),
  Schema.annotate({ identifier: 'Notion.ConfigHash' }),
)
export type ConfigHash = typeof ConfigHash.Type

/**
 * Identity of a data source's overall *schema* (its full set of properties).
 * Branded distinctly from {@link ConfigHash} so a per-property config identity
 * can never be passed where a whole-schema identity is required, and vice versa.
 *
 * Shared foundation with no Phase 1 consumer: the Phase 3 PropertyWriteCore /
 * proof providers compare it for schema staleness.
 */
export const SchemaHash = Sha256Hash.pipe(
  Schema.brand('Notion.SchemaHash'),
  Schema.annotate({ identifier: 'Notion.SchemaHash' }),
)
export type SchemaHash = typeof SchemaHash.Type

/**
 * The kind of stable-identity evidence a descriptor-bound write may rely on.
 *
 * Data-only classification, not a proof carrier: each variant names *where* the
 * stable property identity came from (the `.nmd` descriptor itself, hidden
 * workspace state, or fresh live schema), mirroring the three sources the spec
 * binds datasource-scoped writes to. Carrying the actual evidence would cross
 * into proof acquisition, which belongs to higher packages (R10).
 *
 * Shared foundation with no Phase 1 consumer: the Phase 3 PropertyWriteCore /
 * proof providers tag stable-identity evidence with this source.
 */
export const PropertyIdentityEvidenceSource = Schema.Union([
  Schema.TaggedStruct('descriptor', {}),
  Schema.TaggedStruct('workspace_state', {}),
  Schema.TaggedStruct('live_schema', {}),
]).annotate({ identifier: 'Notion.PropertyIdentityEvidenceSource' })
export type PropertyIdentityEvidenceSource = typeof PropertyIdentityEvidenceSource.Type

/**
 * A single `.nmd` property descriptor.
 *
 * This bare struct is NOT strict on its own — `Schema.Struct` drops excess
 * properties. {@link decodePropertyDescriptor} (with `onExcessProperty: 'error'`)
 * is the sanctioned fail-closed entry point, rejecting a descriptor with extra
 * (potentially proof-shaped) keys. Any schema composing this one must likewise
 * decode with `onExcessProperty: 'error'`.
 */
export const PropertyDescriptor = Schema.Struct({
  property_id: PropertyId,
  property_name: PropertyName,
  property_type: NotionPropertyType,
  data_source_id: DataSourceId,
  config_hash: ConfigHash,
}).annotate({ identifier: 'Notion.PropertyDescriptor' })
export type PropertyDescriptor = typeof PropertyDescriptor.Type

/**
 * The `.nmd` `property_descriptors` map, keyed by the user-facing property name.
 * The key is the visible field name; the descriptor inside carries the stable
 * `property_id` the field claims to edit.
 *
 * The schema deliberately does NOT enforce that the map key equals the inner
 * `property_name`: display-name vs property-id disambiguation is resolved by the
 * Phase 3 proof provider against fresh remote schema (spec.md ~207), not at this
 * schema layer. Decode via {@link decodePropertyDescriptors} to stay fail-closed.
 */
export const PropertyDescriptors = Schema.Record({
  key: PropertyName,
  value: PropertyDescriptor,
}).annotate({ identifier: 'Notion.PropertyDescriptors' })
export type PropertyDescriptors = typeof PropertyDescriptors.Type

/**
 * Decode an unknown value as a {@link PropertyDescriptor}, rejecting unknown
 * fields. Use this entry point rather than a bare `Schema.decode` so callers
 * cannot accidentally accept excess (proof-shaped) keys.
 */
export const decodePropertyDescriptor = Schema.decodeUnknown(PropertyDescriptor, {
  onExcessProperty: 'error',
})

/** Decode an unknown value as a {@link PropertyDescriptors} map, rejecting unknown descriptor fields. */
export const decodePropertyDescriptors = Schema.decodeUnknown(PropertyDescriptors, {
  onExcessProperty: 'error',
})

const encodePropertyDescriptor = Schema.encodeSync(PropertyDescriptor)

/**
 * Canonical JSON bytes for a decoded {@link PropertyDescriptor}, suitable as a
 * reproducible hash input for higher layers.
 *
 * Follows this package's hashing contract (see `canonical.ts` and
 * `canonical-codec.ts`): schema-encode to fix struct field order, then plain
 * `JSON.stringify` — no recursive key sort. The descriptor's deterministic field
 * order comes from the schema, so the bytes are stable regardless of input key
 * insertion order. The hash itself is computed by higher layers; this package
 * only fixes the byte layout they hash.
 */
export const canonicalPropertyDescriptorJson = (descriptor: PropertyDescriptor): string =>
  JSON.stringify(encodePropertyDescriptor(descriptor))
