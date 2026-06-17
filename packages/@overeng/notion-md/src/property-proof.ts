/**
 * Standalone live proof provider for datasource-scoped property writes.
 *
 * notion-md is the *local* (standalone) entrypoint: it edits a single `.nmd`
 * page file and pushes property changes through `properties.update`. When that
 * page is a member of a Notion data source, a property write is only safe under
 * the same invariants the shared property-write core enforces (stable identity,
 * fresh schema, writable class, complete base surface, available relation
 * targets). This module is the notion-md proof *provider*: it re-reads the live
 * data-source schema and the live page, gathers that evidence into a
 * {@link PropertyWriteProof} (hashes and verdicts only — never live handles),
 * and hands it plus the {@link DesiredPropertyWrite} to the pure
 * `evaluatePropertyWrite` core. The core, not this provider, decides allow/block.
 *
 * Mode is always `local`: this provider never produces a `shared` proof (that is
 * the datasource-sync workspace provider's job) and *refuses* to mint a proof
 * for a `source: 'remote'` page — a local property mutation against a
 * Notion-authoritative page is drift, surfaced upstream as
 * {@link NmdPropertyWriteBlockedError} rather than silently written.
 *
 * Because the local entrypoint has no settlement context and re-reads the live
 * remote directly, two proof fields are constant: `localConvergence` is
 * `not-applicable` (there is no separate local replica surface to disagree with)
 * and `settlement` is `not-required` (no read-after-write settlement record is
 * maintained locally).
 *
 * SCOPE (sub-milestone 3b): whole-schema staleness is observable when the
 * sidecar carries the data-source binding hash. The provider always computes
 * `observedSchemaHash` from the freshly re-read live schema using the same
 * writable-schema projection as the sidecar data-source binding, and threads
 * `expectedSchemaHash` only when the sidecar supplies it. Config drift and
 * relation-target completeness are still not observable here, so
 * `observedConfigHash` remains omitted and relation availability stays
 * conservative until Phase 8.
 *
 * @module
 */

import { Effect } from 'effect'

import { isNotionPropertyType } from '@overeng/notion-core'
import type { NmdWritablePropertyValue, NmdSource } from '@overeng/notion-effect-client'
import {
  type CanonicalPropertyValue,
  ConfigHash,
  DataSourceId,
  type NotionPropertyType,
  PageId,
  PropertyId,
  PropertyName,
  SchemaHash,
  propertyWriteClassFromType,
} from '@overeng/notion-effect-schema'
import {
  type DesiredPropertyWrite,
  type PropertyWriteProof,
  evaluatePropertyWrite,
  type PropertyWriteGuardDecision,
} from '@overeng/notion-property-write'

import { NmdPropertyWriteBlockedError } from './errors.ts'
import { NotionMdGateway, type RemoteDataSourceSchema } from './model.ts'
import { writableSchemaHash } from './schema-snapshot.ts'

/**
 * A single live property-schema entry as Notion returns it on a data source.
 * Only the stable-identity fields the proof needs are read (`id`/`name`/`type`);
 * the property's type-specific config is not consumed at this layer (config
 * identity comes from the `.nmd` descriptor, never recomputed here — see the
 * schema-consistency note in {@link buildStandaloneLiveProof}).
 */
