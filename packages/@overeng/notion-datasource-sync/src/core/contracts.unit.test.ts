import { Effect, Schema, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  CapabilityPreflightInput,
  DataSourceSnapshot,
  DataSourceId,
  EventFamily,
  Hash,
  NotionApiContract,
  NotionDataSourceGateway,
  NotionRequestId,
  PageSnapshot,
  PageId,
  PatchPagePropertiesCommand,
  QueryContract,
  QueryRowsPage,
  RemoteWriteCommand,
  SyncGuardError,
  SyncEvent,
  guardApiVersion,
  guardCapabilities,
  shouldAdvanceQueryCheckpoint,
  type NotionDataSourceGatewayShape,
} from '../mod.ts'

const decode = <TSchema extends Schema.Schema.AnyNoContext>(schema: TSchema, value: unknown) =>
  Schema.decodeUnknownSync(schema)(value)

const hash = decode(Hash, `sha256:${'a'.repeat(64)}`)
const requestId = decode(NotionRequestId, 'req-1')
const dataSourceId = decode(DataSourceId, 'data-source-1')
const pageId = decode(PageId, 'page-1')

describe('@overeng/notion-datasource-sync contracts', () => {
  it('decodes the API and query contracts with the supported Notion version', () => {
    const apiContract = decode(NotionApiContract, {
      _tag: 'NotionApiContract',
      apiVersion: '2026-03-11',
      clientVersion: '0.1.0',
      supportedCapabilities: ['data_source_retrieve', 'data_source_query'],
    })

    const queryContract = decode(QueryContract, {
      _tag: 'QueryContract',
      apiVersion: apiContract.apiVersion,
      filter: null,
      sorts: [],
      pageSize: 50,
      highWatermark: null,
      membershipScope: 'all-data-source-rows',
    })

    expect(queryContract.apiVersion).toBe('2026-03-11')
    expect(queryContract.pageSize).toBe(50)
  })

  it('keeps remote write commands as tagged data', () => {
    const command = decode(RemoteWriteCommand, {
      _tag: 'PatchPagePropertiesCommand',
      commandId: 'cmd-1',
      pageId,
      basePropertiesHash: hash,
      propertyPatch: {
        title: { _tag: 'title', plainText: 'Updated' },
      },
    })

    expect(command._tag).toBe('PatchPagePropertiesCommand')
    expect(command.pageId).toBe(pageId)
    expect(decode(PatchPagePropertiesCommand, command).basePropertiesHash).toBe(hash)
  })

  it('surfaces pure guard decisions for version, capabilities, and checkpoint completeness', () => {
    expect(guardApiVersion('2026-03-11')).toEqual({ _tag: 'allowed' })
    expect(guardApiVersion('2022-06-28')).toMatchObject({
      _tag: 'blocked',
      guard: 'ApiVersionUnsupported',
    })
    expect(guardApiVersion('2026-09-03')).toMatchObject({
      _tag: 'blocked',
      guard: 'ApiVersionUnverified',
    })

    expect(
      guardCapabilities({
        required: ['data_source_query', 'schema_update'],
        supported: ['data_source_query'],
      }),
    ).toMatchObject({ _tag: 'blocked', guard: 'CapabilityPreflightFailed' })

    const terminalPage = decode(QueryRowsPage, {
      _tag: 'QueryRowsPage',
      apiVersion: '2026-03-11',
      requestId,
      queryContractHash: hash,
      rows: [],
      nextCursor: null,
      hasMore: false,
      cappedAtLimit: false,
    })

    expect(shouldAdvanceQueryCheckpoint(terminalPage)).toEqual({ _tag: 'allowed' })
  })

  it('rejects guard errors outside the named guard contract', () => {
    expect(() =>
      decode(SyncGuardError, {
        _tag: 'SyncGuardError',
        guard: 'NotARealGuard',
        message: 'unknown guard',
      }),
    ).toThrow()
  })

  it('keeps event family literals aligned with the VRS contract', () => {
    expect(
      [
        'RemoteObserved',
        'CompatibilityChecked',
        'QueryScanRecorded',
        'LocalIntentAccepted',
        'CommandEnqueued',
        'CommandAttempted',
        'CommandSettled',
        'ConflictDetected',
        'ConflictResolved',
        'TombstoneClassified',
        'RepairObserved',
        'StorageMigrated',
      ].map((family) => decode(EventFamily, family)),
    ).toEqual([
      'RemoteObserved',
      'CompatibilityChecked',
      'QueryScanRecorded',
      'LocalIntentAccepted',
      'CommandEnqueued',
      'CommandAttempted',
      'CommandSettled',
      'ConflictDetected',
      'ConflictResolved',
      'TombstoneClassified',
      'RepairObserved',
      'StorageMigrated',
    ])
  })

  it('exports durable event envelopes and keeps absence separate from tombstones', () => {
    const envelope = {
      eventId: 'event-1',
      rootId: 'root-1',
      sequence: '1',
      codecVersion: 'v1',
      family: 'RemoteObserved',
      eventType: 'TombstoneCandidateObserved',
      idempotencyKey: 'candidate:page-1',
      surface: 'page:page-1',
      causedByEventIds: [],
      payloadHash: hash,
      payload: {
        _tag: 'VersionedJson',
        codecVersion: 'v1',
        canonicalJson: '{}',
      },
      observedAt: '2026-05-25T00:00:00.000Z',
    }

    const candidate = decode(SyncEvent, {
      _tag: 'TombstoneCandidateObserved',
      ...envelope,
      pageId,
      reason: 'filtered_absence_not_proof',
    })

    const tombstone = decode(SyncEvent, {
      _tag: 'TombstoneRecorded',
      ...envelope,
      eventId: 'event-2',
      family: 'TombstoneClassified',
      eventType: 'TombstoneRecorded',
      idempotencyKey: 'tombstone:page-1',
      pageId,
      reason: 'moved_out',
    })

    expect(candidate._tag).toBe('TombstoneCandidateObserved')
    expect(tombstone._tag).toBe('TombstoneRecorded')
  })

  it('rejects sync events whose tag does not match the event family', () => {
    const envelope = {
      eventId: 'event-1',
      rootId: 'root-1',
      sequence: '1',
      codecVersion: 'v1',
      family: 'TombstoneClassified',
      eventType: 'TombstoneRecorded',
      idempotencyKey: 'tombstone:page-1',
      surface: 'page:page-1',
      causedByEventIds: [],
      payloadHash: hash,
      payload: {
        _tag: 'VersionedJson',
        codecVersion: 'v1',
        canonicalJson: '{}',
      },
      observedAt: '2026-05-25T00:00:00.000Z',
    }

    expect(() =>
      decode(SyncEvent, {
        _tag: 'TombstoneRecorded',
        ...envelope,
        family: 'RemoteObserved',
        pageId,
        reason: 'moved_out',
      }),
    ).toThrow()

    expect(() =>
      decode(SyncEvent, {
        _tag: 'RemoteWriteSettled',
        ...envelope,
        eventId: 'event-2',
        family: 'ConflictDetected',
        eventType: 'RemoteWriteSettled',
        idempotencyKey: 'settled:cmd-1',
        commandId: 'cmd-1',
        requestId,
        desiredHash: hash,
      }),
    ).toThrow()
  })

  it('can provide the gateway port as an Effect service', async () => {
    const apiContract = decode(NotionApiContract, {
      _tag: 'NotionApiContract',
      apiVersion: '2026-03-11',
      clientVersion: '0.1.0',
      supportedCapabilities: ['data_source_retrieve', 'data_source_query'],
    })

    const gateway: NotionDataSourceGatewayShape = {
      apiContract,
      preflightCapabilities: (input) =>
        Effect.succeed(
          decode(CapabilityPreflightInput, {
            _tag: 'CapabilityPreflightInput',
            dataSourceId: input.dataSourceId,
            requiredCapabilities: input.requiredCapabilities,
          }),
        ).pipe(
          Effect.map((decodedInput) => ({
            _tag: 'CapabilityPreflightResult' as const,
            dataSourceId: decodedInput.dataSourceId,
            apiContract,
            supportedCapabilities: decodedInput.requiredCapabilities,
            missingCapabilities: [],
          })),
        ),
      retrieveDataSource: () =>
        Effect.succeed(
          decode(DataSourceSnapshot, {
            _tag: 'DataSourceSnapshot',
            dataSourceId,
            requestId,
            observedAt: '2026-05-25T00:00:00.000Z',
            schemaHash: hash,
          }),
        ),
      queryRows: () => Stream.empty,
      retrievePage: () =>
        Effect.succeed(
          decode(PageSnapshot, {
            _tag: 'PageSnapshot',
            pageId,
            requestId,
            observedAt: '2026-05-25T00:00:00.000Z',
            propertiesHash: hash,
            inTrash: false,
          }),
        ),
      retrievePageProperty: () => Stream.empty,
      patchPageProperties: () => Effect.succeed(requestId),
      createPage: () =>
        Effect.succeed({
          _tag: 'CreatePageResult' as const,
          requestId,
          pageId,
          propertiesHash: hash,
        }),
      patchDataSourceSchema: () => Effect.succeed(requestId),
      patchDataSourceMetadata: () => Effect.succeed(requestId),
      trashPage: () => Effect.succeed(requestId),
      restorePage: () => Effect.succeed(requestId),
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* NotionDataSourceGateway
        return yield* service.preflightCapabilities({
          _tag: 'CapabilityPreflightInput',
          dataSourceId,
          requiredCapabilities: ['data_source_query'],
        })
      }).pipe(Effect.provideService(NotionDataSourceGateway, gateway)),
    )

    expect(result.missingCapabilities).toEqual([])
    expect(result.supportedCapabilities).toEqual(['data_source_query'])
  })
})
