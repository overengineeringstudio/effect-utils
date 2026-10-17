/**
 * The pure property-write evaluator.
 *
 * {@link evaluatePropertyWrite} is a pure, synchronous function — NOT an Effect.
 * It reads a {@link PropertyWriteProof} (already-gathered hashes and verdicts)
 * top-to-bottom in a pinned order and returns the FIRST blocking decision, or
 * `allowed` if every invariant holds. It performs no IO and does not branch on
 * `proof.mode`: the proof's explicit status literals already encode whatever
 * the provider established per mode.
 *
 * The check order is pinned to the current planner guard order so that wiring
 * this core into the planner (sub-milestone 3c) preserves observable behavior.
 *
 * @module
 */

import type { CanonicalPropertyValue, NotionPropertyType } from '@overeng/notion-effect-schema'

import { allowed, blocked, type PropertyWriteGuardDecision } from './guards.ts'
import type { DesiredPropertyWrite, PropertyWriteProof } from './proof.ts'

/**
 * Whether a {@link CanonicalPropertyValue} `_tag` is a valid value to write into
 * a property of the given Notion {@link NotionPropertyType}.
 *
 * Every concrete writable Notion type has a same-named canonical tag, so the map
 * is 1:1 for those (`title↔title`, `rich_text↔rich_text`, … — `title` and
 * `rich_text` stay distinct). Two tags are special:
 *
 * - `empty` is a clear/unset and is compatible with *any* property type.
 * - `computed` is the value of a read-only property and is compatible with *no*
 *   writable type; a `computed` value reaching this check (its property type is
 *   writable) is an unsupported shape. Computed *types* never reach here — they
 *   are blocked earlier by the write-class check.
 */
const canonicalTagFitsPropertyType = ({
  tag,
  propertyType,
}: {
  readonly tag: CanonicalPropertyValue['_tag']
  readonly propertyType: NotionPropertyType
}): boolean => {
  if (tag === 'empty') {
    return true
  }
  if (tag === 'computed') {
    return false
  }
  return tag === propertyType
}

/**
 * Evaluate a property write against its proof, returning the first blocking
 * guard decision or `allowed`. Pure and synchronous.
 *
 * The checks run in this pinned order (return on first block):
 * 1. remote schema not observed -> `RemoteSchemaRequired`
 * 2. display name ambiguous -> `PropertyIdentityAmbiguous`
 * 3. observed AND expected schema hash both present and differ -> `StaleRemoteSchema`
 * 4. write class computed/unsupported -> `ComputedPropertyWrite`/`UnsupportedRemoteShape`
 * 5. observed AND expected config hash both present and differ -> `SchemaDriftAffectsIntent`
 * 6. value tag incompatible with property type -> `UnsupportedRemoteShape`
 * 7. base surface incomplete -> `PropertyValueIncomplete`
 * 8. relation targets unavailable / related data source unshared
 * 9. local surface disagrees -> `LocalSurfaceDisagreement`
 * 10. required settlement missing -> `ReadAfterWriteMismatch`
 */
export const evaluatePropertyWrite = ({
  proof,
  desiredWrite,
}: {
  readonly proof: PropertyWriteProof
  readonly desiredWrite: DesiredPropertyWrite
}): PropertyWriteGuardDecision => {
  const { identity, schemaConsistency, baseCompleteness, relationAvailability } = proof

  // 1. Datasource-scoped writes require a freshly observed remote schema.
  if (schemaConsistency.remoteSchemaObserved === false) {
    return blocked({
      guard: 'RemoteSchemaRequired',
      message: 'Remote schema must be freshly observed before writing this property',
    })
  }

  // 2. The display name must resolve to exactly one property.
  if (identity.displayNameUnambiguous === false) {
    return blocked({
      guard: 'PropertyIdentityAmbiguous',
      message: 'Property display name is ambiguous; cannot identify the target property',
    })
  }

  // 3. A freshly observed schema hash that disagrees with the authored one is
  //    stale. Gate on BOTH sides being present: a provider with no observed read
  //    or no authored expectation has no comparison to make, so the check skips
  //    rather than fabricating a comparison against a missing hash.
  if (
    schemaConsistency.observedSchemaHash !== undefined &&
    schemaConsistency.expectedSchemaHash !== undefined &&
    schemaConsistency.observedSchemaHash !== schemaConsistency.expectedSchemaHash
  ) {
    return blocked({
      guard: 'StaleRemoteSchema',
      message: 'Observed remote schema hash differs from the authored schema',
    })
  }

  // 4. Computed and unsupported property types cannot be written.
  if (schemaConsistency.writeClass === 'computed') {
    return blocked({
      guard: 'ComputedPropertyWrite',
      message: 'Computed Notion properties cannot be written',
    })
  }
  if (schemaConsistency.writeClass === 'unsupported') {
    return blocked({
      guard: 'UnsupportedRemoteShape',
      message: 'Unsupported property shape cannot be written',
    })
  }

  // 5. A freshly observed config hash that disagrees with the expected one is
  //    drift affecting intent. Gate on BOTH sides being present (same rationale
  //    as check 3): a missing observed read or missing authored config identity
  //    means no comparison, so the check skips.
  if (
    schemaConsistency.observedConfigHash !== undefined &&
    schemaConsistency.expectedConfigHash !== undefined &&
    schemaConsistency.observedConfigHash !== schemaConsistency.expectedConfigHash
  ) {
    return blocked({
      guard: 'SchemaDriftAffectsIntent',
      message: 'Schema drift affects a pending local intent',
    })
  }

  // 6. The desired value's canonical tag must fit the property's type.
  if (
    canonicalTagFitsPropertyType({
      tag: desiredWrite.value._tag,
      propertyType: schemaConsistency.propertyType,
    }) === false
  ) {
    return blocked({
      guard: 'UnsupportedRemoteShape',
      message: 'Desired value shape is incompatible with the property type',
    })
  }

  // 7. The base value surface must be completely materialized.
  if (baseCompleteness.surfaceComplete === false) {
    return blocked({
      guard: 'PropertyValueIncomplete',
      message: 'Property value surface is incomplete',
    })
  }

  // 8. Relation targets must be available and their data source shared.
  if (relationAvailability.status === 'targets-unavailable') {
    return blocked({
      guard: 'UnavailableRelationTarget',
      message: 'Relation target is unavailable',
    })
  }
  if (relationAvailability.status === 'related-data-source-unshared') {
    return blocked({
      guard: 'RelatedDataSourceUnshared',
      message: 'Related data source is not shared',
    })
  }

  // 9. A local surface that disagrees with the observed remote surface blocks the write.
  if (proof.localConvergence.status === 'disagrees') {
    return blocked({
      guard: 'LocalSurfaceDisagreement',
      message: 'Local surface disagrees with the observed remote surface',
    })
  }

  // 10. A required read-after-write settlement must be present.
  if (proof.settlement.status === 'missing') {
    return blocked({
      guard: 'ReadAfterWriteMismatch',
      message: 'Read-after-write settlement is missing',
    })
  }

  return allowed()
}