interface LiveSchemaProperty {
  readonly id: string
  readonly name: string
  readonly type: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readSchemaProperty = (value: unknown): LiveSchemaProperty | undefined => {
  if (isRecord(value) === false) return undefined
  const { id, name, type } = value
  if (typeof id !== 'string' || typeof name !== 'string' || typeof type !== 'string') {
    return undefined
  }
  return { id, name, type }
}

/**
 * The canonical-value `_tag` notion-md's writable property union maps to. The
 * core only inspects the tag (it checks the tag fits the property type), so the
 * provider does not build a full canonical value — just a minimal tagged struct
 * whose `_tag` is faithful. `place` and `verification` have no canonical-union
 * member; they are non-writable (`verification` is computed, `place` is an
 * unrecognized type → unsupported) and the core blocks them by write class /
 * tag-fit, so a placeholder `empty` tag here is never the deciding signal.
 */
const desiredValueForWritable = (property: NmdWritablePropertyValue): CanonicalPropertyValue => {
  switch (property._tag) {
    case 'title':
      return { _tag: 'title', plainText: property.value }
    case 'rich_text':
      return { _tag: 'rich_text', plainText: property.value ?? '' }
    case 'number':
      return property.value === null ? { _tag: 'empty' } : { _tag: 'number', value: property.value }
    case 'checkbox':
      return { _tag: 'checkbox', checked: property.value }
    case 'select':
      return property.value === null
        ? { _tag: 'select', option: null }
        : {
            _tag: 'select',
            option: { _tag: 'CanonicalOptionValue', name: PropertyName.make(property.value) },
          }
    case 'multi_select':
      return {
        _tag: 'multi_select',
        options: property.value.map((name) => ({
          _tag: 'CanonicalOptionValue' as const,
          name: PropertyName.make(name),
        })),
      }
    case 'status':
      return property.value === null
        ? { _tag: 'status', option: null }
        : {
            _tag: 'status',
            option: { _tag: 'CanonicalOptionValue', name: PropertyName.make(property.value) },
          }
    case 'relation':
      return { _tag: 'relation', pageIds: property.value.map((id) => PageId.make(id)) }
    case 'people':
      return { _tag: 'people', userIds: [...property.value] }
    case 'email':
      return { _tag: 'email', value: property.value }
    case 'url':
      return { _tag: 'url', value: property.value }
    case 'phone_number':
      return { _tag: 'phone_number', value: property.value }
    case 'date':
    case 'files':
    case 'place':
    case 'verification':
      /*
       * Two distinct reasons converge on the same `empty` placeholder, both safe
       * because the core only reads the value's `_tag` (the tag-vs-type fit
       * check), never the payload:
       *
       * - WRITABLE-BUT-PLACEHOLDER (`date`/`files`): these ARE writable and the
       *   write proceeds, but their canonical shapes (`DateTimeUtc`,
       *   identity-hashed files) are not reconstructed here — the core never
       *   inspects them, so a placeholder tag is sufficient. (Faithful value
       *   reconstruction, if ever needed, would go through the canonical codec.)
       * - BLOCKED-BEFORE-IT-MATTERS (`place`/`verification`): not in the
       *   canonical union and non-writable by class (`verification` is computed,
       *   `place` is an unrecognized type → unsupported), so the core blocks them
       *   at the write-class check before the value tag is ever consulted.
       */
      return { _tag: 'empty' }
  }
}

/** Inputs to the pure proof builder — already-fetched live snapshots. */
export interface StandaloneProofInputs {
  readonly pageId: string
  readonly dataSourceId: string
  readonly propertyName: string
  readonly property: NmdWritablePropertyValue
  /** Live data-source schema (re-read fresh). */
  readonly schema: RemoteDataSourceSchema
  /** Live page property bag (re-read fresh), keyed by property name. */
  readonly livePageProperties: Record<string, unknown>
  /** Optional `.nmd` descriptor for this property (the authored config identity). */
  readonly descriptor?: {
    readonly property_id: string
    readonly config_hash: string
  }
  /** Optional whole-schema identity from the sidecar data-source binding. */
  readonly expectedSchemaHash?: string
}

/**
 * Build the `{ proof, desiredWrite }` pair for one datasource-scoped property
 * write from already-fetched live snapshots. Pure: no IO. The proof and the
 * desired write are built for the SAME `(dataSourceId, propertyId)` pair — the
 * `propertyId` is resolved once and threaded into both, so a mismatch cannot
 * slip through.
 *
 * Returns `undefined` when the property name does not resolve to any live schema
 * property at all (the display name is unknown): the caller treats that as an
 * ambiguous/absent identity and blocks. When the name resolves, identity
 * disambiguation is encoded in the proof (`displayNameUnambiguous`).
 */
export const buildStandaloneLiveProof = (
  inputs: StandaloneProofInputs,
):
  | { readonly proof: PropertyWriteProof; readonly desiredWrite: DesiredPropertyWrite }
  | undefined => {
  const schemaProps = Object.values(inputs.schema.properties)
    .map(readSchemaProperty)
    .filter((p): p is LiveSchemaProperty => p !== undefined)

  /*
   * Resolve the target property by visible name against the FRESH schema. A name
   * that maps to zero properties is unresolvable; a name that maps to more than
   * one is ambiguous. Either way the proof carries the disambiguation verdict so
   * the core blocks with `PropertyIdentityAmbiguous`.
   */
  const matches = schemaProps.filter((p) => p.name === inputs.propertyName)
  const resolved = matches[0]
  if (resolved === undefined) return undefined

  const displayNameUnambiguous = matches.length === 1
  const propertyId = PropertyId.make(resolved.id)

  /*
   * Whole-schema staleness is observable when the sidecar carries
   * `data_source.schema_hash`: compare it with the live schema hash computed via
   * the same writable-schema projection the sidecar binding uses. Color-only
   * option changes and other non-write-affecting display fields do not block a
   * property write; renames, writable type changes, and option-name changes do.
   * Config staleness remains only half-observable: the descriptor carries the
   * authored `config_hash`, but this layer does not yet recompute an observed
   * per-property config hash, so check 5 still skips honestly.
   */
  const observedSchemaHash = SchemaHash.make(writableSchemaHash(inputs.schema.properties))
  const expectedSchemaHash =
    inputs.expectedSchemaHash === undefined ? undefined : SchemaHash.make(inputs.expectedSchemaHash)
  const expectedConfigHash =
    inputs.descriptor !== undefined ? ConfigHash.make(inputs.descriptor.config_hash) : undefined

  const writeClass = propertyWriteClassFromType(resolved.type)
  /*
   * The proof's `propertyType` is the schema-typed `NotionPropertyType`. An
   * unrecognized live type (e.g. `place`) is not a member; it is already
   * `unsupported` by write class, so the core blocks it at the write-class check
   * before `propertyType` is read for tag-fit. Fall back to the desired value's
   * tag only to keep `propertyType` decodable in that unreachable-for-allow case.
   */
  const propertyType: NotionPropertyType =
    isNotionPropertyType(resolved.type) === true ? resolved.type : 'rich_text'

  const desiredValue = desiredValueForWritable(inputs.property)

  /*
   * Base completeness: the live page must actually expose this property's value
   * surface. If the live page omits the property entirely, the base is
   * incomplete (the write would target an unmaterialized surface). This relies on
   * Notion keying a page's `properties` bag by the property's DISPLAY NAME (the
   * same key the data-source schema resolves above), not by `property_id` — both
   * the live page and the schema are keyed by name, so `resolved.name` is the
   * correct lookup key on each.
   *
   * TODO(phase-8-live-l6): relation-target completeness (verifying each related
   * page id exists and its data source is shared) is conservatively reported as
   * `all-available`/`not-applicable` here; the live cross-data-source check
   * lands in Phase 8.
   */
  const surfaceComplete = Object.prototype.hasOwnProperty.call(
    inputs.livePageProperties,
    resolved.name,
  )

  const relationStatus: PropertyWriteProof['relationAvailability']['status'] =
    resolved.type === 'relation' ? 'all-available' : 'not-applicable'

  const proof: PropertyWriteProof = {
    mode: 'local',
    dataSourceId: DataSourceId.make(inputs.dataSourceId),
    identity: {
      propertyId,
      resolvedName: PropertyName.make(resolved.name),
      evidenceSource:
        inputs.descriptor !== undefined ? { _tag: 'descriptor' } : { _tag: 'live_schema' },
      displayNameUnambiguous,
    },
    schemaConsistency: {
      remoteSchemaObserved: true,
      observedSchemaHash,
      ...(expectedSchemaHash !== undefined ? { expectedSchemaHash } : {}),
      ...(expectedConfigHash !== undefined ? { expectedConfigHash } : {}),
      propertyType,
      writeClass,
    },
    baseCompleteness: { surfaceComplete },
    relationAvailability: { status: relationStatus },
    localConvergence: { status: 'not-applicable' },
    settlement: { status: 'not-required' },
  }

  const desiredWrite: DesiredPropertyWrite = {
    propertyId,
    dataSourceId: DataSourceId.make(inputs.dataSourceId),
    value: desiredValue,
  }

  return { proof, desiredWrite }
}

/**
 * Re-read the live data-source schema + page and evaluate one datasource-scoped
 * property write through the shared core. Resolves to the core's decision; the
 * caller decides how to surface a block (typically {@link NmdPropertyWriteBlockedError}).
 *
 * Refuses (fails with {@link NmdPropertyWriteBlockedError}) when `source` is
 * `'remote'`: a local property mutation against a Notion-authoritative page is
 * drift, surfaced rather than written.
 */
export const makeStandaloneLiveProof = (args: {
  readonly pageId: string
  readonly dataSourceId: string
  readonly source: NmdSource
  readonly propertyName: string
  readonly property: NmdWritablePropertyValue
  /** Authored property identity from the `.nmd` descriptor, when present. */
  readonly descriptor?: { readonly property_id: string; readonly config_hash: string }
  /** Authored whole-schema identity from the sidecar data-source binding, when present. */
  readonly expectedSchemaHash?: string
}): Effect.Effect<PropertyWriteGuardDecision, NmdPropertyWriteBlockedError, NotionMdGateway> =>
  Effect.gen(function* () {
    if (args.source === 'remote') {
      return yield* new NmdPropertyWriteBlockedError({
        page_id: args.pageId,
        property_name: args.propertyName,
        guard: 'RemoteAuthoritativeDrift',
        message: `Refusing local property write to ${args.propertyName}: page ${args.pageId} is source: remote (Notion authoritative); a local mutation would be drift`,
      })
    }

    const gateway = yield* NotionMdGateway
    const schema = yield* gateway.retrieveDataSource({ dataSourceId: args.dataSourceId })
    const page = yield* gateway.pullPage({ pageId: args.pageId })

    const built = buildStandaloneLiveProof({
      pageId: args.pageId,
      dataSourceId: args.dataSourceId,
      propertyName: args.propertyName,
      property: args.property,
      schema,
      livePageProperties: page.page.properties,
      ...(args.descriptor !== undefined ? { descriptor: args.descriptor } : {}),
      ...(args.expectedSchemaHash !== undefined
        ? { expectedSchemaHash: args.expectedSchemaHash }
        : {}),
    })

    if (built === undefined) {
      /*
       * The display name resolves to no live schema property — an unresolvable
       * identity. Surface it as the same ambiguous-identity refusal the core
       * would mint, since no proof can be built.
       */
      const decision: PropertyWriteGuardDecision = {
        _tag: 'blocked',
        guard: 'PropertyIdentityAmbiguous',
        message: `Property ${args.propertyName} does not resolve to any property in the live data-source schema`,
      }
      return decision
    }

    return evaluatePropertyWrite(built.proof, built.desiredWrite)
  }).pipe(
    Effect.catchTag(
      'NmdGatewayError',
      (cause) =>
        /*
         * A gateway failure while gathering proof evidence is not a guard block;
         * re-surface it as a blocked refusal so a property write is never silently
         * attempted on unverified evidence.
         */
        new NmdPropertyWriteBlockedError({
          page_id: args.pageId,
          property_name: args.propertyName,
          guard: 'RemoteSchemaRequired',
          message: `Failed to gather property-write proof for ${args.propertyName}: ${cause.message}`,
        }),
    ),
  )
