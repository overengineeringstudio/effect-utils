import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import type { NmdWritablePropertyValue } from '@overeng/notion-effect-client'
import { evaluatePropertyWrite } from '@overeng/notion-property-write'

import {
  NotionMdGateway,
  type NotionMdGatewayShape,
  type PullPageResult,
  type RemoteDataSourceSchema,
} from './model.ts'
import { buildStandaloneLiveProof, makeStandaloneLiveProof } from './property-proof.ts'

const dataSourceId = '00000000-0000-4000-8000-0000000000ds'
const pageId = '00000000-0000-4000-8000-000000000001'
const configHash = `sha256:${'b'.repeat(64)}`

/** A live data-source schema with a single writable `Status` select property. */
const statusSchema: RemoteDataSourceSchema = {
  id: dataSourceId,
  properties: {
    Status: { id: 'prop_status', name: 'Status', type: 'select', select: { options: [] } },
  },
}

/** A live page that materializes the `Status` property surface. */
const livePageProperties: Record<string, unknown> = {
  Status: { id: 'prop_status', type: 'select', select: { name: 'Ready' } },
}

const selectValue = (value: string | null): NmdWritablePropertyValue => ({ _tag: 'select', value })

/** Evaluate a built proof for the `Status` select write, returning the decision. */
const evaluateStatus = (opts: {
  readonly schema?: RemoteDataSourceSchema
  readonly livePageProperties?: Record<string, unknown>
  readonly property?: NmdWritablePropertyValue
  readonly descriptor?: { readonly property_id: string; readonly config_hash: string }
}) => {
  const built = buildStandaloneLiveProof({
    pageId,
    dataSourceId,
    propertyName: 'Status',
    property: opts.property ?? selectValue('Ready'),
    schema: opts.schema ?? statusSchema,
    livePageProperties: opts.livePageProperties ?? livePageProperties,
    ...(opts.descriptor !== undefined ? { descriptor: opts.descriptor } : {}),
  })
  expect(built, 'expected the proof builder to resolve the property').toBeDefined()
  return evaluatePropertyWrite(built!.proof, built!.desiredWrite)
}

describe('buildStandaloneLiveProof — proof shape', () => {
  it('mints a local-mode proof with not-applicable convergence and not-required settlement', () => {
    const built = buildStandaloneLiveProof({
      pageId,
      dataSourceId,
      propertyName: 'Status',
      property: selectValue('Ready'),
      schema: statusSchema,
      livePageProperties,
    })
    expect(built).toBeDefined()
    expect(built!.proof.mode).toBe('local')
    expect(built!.proof.localConvergence.status).toBe('not-applicable')
    expect(built!.proof.settlement.status).toBe('not-required')
    expect(built!.proof.schemaConsistency.remoteSchemaObserved).toBe(true)
  })

  it('builds the proof and the desired write for the SAME (dataSourceId, propertyId) pair', () => {
    const built = buildStandaloneLiveProof({
      pageId,
      dataSourceId,
      propertyName: 'Status',
      property: selectValue('Ready'),
      schema: statusSchema,
      livePageProperties,
    })
    expect(built).toBeDefined()
    expect(built!.desiredWrite.propertyId).toBe(built!.proof.identity.propertyId)
    expect(built!.desiredWrite.dataSourceId).toBe(built!.proof.dataSourceId)
    expect(built!.proof.identity.propertyId).toBe('prop_status')
  })

  it('omits all unprovable hashes — no schema-hash oracle at the standalone layer', () => {
    const sc = buildStandaloneLiveProof({
      pageId,
      dataSourceId,
      propertyName: 'Status',
      property: selectValue('Ready'),
      schema: statusSchema,
      livePageProperties,
    })!.proof.schemaConsistency
    // No fabrication: the staleness inputs are absent rather than invented.
    expect(sc.observedSchemaHash).toBeUndefined()
    expect(sc.observedConfigHash).toBeUndefined()
    expect(sc.expectedSchemaHash).toBeUndefined()
    // No descriptor here, so expectedConfigHash is omitted too.
    expect(sc.expectedConfigHash).toBeUndefined()
  })

  it('fills expectedConfigHash ONLY from the descriptor (the honest authored value)', () => {
    const sc = buildStandaloneLiveProof({
      pageId,
      dataSourceId,
      propertyName: 'Status',
      property: selectValue('Ready'),
      schema: statusSchema,
      livePageProperties,
      descriptor: { property_id: 'prop_status', config_hash: configHash },
    })!.proof.schemaConsistency
    expect(sc.expectedConfigHash).toBe(configHash)
    // Observed side is still omitted, so check 5 (SchemaDriftAffectsIntent) skips.
    expect(sc.observedConfigHash).toBeUndefined()
    expect(sc.expectedSchemaHash).toBeUndefined()
  })
})

