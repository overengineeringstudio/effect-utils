/**
 * Property-write guard vocabulary and decision shape.
 *
 * These names are the ordered safety invariants {@link evaluatePropertyWrite}
 * enforces. Four are new to this package (`RemoteSchemaRequired`,
 * `PropertyIdentityAmbiguous`, `StaleRemoteSchema`, `LocalSurfaceDisagreement`);
 * the rest reuse the existing datasource-sync guard names verbatim. The
 * datasource-sync `GuardName` literal is composed as a superset of
 * {@link propertyWriteGuardNames} in sub-milestone 3c, so a
 * {@link PropertyWriteGuardDecision} is structurally assignable to its
 * `GuardDecision` (same `{ _tag }` shape) with no mapping. This package
 * deliberately does NOT import from datasource-sync (entrypoint-neutrality).
 *
 * @module
 */

import { Schema } from 'effect'

/**
 * The exhaustive set of property-write guard names, in no particular order.
 *
 * Order of *evaluation* is owned by {@link evaluatePropertyWrite} in `core.ts`;
 * this array is the identity set used to build the {@link PropertyWriteGuardName}
 * literal and (in 3c) to compose the datasource-sync superset.
 */
export const propertyWriteGuardNames = [
  // New to this package.
  'RemoteSchemaRequired',
  'PropertyIdentityAmbiguous',
  'StaleRemoteSchema',
  'LocalSurfaceDisagreement',
  /*
   * PROVIDER-emitted, not core-emitted. The pure {@link evaluatePropertyWrite}
   * core never returns this name — it is reserved for a proof provider that
   * refuses to mint a proof at all because the page is Notion-authoritative
   * (`source: 'remote'`), where a local property mutation is drift. Belongs to
   * the shared vocabulary so provider refusals type-check against the same
   * {@link PropertyWriteGuardName} literal as core decisions.
   */
  'RemoteAuthoritativeDrift',
  // Reused from the datasource-sync guard vocabulary.
  'ComputedPropertyWrite',
  'UnsupportedRemoteShape',
  'SchemaDriftAffectsIntent',
  'PropertyValueIncomplete',
  'UnavailableRelationTarget',
  'RelatedDataSourceUnshared',
  'ReadAfterWriteMismatch',
] as const

/** A single property-write guard name. */
export const PropertyWriteGuardName = Schema.Literals(propertyWriteGuardNames).annotate({
  identifier: 'Notion.PropertyWrite.GuardName',
})
export type PropertyWriteGuardName = typeof PropertyWriteGuardName.Type

/**
 * Tagged-union outcome of a property-write evaluation.
 *
 * `allowed` means the write may proceed; `blocked` carries the violated guard
 * name and a human-readable reason. The shape matches the datasource-sync
 * `GuardDecision` exactly so the planner can push this decision straight into
 * its guard pipeline in 3c.
 */
export const PropertyWriteGuardDecision = Schema.Union(
  [Schema.TaggedStruct('allowed', {}), Schema.TaggedStruct('blocked', {
    guard: PropertyWriteGuardName,
    message: Schema.String,
  })],
).annotate({ identifier: 'Notion.PropertyWrite.GuardDecision' })
export type PropertyWriteGuardDecision = typeof PropertyWriteGuardDecision.Type

/** Constructs the `allowed` decision (the write may proceed). */
export const allowed = (): PropertyWriteGuardDecision => ({ _tag: 'allowed' })

/** Constructs a `blocked` decision with the given guard name and reason message. */
export const blocked = ({
  guard,
  message,
}: {
  readonly guard: PropertyWriteGuardName
  readonly message: string
}): PropertyWriteGuardDecision => ({
  _tag: 'blocked',
  guard,
  message,
})
