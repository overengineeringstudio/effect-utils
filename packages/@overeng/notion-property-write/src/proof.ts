/**
 * Data-only proof that a single Notion property may be safely written.
 *
 * A {@link PropertyWriteProof} carries *hashes and verdicts*, never live
 * handles: it is the structural evidence a higher layer (a proof provider in
 * notion-md or notion-datasource-sync) gathered by re-reading schema and page
 * state. The pure {@link evaluatePropertyWrite} core in `core.ts` reads this
 * proof top-to-bottom and never performs IO itself.
 *
 * Every "when relevant" invariant is encoded as an explicit
 * `not-applicable`/`not-required` literal rather than an optional field, so the
 * core's ordered checks cannot silently skip a missing-but-relevant condition.
 * The two *observed* hashes are genuinely optional: a proof for a fresh-schema
 * write may simply not carry an observed schema/config hash, and the matching
 * checks gate on presence.
 *
 * @module
 */

import { Schema } from 'effect'

import {
  CanonicalPropertyValue,
  ConfigHash,
  DataSourceId,
  NotionPropertyType,
  PropertyId,
  PropertyIdentityEvidenceSource,
  PropertyName,
  PropertyWriteClass,
  SchemaHash,
} from '@overeng/notion-effect-schema'

/**
 * Which entrypoint the proof was gathered under.
 *
 * The core treats `mode` as descriptive only — it does not branch on it. The
 * status literals below already encode the per-mode expectations a provider
 * established (e.g. shared mode sets `settlement: 'present'`, local mode sets
 * `settlement: 'not-required'`).
 */
export const PropertyWriteMode = Schema.Literals(['local', 'remote', 'shared']).annotate({
  identifier: 'Notion.PropertyWrite.Mode',
})
export type PropertyWriteMode = typeof PropertyWriteMode.Type

/** Stable-identity evidence for the property the write targets. */
export const PropertyWriteIdentity = Schema.Struct({
  propertyId: PropertyId,
  resolvedName: PropertyName,
  evidenceSource: PropertyIdentityEvidenceSource,
  /** `false` when the resolved display name maps ambiguously to multiple properties. */
  displayNameUnambiguous: Schema.Boolean,
}).annotate({ identifier: 'Notion.PropertyWrite.Identity' })
export type PropertyWriteIdentity = typeof PropertyWriteIdentity.Type

/**
 * What a fresh read of the remote schema established for this property.
 *
 * All four hashes are optional, and each staleness check gates on *both* sides
 * being present (see `core.ts` checks 3 and 5): a provider compares observed vs
 * expected only when it actually holds both. A standalone provider that has no
 * authored schema/config-hash oracle simply omits the `expected*` hash, and the
 * corresponding check honestly skips rather than fabricating a comparison. A
 * provider with an authored identity but no fresh observation omits the
 * `observed*` hash instead. Drift is asserted only when both are known and differ.
 */
export const PropertyWriteSchemaConsistency = Schema.Struct({
  /** `false` when the data source schema was not freshly observed (datasource-scoped). */
  remoteSchemaObserved: Schema.Boolean,
  observedSchemaHash: Schema.optional(SchemaHash),
  observedConfigHash: Schema.optional(ConfigHash),
  expectedSchemaHash: Schema.optional(SchemaHash),
  expectedConfigHash: Schema.optional(ConfigHash),
  propertyType: NotionPropertyType,
  writeClass: PropertyWriteClass,
}).annotate({ identifier: 'Notion.PropertyWrite.SchemaConsistency' })
export type PropertyWriteSchemaConsistency = typeof PropertyWriteSchemaConsistency.Type

/** Whether the property's current value surface was completely materialized. */
export const PropertyWriteBaseCompleteness = Schema.Struct({
  surfaceComplete: Schema.Boolean,
}).annotate({ identifier: 'Notion.PropertyWrite.BaseCompleteness' })
export type PropertyWriteBaseCompleteness = typeof PropertyWriteBaseCompleteness.Type

/** Availability of relation targets referenced by the write (explicit literal, never optional). */
export const PropertyWriteRelationAvailability = Schema.Struct({
  status: Schema.Literals([
    'not-applicable',
    'all-available',
    'targets-unavailable',
    'related-data-source-unshared',
  ]),
}).annotate({ identifier: 'Notion.PropertyWrite.RelationAvailability' })
export type PropertyWriteRelationAvailability = typeof PropertyWriteRelationAvailability.Type

/** Whether the local surface agrees with the freshly observed remote surface (explicit literal). */
export const PropertyWriteLocalConvergence = Schema.Struct({
  status: Schema.Literals(['not-applicable', 'converged', 'disagrees']),
}).annotate({ identifier: 'Notion.PropertyWrite.LocalConvergence' })
export type PropertyWriteLocalConvergence = typeof PropertyWriteLocalConvergence.Type

/** Whether a required read-after-write settlement is present (explicit literal). */
export const PropertyWriteSettlement = Schema.Struct({
  status: Schema.Literals(['not-required', 'present', 'missing']),
}).annotate({ identifier: 'Notion.PropertyWrite.Settlement' })
export type PropertyWriteSettlement = typeof PropertyWriteSettlement.Type

/**
 * The full property-write proof: hashes and verdicts only, never live handles.
 *
 * This bare struct is NOT strict on its own — `Schema.Struct` drops excess
 * properties. {@link decodePropertyWriteProof} (with `onExcessProperty: 'error'`)
 * is the sanctioned fail-closed entry point, rejecting a proof with extra
 * (potentially handle-shaped) keys.
 */
export const PropertyWriteProof = Schema.Struct({
  mode: PropertyWriteMode,
  dataSourceId: DataSourceId,
  identity: PropertyWriteIdentity,
  schemaConsistency: PropertyWriteSchemaConsistency,
  baseCompleteness: PropertyWriteBaseCompleteness,
  relationAvailability: PropertyWriteRelationAvailability,
  localConvergence: PropertyWriteLocalConvergence,
  settlement: PropertyWriteSettlement,
}).annotate({ identifier: 'Notion.PropertyWrite.Proof' })
export type PropertyWriteProof = typeof PropertyWriteProof.Type

/**
 * The property edit a caller wants to apply.
 *
 * NOT strict on its own; use {@link decodeDesiredPropertyWrite} for the
 * fail-closed entry point.
 */
export const DesiredPropertyWrite = Schema.Struct({
  propertyId: PropertyId,
  dataSourceId: DataSourceId,
  value: CanonicalPropertyValue,
}).annotate({ identifier: 'Notion.PropertyWrite.Desired' })
export type DesiredPropertyWrite = typeof DesiredPropertyWrite.Type

/**
 * Decode an unknown value as a {@link PropertyWriteProof}, rejecting unknown
 * fields. Use this entry point rather than a bare `Schema.decode` so callers
 * cannot accidentally accept excess (handle-shaped) keys.
 */
export const decodePropertyWriteProof = Schema.decodeUnknown(PropertyWriteProof, {
  onExcessProperty: 'error',
})

/** Decode an unknown value as a {@link DesiredPropertyWrite}, rejecting unknown fields. */
export const decodeDesiredPropertyWrite = Schema.decodeUnknown(DesiredPropertyWrite, {
  onExcessProperty: 'error',
})