describe('evaluatePropertyWrite via standalone provider — allow path', () => {
  it('allows a writable, type-matching, complete property write', () => {
    expect(evaluateStatus({})).toEqual({ _tag: 'allowed' })
  })

  it('allows a descriptor-bound write — the observed side is omitted so check 5 skips', () => {
    // A descriptor supplies expectedConfigHash, but the standalone layer has no
    // observedConfigHash to compare it against, so SchemaDriftAffectsIntent
    // honestly skips (no fabricated equality). The write is allowed.
    expect(
      evaluateStatus({ descriptor: { property_id: 'prop_status', config_hash: configHash } }),
    ).toEqual({ _tag: 'allowed' })
  })
})

describe('evaluatePropertyWrite via standalone provider — block paths', () => {
  it('blocks PropertyIdentityAmbiguous when the display name maps to two properties', () => {
    const ambiguousSchema: RemoteDataSourceSchema = {
      id: dataSourceId,
      properties: {
        a: { id: 'prop_a', name: 'Status', type: 'select' },
        b: { id: 'prop_b', name: 'Status', type: 'select' },
      },
    }
    const decision = evaluateStatus({ schema: ambiguousSchema })
    expect(decision._tag).toBe('blocked')
    expect(decision._tag === 'blocked' && decision.guard).toBe('PropertyIdentityAmbiguous')
  })

  it('blocks ComputedPropertyWrite for a computed (verification) write class', () => {
    const computedSchema: RemoteDataSourceSchema = {
      id: dataSourceId,
      properties: { Status: { id: 'prop_status', name: 'Status', type: 'verification' } },
    }
    const decision = evaluateStatus({ schema: computedSchema })
    expect(decision._tag).toBe('blocked')
    expect(decision._tag === 'blocked' && decision.guard).toBe('ComputedPropertyWrite')
  })

  it('blocks UnsupportedRemoteShape for an unrecognized (button) write class', () => {
    const unsupportedSchema: RemoteDataSourceSchema = {
      id: dataSourceId,
      properties: { Status: { id: 'prop_status', name: 'Status', type: 'button' } },
    }
    const decision = evaluateStatus({ schema: unsupportedSchema })
    expect(decision._tag).toBe('blocked')
    expect(decision._tag === 'blocked' && decision.guard).toBe('UnsupportedRemoteShape')
  })

  it('blocks PropertyValueIncomplete when the live page omits the property surface', () => {
    const decision = evaluateStatus({ livePageProperties: {} })
    expect(decision._tag).toBe('blocked')
    expect(decision._tag === 'blocked' && decision.guard).toBe('PropertyValueIncomplete')
  })

  it('blocks UnavailableRelationTarget is reserved for Phase 8 — relation writes are allowed today', () => {
    // Relation availability is conservatively `all-available` until the live
    // cross-data-source completeness check lands (Phase 8), so a relation write
    // is currently allowed. This documents the intended block site.
    const relationSchema: RemoteDataSourceSchema = {
      id: dataSourceId,
      properties: { Rel: { id: 'prop_rel', name: 'Rel', type: 'relation' } },
    }
    const built = buildStandaloneLiveProof({
      pageId,
      dataSourceId,
      propertyName: 'Rel',
      property: { _tag: 'relation', value: [] },
      schema: relationSchema,
      livePageProperties: { Rel: { id: 'prop_rel', type: 'relation', relation: [] } },
    })
    expect(built).toBeDefined()
    expect(built!.proof.relationAvailability.status).toBe('all-available')
    // The block itself is exercised by the pure core's own unit tests; here we
    // assert the provider fills the field so the Phase 8 oracle can flip it.
  })
})

const fakeGateway = (opts: {
  readonly schema: RemoteDataSourceSchema
  readonly page: Record<string, unknown>
  readonly onRetrieve?: () => void
}): NotionMdGatewayShape => ({
  pullPage: () =>
    Effect.succeed({
      page: {
        id: pageId,
        title: 'Untitled',
        title_property_key: 'Name',
        url: undefined,
        parent: { type: 'data_source_id', data_source_id: dataSourceId },
        icon: null,
        cover: null,
        in_trash: false,
        is_locked: false,
        last_edited_time: '2026-06-15T00:00:00.000Z',
        properties: opts.page,
      },
      markdown: { markdown: '', truncated: false, unknown_block_ids: [] },
    } satisfies PullPageResult),
  updateMarkdown: () => Effect.die('updateMarkdown not used'),
  updatePageProperties: () => Effect.die('updatePageProperties not used'),
  updatePageMetadata: () => Effect.die('updatePageMetadata not used'),
  retrieveDataSource: ({ dataSourceId: id }) =>
    Effect.sync(() => {
      opts.onRetrieve?.()
      return { id, properties: opts.schema.properties }
    }),
  listChildPages: () => Effect.succeed([]),
  createPage: () => Effect.die('createPage not used'),
  movePage: () => Effect.die('movePage not used'),
  archivePage: () => Effect.die('archivePage not used'),
})

describe('makeStandaloneLiveProof — Effect provider', () => {
  it('refuses to mint a proof under a source: remote page (Notion authoritative drift)', async () => {
    let retrieved = false
    const layer = Layer.succeed(
      NotionMdGateway,
      fakeGateway({
        schema: statusSchema,
        page: livePageProperties,
        onRetrieve: () => {
          retrieved = true
        },
      }),
    )
    const exit = await Effect.runPromiseExit(
      makeStandaloneLiveProof({
        pageId,
        dataSourceId,
        source: 'remote',
        propertyName: 'Status',
        property: selectValue('Ready'),
      }).pipe(Effect.provide(layer)),
    )
    expect(exit._tag).toBe('Failure')
    // The refusal short-circuits before any live read.
    expect(retrieved).toBe(false)
  })

  it('re-reads live schema + page and allows a writable local property write', async () => {
    const layer = Layer.succeed(
      NotionMdGateway,
      fakeGateway({ schema: statusSchema, page: livePageProperties }),
    )
    const decision = await Effect.runPromise(
      makeStandaloneLiveProof({
        pageId,
        dataSourceId,
        source: 'local',
        propertyName: 'Status',
        property: selectValue('Ready'),
      }).pipe(Effect.provide(layer)),
    )
    expect(decision).toEqual({ _tag: 'allowed' })
  })

  it('surfaces a blocked decision (PropertyValueIncomplete) when the live page omits the surface', async () => {
    const layer = Layer.succeed(NotionMdGateway, fakeGateway({ schema: statusSchema, page: {} }))
    const decision = await Effect.runPromise(
      makeStandaloneLiveProof({
        pageId,
        dataSourceId,
        source: 'local',
        propertyName: 'Status',
        property: selectValue('Ready'),
      }).pipe(Effect.provide(layer)),
    )
    expect(decision._tag).toBe('blocked')
    expect(decision._tag === 'blocked' && decision.guard).toBe('PropertyValueIncomplete')
  })

  it('blocks an unresolvable display name as PropertyIdentityAmbiguous', async () => {
    const layer = Layer.succeed(
      NotionMdGateway,
      fakeGateway({ schema: { id: dataSourceId, properties: {} }, page: {} }),
    )
    const decision = await Effect.runPromise(
      makeStandaloneLiveProof({
        pageId,
        dataSourceId,
        source: 'local',
        propertyName: 'Status',
        property: selectValue('Ready'),
      }).pipe(Effect.provide(layer)),
    )
    expect(decision._tag).toBe('blocked')
    expect(decision._tag === 'blocked' && decision.guard).toBe('PropertyIdentityAmbiguous')
  })
})

/*
 * TODO(phase-8-live-l6): Full live L6 coverage — observing a STALE remote schema
 * (observed schema/config hash diverging from an independently authored
 * expectation) and proving relation-target completeness against the related
 * data source — requires creating real Notion objects and lands in Phase 8. The
 * StaleRemoteSchema / SchemaDriftAffectsIntent / UnavailableRelationTarget /
 * RelatedDataSourceUnshared guard blocks are exercised by the pure core's own
 * unit tests in @overeng/notion-property-write today; the standalone provider
 * fills the corresponding proof fields conservatively until Phase 8 flips them.
 */
