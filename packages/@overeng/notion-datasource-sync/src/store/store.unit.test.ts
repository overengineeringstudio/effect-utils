import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Schema } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { propertySurfaceKey } from '../core/canonical.ts'
import { PatchPagePropertiesCommand } from '../core/commands.ts'
import {
  CommandId,
  DataSourceId,
  Hash,
  NotionRequestId,
  PageId,
  PropertyId,
} from '../core/domain.ts'
import {
  IdempotencyKey,
  SyncEvent,
  SyncEventId,
  SyncRootId,
  type SyncEvent as SyncEventType,
} from '../core/events.ts'
import { SignalExternalId, SignalId, SignalProvider } from '../core/signals.ts'
import { planIntent } from '../planner/planner.ts'
import { hashStoreBytes } from './projections.ts'
import { openNotionSyncStore, type NotionSyncStore } from './store.ts'

const decode = <TSchema extends Schema.Schema.AnyNoContext>(schema: TSchema, value: unknown) =>
  Schema.decodeUnknownSync(schema)(value)

const hash = (value: string) => decode(Hash, `sha256:${value.repeat(64).slice(0, 64)}`)
const rootId = decode(SyncRootId, 'root-1')
const otherRootId = decode(SyncRootId, 'root-2')
const pageId = decode(PageId, 'page-1')
const propertyId = decode(PropertyId, 'property-1')
const commandId = decode(CommandId, 'cmd-1')
const intentEventId = decode(SyncEventId, 'intent-1')
const commandKey = decode(IdempotencyKey, 'intent:cmd-1')
const signalProvider = decode(SignalProvider, 'test-provider')
const signalId = decode(SignalId, 'signal-1')
const signalExternalId = decode(SignalExternalId, 'external-1')
const observedAt = '2026-05-25T00:00:00.000Z'
const tmpDirs: string[] = []

const tempDatabasePath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'notion-sync-store-'))
  tmpDirs.push(dir)
  return join(dir, 'sync.sqlite')
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const eventPayload = (canonicalJson: string) => ({
  _tag: 'VersionedJson',
  codecVersion: 'v1',
  canonicalJson,
})

const eventBase = (overrides: {
  readonly eventId: string
  readonly family: SyncEventType['family']
  readonly eventType: SyncEventType['eventType']
  readonly idempotencyKey: string
  readonly canonicalJson?: string
  readonly surface?: string
  readonly rootId?: SyncRootId
}) => {
  const canonicalJson = overrides.canonicalJson ?? '{}'

  return {
    eventId: overrides.eventId,
    rootId: overrides.rootId ?? rootId,
    sequence: '0',
    codecVersion: 'v1',
    family: overrides.family,
    eventType: overrides.eventType,
    idempotencyKey: overrides.idempotencyKey,
    surface: overrides.surface ?? null,
    causedByEventIds: [],
    payloadHash: hash('0'),
    payload: eventPayload(canonicalJson),
    observedAt,
  }
}

const remoteWritePlanned = (overrides: {
  readonly eventId: string
  readonly idempotencyKey: string
  readonly commandId: string
  readonly intentEventId?: string
  readonly desiredHash?: string
  readonly surface?: string
  readonly rootId?: SyncRootId
}) =>
  decode(SyncEvent, {
    _tag: 'RemoteWritePlanned',
    ...eventBase({
      eventId: overrides.eventId,
      family: 'CommandEnqueued',
      eventType: 'RemoteWritePlanned',
      idempotencyKey: overrides.idempotencyKey,
      canonicalJson: `{"commandId":"${overrides.commandId}"}`,
      surface: overrides.surface ?? 'page:page-1',
      ...(overrides.rootId === undefined ? {} : { rootId: overrides.rootId }),
    }),
    commandId: overrides.commandId,
    commandKey: overrides.idempotencyKey,
    intentEventId: overrides.intentEventId ?? 'intent-1',
    commandTag: 'PatchPageProperties',
    baseHash: hash('a'),
    desiredHash: overrides.desiredHash ?? hash('b'),
    preflight: ['StaleSurfaceBase'],
  })

const remoteWriteAttempted = (overrides: {
  readonly eventId: string
  readonly idempotencyKey: string
  readonly commandId: string
  readonly attempt?: number
  readonly attemptState: 'running' | 'retryable' | 'blocked' | 'fenced' | 'ambiguous'
  readonly leaseToken?: string
  readonly rootId?: SyncRootId
}) =>
  decode(SyncEvent, {
    _tag: 'RemoteWriteAttempted',
    ...eventBase({
      eventId: overrides.eventId,
      family: 'CommandAttempted',
      eventType: 'RemoteWriteAttempted',
      idempotencyKey: overrides.idempotencyKey,
      canonicalJson: `{"attempt":"${overrides.eventId}"}`,
      surface: 'page:page-1',
      ...(overrides.rootId === undefined ? {} : { rootId: overrides.rootId }),
    }),
    commandId: overrides.commandId,
    attempt: overrides.attempt ?? 1,
    attemptState: overrides.attemptState,
    ...(overrides.leaseToken === undefined ? {} : { leaseToken: overrides.leaseToken }),
  })

const remoteWriteSettled = (overrides: {
  readonly eventId: string
  readonly idempotencyKey: string
  readonly commandId: string
  readonly desiredHash?: string
  readonly observedHash?: string
  readonly commandTag?: string
  readonly rootId?: SyncRootId
}) =>
  decode(SyncEvent, {
    _tag: 'RemoteWriteSettled',
    ...eventBase({
      eventId: overrides.eventId,
      family: 'CommandSettled',
      eventType: 'RemoteWriteSettled',
      idempotencyKey: overrides.idempotencyKey,
      canonicalJson: `{"settled":"${overrides.eventId}"}`,
      surface: 'page:page-1',
      ...(overrides.rootId === undefined ? {} : { rootId: overrides.rootId }),
    }),
    commandId: overrides.commandId,
    commandTag: overrides.commandTag ?? 'PatchPageProperties',
    requestId: 'request-1',
    desiredHash: overrides.desiredHash ?? hash('b'),
    observedHash: overrides.observedHash ?? overrides.desiredHash ?? hash('b'),
    settlementKind: 'verified-success',
  })

const dataSourceObserved = (overrides: {
  readonly eventId: string
  readonly idempotencyKey: string
  readonly rootId?: SyncRootId
  readonly dataSourceId?: string
  readonly schemaHash?: string
  readonly schemaProperties?: ReadonlyArray<{
    readonly propertyId: string
    readonly configHash: string
    readonly writeClass: 'writable' | 'computed' | 'unsupported'
  }>
}) =>
  decode(SyncEvent, {
    _tag: 'DataSourceObserved',
    ...eventBase({
      eventId: overrides.eventId,
      family: 'RemoteObserved',
      eventType: 'DataSourceObserved',
      idempotencyKey: overrides.idempotencyKey,
      canonicalJson: JSON.stringify({
        schemaProperties: overrides.schemaProperties ?? [
          { propertyId: 'property-1', configHash: hash('c'), writeClass: 'writable' },
        ],
      }),
      surface: `data-source:${overrides.dataSourceId ?? 'data-source-1'}`,
      ...(overrides.rootId === undefined ? {} : { rootId: overrides.rootId }),
    }),
    dataSourceId: overrides.dataSourceId ?? 'data-source-1',
    requestId: 'request-1',
    schemaHash: overrides.schemaHash ?? hash('5'),
  })

const rowObserved = (overrides: {
  readonly eventId: string
  readonly idempotencyKey: string
  readonly rootId?: SyncRootId
  readonly dataSourceId?: string
  readonly pageId?: string
  readonly propertiesHash?: string
  readonly bodyHash?: string
  readonly inTrash?: boolean
}) =>
  decode(SyncEvent, {
    _tag: 'RowObserved',
    ...eventBase({
      eventId: overrides.eventId,
      family: 'RemoteObserved',
      eventType: 'RowObserved',
      idempotencyKey: overrides.idempotencyKey,
      canonicalJson: JSON.stringify({
        bodyPath: `${overrides.pageId ?? 'page-1'}.nmd`,
        sidecarIdentityProven: true,
        ownWriteMaterializationIds: ['materialized-1'],
      }),
      surface: `page:${overrides.pageId ?? 'page-1'}`,
      ...(overrides.rootId === undefined ? {} : { rootId: overrides.rootId }),
    }),
    dataSourceId: overrides.dataSourceId ?? 'data-source-1',
    pageId: overrides.pageId ?? 'page-1',
    propertiesHash: overrides.propertiesHash ?? hash('9'),
    bodyPointer: {
      _tag: 'BodyPointer',
      pageId: overrides.pageId ?? 'page-1',
      bodyHash: overrides.bodyHash ?? hash('b'),
      observedAt,
      safety: {
        truncated: false,
        selection: 'safe',
        wouldDeleteChildren: false,
        syncedPageUnsupported: false,
        adapterConflict: false,
        adapterMutationSurfaces: ['body'],
      },
    },
    inTrash: overrides.inTrash ?? false,
  })

const pagePropertyCheckpoint = (overrides: {
  readonly eventId: string
  readonly idempotencyKey: string
  readonly rootId?: SyncRootId
  readonly pageId?: string
  readonly propertyId?: string
  readonly valueHash?: string | null
  readonly availability?: 'complete' | 'paginated-incomplete'
}) =>
  decode(SyncEvent, {
    _tag: 'PagePropertyCheckpointRecorded',
    ...eventBase({
      eventId: overrides.eventId,
      family: 'QueryScanRecorded',
      eventType: 'PagePropertyCheckpointRecorded',
      idempotencyKey: overrides.idempotencyKey,
      canonicalJson: JSON.stringify({
        availability: overrides.availability ?? 'complete',
      }),
      surface: `page:${overrides.pageId ?? 'page-1'}:property:${overrides.propertyId ?? 'property-1'}`,
      ...(overrides.rootId === undefined ? {} : { rootId: overrides.rootId }),
    }),
    pageId: overrides.pageId ?? 'page-1',
    propertyId: overrides.propertyId ?? 'property-1',
    nextCursor: null,
    complete: overrides.availability !== 'paginated-incomplete',
    ...(overrides.valueHash === null ? {} : { valueHash: overrides.valueHash ?? hash('8') }),
  })

const queryCheckpoint = (overrides: {
  readonly eventId: string
  readonly idempotencyKey: string
  readonly rootId?: SyncRootId
  readonly dataSourceId?: string
  readonly queryContractHash?: string
  readonly complete?: boolean
  readonly cappedAtLimit?: boolean
  readonly contractChanged?: boolean
}) =>
  decode(SyncEvent, {
    _tag: 'QueryScanCheckpointRecorded',
    ...eventBase({
      eventId: overrides.eventId,
      family: 'QueryScanRecorded',
      eventType: 'QueryScanCheckpointRecorded',
      idempotencyKey: overrides.idempotencyKey,
      canonicalJson: JSON.stringify({
        cappedAtLimit: overrides.cappedAtLimit ?? false,
        contractChanged: overrides.contractChanged ?? false,
      }),
      surface: `data-source:${overrides.dataSourceId ?? 'data-source-1'}:query:${
        overrides.queryContractHash ?? hash('7')
      }`,
      ...(overrides.rootId === undefined ? {} : { rootId: overrides.rootId }),
    }),
    dataSourceId: overrides.dataSourceId ?? 'data-source-1',
    queryContractHash: overrides.queryContractHash ?? hash('7'),
    nextCursor: null,
    complete: overrides.complete ?? true,
    highWatermark: null,
  })

const tombstoneCandidate = (overrides: {
  readonly eventId: string
  readonly idempotencyKey: string
  readonly rootId?: SyncRootId
  readonly pageId?: string
  readonly dataSourceId?: string
  readonly queryContractHash?: string
  readonly filtered?: boolean
  readonly directRetrieve?: string
}) =>
  decode(SyncEvent, {
    _tag: 'TombstoneCandidateObserved',
    ...eventBase({
      eventId: overrides.eventId,
      family: 'RemoteObserved',
      eventType: 'TombstoneCandidateObserved',
      idempotencyKey: overrides.idempotencyKey,
      canonicalJson: JSON.stringify({
        pageId: overrides.pageId ?? 'page-1',
        dataSourceId: overrides.dataSourceId ?? 'data-source-1',
        queryContractHash: overrides.queryContractHash ?? hash('7'),
        membershipScope: overrides.filtered === true ? 'explicit-filter' : 'all-data-source-rows',
        filtered: overrides.filtered ?? false,
        classified: overrides.directRetrieve !== undefined,
        directRetrieve: overrides.directRetrieve ?? 'not-run',
      }),
      surface: `page:${overrides.pageId ?? 'page-1'}`,
      ...(overrides.rootId === undefined ? {} : { rootId: overrides.rootId }),
    }),
    pageId: overrides.pageId ?? 'page-1',
    reason: 'query_absence_unclassified',
  })

const apiContractObserved = (eventId = 'api-event') =>
  decode(SyncEvent, {
    _tag: 'ApiContractObserved',
    ...eventBase({
      eventId,
      family: 'CompatibilityChecked',
      eventType: 'ApiContractObserved',
      idempotencyKey: `api:${eventId}`,
      canonicalJson: '{"api":true}',
    }),
    apiContract: {
      _tag: 'NotionApiContract',
      apiVersion: '2026-03-11',
      clientVersion: 'test-client',
      supportedCapabilities: ['page_property_update', 'data_source_query'],
    },
  })

const capabilityChecked = (eventId: string, capability: string, supported = true) =>
  decode(SyncEvent, {
    _tag: 'CapabilityPreflightChecked',
    ...eventBase({
      eventId,
      family: 'CompatibilityChecked',
      eventType: 'CapabilityPreflightChecked',
      idempotencyKey: `capability:${capability}:${eventId}`,
      canonicalJson: `{"capability":"${capability}"}`,
      surface: 'data-source:data-source-1',
    }),
    dataSourceId: 'data-source-1',
    capability,
    supported,
    requestId: `request-${eventId}`,
  })

const withStore = <TValue>(f: (store: NotionSyncStore) => TValue): TValue => {
  const store = openNotionSyncStore({
    path: tempDatabasePath(),
    busyTimeoutMs: 2_500,
    now: () => new Date(observedAt),
  })

  try {
    return f(store)
  } finally {
    store.close()
  }
}

describe('Notion sync SQLite store', () => {
  it('opens a hardened SQLite store and records the initial migration', () => {
    withStore((store) => {
      expect(store.settings).toEqual({
        journalMode: 'wal',
        foreignKeys: true,
        busyTimeoutMs: 2_500,
      })
    })
  })

  it('creates durable planner projection tables during schema migration', () => {
    const path = tempDatabasePath()
    const store = openNotionSyncStore({
      path,
      busyTimeoutMs: 2_500,
      now: () => new Date(observedAt),
    })
    store.close()

    const db = new DatabaseSync(path, { readBigInts: true })
    try {
      const tables = db
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table'
             AND name IN (
               '_nds_data_source',
               '_nds_schema_property',
               '_nds_row',
               '_nds_property_shadow',
               '_nds_body_pointer',
               '_nds_query_absence',
               '_nds_signal_inbox'
             )
           ORDER BY name`,
        )
        .all()
        .map((row) => String(row.name))
      const queryColumns = db
        .prepare(`PRAGMA table_info(_nds_query_scan_checkpoint)`)
        .all()
        .map((row) => String(row.name))

      expect(tables).toEqual([
        '_nds_body_pointer',
        '_nds_data_source',
        '_nds_property_shadow',
        '_nds_query_absence',
        '_nds_row',
        '_nds_schema_property',
        '_nds_signal_inbox',
      ])
      expect(queryColumns).toEqual(expect.arrayContaining(['capped_at_limit', 'contract_changed']))
    } finally {
      db.close()
    }
  })

  it('fails closed when migration history is newer than the supported schema', () => {
    const path = tempDatabasePath()
    const db = new DatabaseSync(path, { readBigInts: true })
    try {
      db.exec(`
        CREATE TABLE _nds_migration_history (
          schema_version INTEGER PRIMARY KEY,
          migration_name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `)
      db.prepare(
        `INSERT INTO _nds_migration_history (schema_version, migration_name, applied_at)
         VALUES (?, ?, ?)`,
      ).run(999, 'future-schema', observedAt)
    } finally {
      db.close()
    }

    expect(() =>
      openNotionSyncStore({
        path,
        busyTimeoutMs: 2_500,
        now: () => new Date(observedAt),
      }),
    ).toThrow(/newer than supported version/)

    const after = new DatabaseSync(path, { readBigInts: true })
    try {
      expect(
        after
          .prepare(
            `SELECT name
             FROM sqlite_master
             WHERE type = 'table' AND name = '_nds_sync_root'`,
          )
          .get(),
      ).toBeUndefined()
      expect(String(after.prepare('PRAGMA journal_mode').get()?.journal_mode)).toBe('delete')
    } finally {
      after.close()
    }
  })

  it('dedupes durable signals by provider and external id', () => {
    withStore((store) => {
      const first = store.enqueueSignal({
        rootId,
        signalId,
        provider: signalProvider,
        externalId: signalExternalId,
        payloadJson: '{"event":"delivered"}',
        dataSourceId: decode(DataSourceId, 'data-source-1'),
        pageId,
      })
      const duplicate = store.enqueueSignal({
        rootId,
        signalId: decode(SignalId, 'signal-duplicate'),
        provider: signalProvider,
        externalId: signalExternalId,
        payloadJson: '{"event":"duplicate"}',
      })

      expect(first.inserted).toBe(true)
      expect(duplicate.inserted).toBe(false)
      expect(duplicate.signal.signalId).toBe(signalId)
      expect(store.readSignalStatus(rootId)).toEqual({
        pending: 1,
        claimed: 0,
        processed: 0,
        failed: 0,
      })
    })
  })

  it('claims, settles, and releases durable signals with lease fencing', () => {
    withStore((store) => {
      store.enqueueSignal({
        rootId,
        signalId,
        provider: signalProvider,
        externalId: signalExternalId,
      })

      const claimed = store.claimNextSignal({ rootId, leaseToken: 'lease-a' })
      expect(claimed).toMatchObject({
        signalId,
        state: 'claimed',
        attemptCount: 1,
        leaseToken: 'lease-a',
      })
      expect(store.readSignalStatus(rootId)).toEqual({
        pending: 0,
        claimed: 1,
        processed: 0,
        failed: 0,
      })

      store.releaseSignal({
        rootId,
        signalId,
        leaseToken: 'wrong-lease',
        error: 'ignored release',
      })
      expect(store.readSignalStatus(rootId).claimed).toBe(1)

      store.releaseSignal({
        rootId,
        signalId,
        leaseToken: 'lease-a',
        error: 'cycle failed',
      })
      expect(store.readSignals(rootId)).toMatchObject([
        { state: 'pending', attemptCount: 1, lastError: 'cycle failed' },
      ])

      const reclaimed = store.claimNextSignal({ rootId, leaseToken: 'lease-b' })
      expect(reclaimed).toMatchObject({ state: 'claimed', attemptCount: 2 })
      store.settleSignal({ rootId, signalId, leaseToken: 'lease-b' })
      expect(store.readSignalStatus(rootId)).toEqual({
        pending: 0,
        claimed: 0,
        processed: 1,
        failed: 0,
      })
    })
  })

  it('fails closed before WAL when migration history has an unknown schema version type', () => {
    const path = tempDatabasePath()
    const db = new DatabaseSync(path, { readBigInts: true })
    try {
      db.exec(`
        CREATE TABLE _nds_migration_history (
          schema_version TEXT PRIMARY KEY,
          migration_name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `)
      db.prepare(
        `INSERT INTO _nds_migration_history (schema_version, migration_name, applied_at)
         VALUES (?, ?, ?)`,
      ).run('future', 'unknown-schema', observedAt)
    } finally {
      db.close()
    }

    expect(() =>
      openNotionSyncStore({
        path,
        busyTimeoutMs: 2_500,
        now: () => new Date(observedAt),
      }),
    ).toThrow(/schema version is unknown/)

    const after = new DatabaseSync(path, { readBigInts: true })
    try {
      expect(
        after
          .prepare(
            `SELECT name
             FROM sqlite_master
             WHERE type = 'table' AND name = '_nds_sync_root'`,
          )
          .get(),
      ).toBeUndefined()
      expect(String(after.prepare('PRAGMA journal_mode').get()?.journal_mode)).toBe('delete')
    } finally {
      after.close()
    }
  })

  it('assigns sequence, computes payload hash, dedupes idempotency, and replays in order', () => {
    withStore((store) => {
      const first = store.appendEvent(
        remoteWritePlanned({
          eventId: 'event-1',
          idempotencyKey: 'command:cmd-1',
          commandId: 'cmd-1',
        }),
      )
      const duplicate = store.appendEvent(
        remoteWritePlanned({
          eventId: 'event-duplicate',
          idempotencyKey: 'command:cmd-1',
          commandId: 'cmd-1',
        }),
      )
      const second = store.appendEvent(
        remoteWriteAttempted({
          eventId: 'event-2',
          idempotencyKey: 'attempt:cmd-1:1',
          commandId: 'cmd-1',
          attemptState: 'running',
          leaseToken: 'lease-1',
        }),
      )

      expect(first.sequence).toBe(1n)
      expect(first.payloadHash).toBe(hashStoreBytes('{"commandId":"cmd-1"}'))
      expect(duplicate.eventId).toBe(first.eventId)
      expect(second.sequence).toBe(2n)
      expect(store.replay(rootId).map((event) => [event.sequence, event.family, event.eventType]))
        .toMatchInlineSnapshot(`
          [
            [
              1n,
              "CommandEnqueued",
              "RemoteWritePlanned",
            ],
            [
              2n,
              "CommandAttempted",
              "RemoteWriteAttempted",
            ],
          ]
        `)
    })
  })

  it('claims one pending outbox command and fences active leases until they expire', () => {
    withStore((store) => {
      store.appendEvent(
        remoteWritePlanned({
          eventId: 'event-claim-planned',
          idempotencyKey: 'command:cmd-1',
          commandId: 'cmd-1',
        }),
      )

      const first = store.claimNextOutboxCommand({
        rootId,
        leaseToken: 'lease-1',
        leaseDurationMs: 60_000,
      })
      const activeLease = store.claimNextOutboxCommand({
        rootId,
        leaseToken: 'lease-2',
        leaseDurationMs: 60_000,
      })
      const expiredLease = store.claimNextOutboxCommand({
        rootId,
        leaseToken: 'lease-2',
        leaseDurationMs: 0,
      })

      expect(first).toMatchObject({
        commandId,
        attempt: 1,
        previousState: 'queued',
        attemptState: 'running',
        leaseToken: 'lease-1',
      })
      expect(activeLease).toBeUndefined()
      expect(expiredLease).toMatchObject({
        commandId,
        attempt: 2,
        previousState: 'running',
        attemptState: 'ambiguous',
        leaseToken: 'lease-2',
      })
      expect(store.readOutbox(rootId)).toMatchObject([
        {
          commandId,
          state: 'ambiguous',
          attemptCount: 2,
          leaseToken: 'lease-2',
        },
      ])
    })
  })

  it('ignores stale failed attempt events after an expired command is reclaimed', () => {
    withStore((store) => {
      store.appendEvent(
        remoteWritePlanned({
          eventId: 'event-stale-attempt-planned',
          idempotencyKey: 'command:cmd-1',
          commandId: 'cmd-1',
        }),
      )

      expect(
        store.claimNextOutboxCommand({
          rootId,
          leaseToken: 'lease-1',
          leaseDurationMs: 60_000,
        }),
      ).toMatchObject({ attempt: 1, leaseToken: 'lease-1' })
      expect(
        store.claimNextOutboxCommand({
          rootId,
          leaseToken: 'lease-2',
          leaseDurationMs: 0,
        }),
      ).toMatchObject({ attempt: 2, leaseToken: 'lease-2', attemptState: 'ambiguous' })

      store.appendEvent(
        remoteWriteAttempted({
          eventId: 'event-stale-attempt-fenced',
          idempotencyKey: 'attempt:cmd-1:1:fenced',
          commandId: 'cmd-1',
          attempt: 1,
          attemptState: 'fenced',
          leaseToken: 'lease-1',
        }),
      )

      expect(store.readOutbox(rootId)).toMatchObject([
        {
          commandId,
          state: 'ambiguous',
          attemptCount: 2,
          leaseToken: 'lease-2',
          settlementEventId: undefined,
        },
      ])
    })
  })

  it('ignores same-attempt state events with a mismatched lease token', () => {
    withStore((store) => {
      store.appendEvent(
        remoteWritePlanned({
          eventId: 'event-lease-mismatch-planned',
          idempotencyKey: 'command:cmd-1',
          commandId: 'cmd-1',
        }),
      )

      expect(
        store.claimNextOutboxCommand({
          rootId,
          leaseToken: 'lease-2',
          leaseDurationMs: 60_000,
        }),
      ).toMatchObject({ attempt: 1, leaseToken: 'lease-2' })

      store.appendEvent(
        remoteWriteAttempted({
          eventId: 'event-lease-mismatch-fenced',
          idempotencyKey: 'attempt:cmd-1:1:fenced',
          commandId: 'cmd-1',
          attempt: 1,
          attemptState: 'fenced',
          leaseToken: 'lease-1',
        }),
      )

      expect(store.readOutbox(rootId)).toMatchObject([
        {
          commandId,
          state: 'running',
          attemptCount: 1,
          leaseToken: 'lease-2',
          settlementEventId: undefined,
        },
      ])
    })
  })

  it('ignores same-attempt legacy running events without a lease token', () => {
    withStore((store) => {
      store.appendEvent(
        remoteWritePlanned({
          eventId: 'event-legacy-running-planned',
          idempotencyKey: 'command:cmd-1',
          commandId: 'cmd-1',
        }),
      )

      expect(
        store.claimNextOutboxCommand({
          rootId,
          leaseToken: 'lease-1',
          leaseDurationMs: 60_000,
        }),
      ).toMatchObject({ attempt: 1, leaseToken: 'lease-1' })

      store.appendEvent(
        remoteWriteAttempted({
          eventId: 'event-legacy-running-without-lease',
          idempotencyKey: 'attempt:cmd-1:1:legacy-running',
          commandId: 'cmd-1',
          attempt: 1,
          attemptState: 'running',
        }),
      )

      expect(
        store.isOutboxLeaseActive({
          rootId,
          commandId,
          leaseToken: 'lease-1',
        }),
      ).toBe(true)
      expect(
        store.claimNextOutboxCommand({
          rootId,
          leaseToken: 'lease-2',
          leaseDurationMs: 60_000,
        }),
      ).toBeUndefined()
      expect(
        store.claimNextOutboxCommand({
          rootId,
          leaseToken: 'lease-2',
          leaseDurationMs: 0,
        }),
      ).toMatchObject({ attempt: 2, leaseToken: 'lease-2', attemptState: 'ambiguous' })
    })
  })

  it('keeps the first verified settlement as terminal for duplicate settlement attempts', () => {
    withStore((store) => {
      store.appendEvent(
        remoteWritePlanned({
          eventId: 'event-settlement-planned',
          idempotencyKey: 'command:cmd-1',
          commandId: 'cmd-1',
        }),
      )
      const claim = store.claimNextOutboxCommand({
        rootId,
        leaseToken: 'lease-1',
        leaseDurationMs: 60_000,
      })
      expect(claim).not.toBeUndefined()

      const first = store.appendOutboxSettlement({
        rootId,
        commandId,
        commandKey,
        surface: propertySurfaceKey({ pageId: pageId, propertyId: propertyId }),
        commandTag: 'PatchPageProperties',
        requestId: decode(NotionRequestId, 'request-1'),
        desiredHash: hash('b'),
        observedHash: hash('b'),
        settlementKind: 'verified-success',
        idempotencyKey: decode(IdempotencyKey, 'settled:cmd-1'),
      })
      const duplicate = store.appendOutboxSettlement({
        rootId,
        commandId,
        commandKey,
        surface: propertySurfaceKey({ pageId: pageId, propertyId: propertyId }),
        commandTag: 'PatchPageProperties',
        requestId: decode(NotionRequestId, 'request-2'),
        desiredHash: hash('b'),
        observedHash: hash('b'),
        settlementKind: 'verified-no-op',
        idempotencyKey: decode(IdempotencyKey, 'settled:cmd-1'),
      })

      expect(duplicate.eventId).toBe(first.eventId)
      expect(store.readOutbox(rootId)).toMatchObject([
        {
          commandId,
          state: 'settled',
          settlementEventId: first.eventId,
          leaseToken: undefined,
        },
      ])
    })
  })

  it('projects remote schema, row, property, body, and query evidence into planner snapshots', () => {
    withStore((store) => {
      store.appendEvent(apiContractObserved())
      store.appendEvent(capabilityChecked('event-capability-1', 'page_property_update'))
      store.appendEvent(capabilityChecked('event-capability-2', 'data_source_query'))
      store.appendEvent(
        dataSourceObserved({
          eventId: 'event-data-source-1',
          idempotencyKey: 'remote:data-source-1',
          schemaProperties: [
            { propertyId: 'property-1', configHash: hash('c'), writeClass: 'writable' },
          ],
        }),
      )
      store.appendEvent(
        rowObserved({
          eventId: 'event-row-1',
          idempotencyKey: 'remote:row:page-1',
          propertiesHash: hash('9'),
          bodyHash: hash('b'),
        }),
      )
      store.appendEvent(
        pagePropertyCheckpoint({
          eventId: 'event-property-1',
          idempotencyKey: 'property:page-1:property-1',
          valueHash: hash('8'),
        }),
      )
      store.appendEvent(
        queryCheckpoint({
          eventId: 'event-query-1',
          idempotencyKey: 'query:data-source-1',
          queryContractHash: hash('7'),
          complete: true,
        }),
      )
      store.appendEvent(
        tombstoneCandidate({
          eventId: 'event-absence-1',
          idempotencyKey: 'absence:page-1',
          queryContractHash: hash('7'),
          directRetrieve: 'in-trash',
        }),
      )

      const beforeRebuild = store.readPlannerProjectionSnapshot(rootId)

      expect(beforeRebuild).toMatchObject({
        api: { compatibilityProof: 'present' },
        capabilities: {
          required: ['data_source_query', 'page_property_update'],
          supported: ['data_source_query', 'page_property_update'],
          preflight: 'passed',
        },
        schema: [
          {
            dataSourceId: 'data-source-1',
            propertyId: 'property-1',
            schemaHash: hash('5'),
            configHash: hash('c'),
            writeClass: 'writable',
          },
        ],
        rows: [
          {
            pageId: 'page-1',
            dataSourceId: 'data-source-1',
            propertiesHash: hash('9'),
            inTrash: false,
          },
        ],
        properties: [
          {
            pageId: 'page-1',
            propertyId: 'property-1',
            baseHash: hash('8'),
            remoteHash: hash('8'),
            availability: 'complete',
            pendingLocal: undefined,
          },
        ],
        bodies: [
          {
            pageId: 'page-1',
            path: 'page-1.nmd',
            baseHash: hash('b'),
            currentHash: hash('b'),
            sidecarIdentityProven: true,
            ownWriteMaterializationIds: ['materialized-1'],
            safety: { selection: 'safe', adapterMutationSurfaces: ['body'] },
          },
        ],
        queries: [
          {
            dataSourceId: 'data-source-1',
            pageId: 'page-1',
            queryContractHash: hash('7'),
            completeness: { terminal: true, cappedAtLimit: false, contractChanged: false },
            absence: {
              classified: true,
              membershipScope: 'all-data-source-rows',
              filtered: false,
              directRetrieve: 'in-trash',
            },
          },
        ],
        tombstones: [
          {
            pageId: 'page-1',
            state: 'candidate',
            directRetrieve: 'in-trash',
          },
        ],
      })

      store.clearProjectionTables()
      store.rebuildProjections(rootId)

      expect(store.readPlannerProjectionSnapshot(rootId)).toEqual(beforeRebuild)
    })
  })

  it('keeps incomplete property checkpoints diagnostic while preserving per-property write guards', () => {
    withStore((store) => {
      store.appendEvent(
        pagePropertyCheckpoint({
          eventId: 'event-property-complete',
          idempotencyKey: 'property:page-1:property-1:complete',
          valueHash: hash('8'),
        }),
      )
      store.appendEvent(
        pagePropertyCheckpoint({
          eventId: 'event-property-incomplete',
          idempotencyKey: 'property:page-1:property-1:incomplete',
          valueHash: null,
          availability: 'paginated-incomplete',
        }),
      )

      expect(store.readStatusProjection(rootId).checkpoints.incompleteProperties).toBe(1)
      expect(store.readPlannerProjectionSnapshot(rootId).properties).toEqual([
        expect.objectContaining({
          pageId: 'page-1',
          propertyId: 'property-1',
          baseHash: hash('8'),
          remoteHash: hash('8'),
          availability: 'paginated-incomplete',
        }),
      ])
    })
  })

  it('advances property base hashes on clean observations after remote-only drift', () => {
    withStore((store) => {
      store.appendEvent(
        pagePropertyCheckpoint({
          eventId: 'event-property-base',
          idempotencyKey: 'property:page-1:property-1:base',
          valueHash: hash('8'),
        }),
      )
      store.appendEvent(
        pagePropertyCheckpoint({
          eventId: 'event-property-remote',
          idempotencyKey: 'property:page-1:property-1:remote',
          valueHash: hash('9'),
        }),
      )

      expect(store.readPlannerProjectionSnapshot(rootId).properties).toEqual([
        expect.objectContaining({
          pageId: 'page-1',
          propertyId: 'property-1',
          baseHash: hash('9'),
          remoteHash: hash('9'),
        }),
      ])
    })
  })

  it('preserves property base hashes while a local property outbox is unresolved', () => {
    withStore((store) => {
      store.appendEvent(
        pagePropertyCheckpoint({
          eventId: 'event-property-base',
          idempotencyKey: 'property:page-1:property-1:base',
          valueHash: hash('8'),
        }),
      )
      store.appendEvent(
        remoteWritePlanned({
          eventId: 'event-command-pending',
          idempotencyKey: 'command:pending-property',
          commandId: 'cmd-1',
          desiredHash: hash('a'),
          surface: propertySurfaceKey({ pageId, propertyId }),
        }),
      )
      store.appendEvent(
        pagePropertyCheckpoint({
          eventId: 'event-property-remote',
          idempotencyKey: 'property:page-1:property-1:remote',
          valueHash: hash('9'),
        }),
      )

      expect(store.readPlannerProjectionSnapshot(rootId).properties).toEqual([
        expect.objectContaining({
          pageId: 'page-1',
          propertyId: 'property-1',
          baseHash: hash('8'),
          remoteHash: hash('9'),
        }),
      ])
    })
  })

  it('removes schema properties missing from the latest full data source observation', () => {
    withStore((store) => {
      store.appendEvent(
        dataSourceObserved({
          eventId: 'event-data-source-base',
          idempotencyKey: 'remote:data-source-1:base',
          schemaProperties: [
            { propertyId: 'property-1', configHash: hash('a'), writeClass: 'writable' },
            { propertyId: 'property-2', configHash: hash('b'), writeClass: 'computed' },
          ],
        }),
      )
      store.appendEvent(
        dataSourceObserved({
          eventId: 'event-data-source-renamed',
          idempotencyKey: 'remote:data-source-1:renamed',
          schemaHash: hash('6'),
          schemaProperties: [
            { propertyId: 'property-2', configHash: hash('b'), writeClass: 'computed' },
            { propertyId: 'property-3', configHash: hash('c'), writeClass: 'writable' },
          ],
        }),
      )

      const beforeRebuild = store.readPlannerProjectionSnapshot(rootId).schema
      expect(beforeRebuild).toEqual([
        {
          dataSourceId: 'data-source-1',
          propertyId: 'property-2',
          schemaHash: hash('6'),
          configHash: hash('b'),
          writeClass: 'computed',
        },
        {
          dataSourceId: 'data-source-1',
          propertyId: 'property-3',
          schemaHash: hash('6'),
          configHash: hash('c'),
          writeClass: 'writable',
        },
      ])

      store.clearProjectionTables()
      store.rebuildProjections(rootId)

      expect(store.readPlannerProjectionSnapshot(rootId).schema).toEqual(beforeRebuild)
    })
  })

  it('blocks property planning after full schema pruning leaves only a stale property shadow', () => {
    withStore((store) => {
      store.appendEvent(apiContractObserved())
      store.appendEvent(
        capabilityChecked('event-capability-property-update', 'page_property_update'),
      )
      store.appendEvent(
        dataSourceObserved({
          eventId: 'event-data-source-with-property',
          idempotencyKey: 'remote:data-source-1:with-property',
          schemaProperties: [
            { propertyId: 'property-1', configHash: hash('c'), writeClass: 'writable' },
          ],
        }),
      )
      store.appendEvent(
        rowObserved({
          eventId: 'event-row-with-property-shadow',
          idempotencyKey: 'remote:row:page-1:with-property-shadow',
        }),
      )
      store.appendEvent(
        pagePropertyCheckpoint({
          eventId: 'event-property-shadow',
          idempotencyKey: 'property:page-1:property-1:shadow',
          valueHash: hash('8'),
        }),
      )
      store.appendEvent(
        dataSourceObserved({
          eventId: 'event-data-source-pruned',
          idempotencyKey: 'remote:data-source-1:pruned',
          schemaHash: hash('6'),
          schemaProperties: [],
        }),
      )

      const snapshot = store.readPlannerProjectionSnapshot(rootId)
      expect(snapshot.schema).toEqual([])
      expect(snapshot.properties).toMatchObject([
        {
          pageId: 'page-1',
          propertyId: 'property-1',
          remoteHash: hash('8'),
        },
      ])

      const command = decode(PatchPagePropertiesCommand, {
        _tag: 'PatchPagePropertiesCommand',
        commandId,
        pageId,
        basePropertiesHash: hash('9'),
        propertyPatch: {
          'property-1': { _tag: 'title', plainText: 'Updated' },
        },
      })

      expect(
        planIntent({
          snapshot: snapshot,
          intent: {
            _tag: 'property-edit',
            intentEventId,
            commandKey,
            surface: propertySurfaceKey({ pageId: pageId, propertyId: propertyId }),
            pageId,
            propertyId,
            command,
            baseHash: hash('8'),
            desiredHash: hash('a'),
            expectedPropertyConfigHash: hash('c'),
          },
        }),
      ).toMatchObject({
        _tag: 'BlockedByGuard',
        guard: 'CurrentSurfaceMissing',
        detail: {
          summary:
            'Current schema property projection is missing; observe the data source schema before planning a property write',
        },
      })
    })
  })

  it('keeps pending property intent visible after later remote property observation', () => {
    withStore((store) => {
      store.appendEvent(
        pagePropertyCheckpoint({
          eventId: 'event-property-base',
          idempotencyKey: 'property:page-1:property-1:base',
          valueHash: hash('a'),
        }),
      )
      store.appendEvent(
        remoteWritePlanned({
          eventId: 'event-local-intent',
          idempotencyKey: 'command:cmd-1',
          commandId: 'cmd-1',
          intentEventId: 'intent-property-1',
          desiredHash: hash('b'),
          surface: 'page:page-1:property:property-1',
        }),
      )
      store.appendEvent(
        pagePropertyCheckpoint({
          eventId: 'event-property-remote',
          idempotencyKey: 'property:page-1:property-1:remote',
          valueHash: hash('c'),
        }),
      )

      expect(store.readPlannerProjectionSnapshot(rootId).properties).toEqual([
        {
          pageId: 'page-1',
          propertyId: 'property-1',
          baseHash: hash('a'),
          remoteHash: hash('c'),
          availability: 'complete',
          pendingLocal: {
            intentEventId: 'intent-property-1',
            targetHash: hash('b'),
          },
        },
      ])
    })
  })

  it('projects same-property pending intents by accepted event order instead of command id order', () => {
    withStore((store) => {
      store.appendEvent(
        pagePropertyCheckpoint({
          eventId: 'event-property-base',
          idempotencyKey: 'property:page-1:property-1:base',
          valueHash: hash('a'),
        }),
      )
      store.appendEvent(
        remoteWritePlanned({
          eventId: 'event-local-intent-first',
          idempotencyKey: 'command:cmd-z',
          commandId: 'cmd-z',
          intentEventId: 'intent-property-first',
          desiredHash: hash('b'),
          surface: 'page:page-1:property:property-1',
        }),
      )
      store.appendEvent(
        remoteWritePlanned({
          eventId: 'event-local-intent-second',
          idempotencyKey: 'command:cmd-a',
          commandId: 'cmd-a',
          intentEventId: 'intent-property-second',
          desiredHash: hash('c'),
          surface: 'page:page-1:property:property-1',
        }),
      )

      expect(store.readPlannerProjectionSnapshot(rootId).properties).toEqual([
        expect.objectContaining({
          pageId: 'page-1',
          propertyId: 'property-1',
          pendingLocal: {
            intentEventId: 'intent-property-second',
            targetHash: hash('c'),
          },
        }),
      ])
    })
  })

  it('scopes query absence evidence to exact root, data source, page, and query identity', () => {
    withStore((store) => {
      store.appendEvent(
        queryCheckpoint({
          eventId: 'event-query-root-1',
          idempotencyKey: 'query:root-1:data-source-1',
          dataSourceId: 'data-source-1',
          queryContractHash: hash('7'),
          complete: true,
        }),
      )
      store.appendEvent(
        queryCheckpoint({
          eventId: 'event-query-other-source',
          idempotencyKey: 'query:root-1:data-source-2',
          dataSourceId: 'data-source-2',
          queryContractHash: hash('7'),
          complete: false,
          cappedAtLimit: true,
        }),
      )
      store.appendEvent(
        tombstoneCandidate({
          eventId: 'event-absence-root-1',
          idempotencyKey: 'absence:root-1:page-1',
          pageId: 'page-1',
          dataSourceId: 'data-source-1',
          queryContractHash: hash('7'),
          directRetrieve: 'in-trash',
        }),
      )
      store.appendEvent(
        tombstoneCandidate({
          eventId: 'event-absence-root-1-other-source',
          idempotencyKey: 'absence:root-1:page-1:source-2',
          pageId: 'page-1',
          dataSourceId: 'data-source-2',
          queryContractHash: hash('7'),
          filtered: true,
          directRetrieve: 'accessible',
        }),
      )
      store.appendEvent(
        tombstoneCandidate({
          eventId: 'event-absence-root-2',
          idempotencyKey: 'absence:root-2:page-1',
          rootId: otherRootId,
          pageId: 'page-1',
          dataSourceId: 'data-source-1',
          queryContractHash: hash('7'),
          directRetrieve: 'unknown',
        }),
      )

      expect(store.readPlannerProjectionSnapshot(rootId).queries).toEqual([
        {
          dataSourceId: 'data-source-1',
          pageId: 'page-1',
          queryContractHash: hash('7'),
          completeness: { terminal: true, cappedAtLimit: false, contractChanged: false },
          absence: {
            classified: true,
            membershipScope: 'all-data-source-rows',
            filtered: false,
            directRetrieve: 'in-trash',
          },
        },
        {
          dataSourceId: 'data-source-2',
          pageId: 'page-1',
          queryContractHash: hash('7'),
          completeness: { terminal: false, cappedAtLimit: true, contractChanged: false },
          absence: {
            classified: true,
            membershipScope: 'explicit-filter',
            filtered: true,
            directRetrieve: 'accessible',
          },
        },
      ])
      expect(store.readPlannerProjectionSnapshot(otherRootId).queries).toMatchObject([
        {
          dataSourceId: 'data-source-1',
          pageId: 'page-1',
          absence: { directRetrieve: 'unknown' },
        },
      ])
      expect(store.readPlannerProjectionSnapshot(rootId).tombstones).toEqual([
        {
          pageId: 'page-1',
          dataSourceId: 'data-source-1',
          queryContractHash: hash('7'),
          state: 'candidate',
          directRetrieve: 'in-trash',
        },
      ])
    })
  })

  it('prunes unreferenced stale query checkpoints after a complete replacement checkpoint', () => {
    const path = tempDatabasePath()
    const store = openNotionSyncStore({
      path,
      busyTimeoutMs: 2_500,
      now: () => new Date(observedAt),
    })
    try {
      store.appendEvent(
        queryCheckpoint({
          eventId: 'event-query-stale',
          idempotencyKey: 'query:stale',
          queryContractHash: hash('7'),
          complete: true,
        }),
      )
      store.appendEvent(
        queryCheckpoint({
          eventId: 'event-query-referenced',
          idempotencyKey: 'query:referenced',
          queryContractHash: hash('8'),
          complete: true,
        }),
      )
      store.appendEvent(
        tombstoneCandidate({
          eventId: 'event-absence-referenced',
          idempotencyKey: 'absence:referenced',
          queryContractHash: hash('8'),
          directRetrieve: 'in-trash',
        }),
      )
      store.appendEvent(
        queryCheckpoint({
          eventId: 'event-query-current',
          idempotencyKey: 'query:current',
          queryContractHash: hash('9'),
          complete: true,
        }),
      )

      const db = new DatabaseSync(path)
      try {
        expect(
          db
            .prepare(
              `SELECT query_contract_hash
               FROM _nds_query_scan_checkpoint
               ORDER BY query_contract_hash`,
            )
            .all()
            .map((row) => String(row.query_contract_hash)),
        ).toEqual([hash('8'), hash('9')])
      } finally {
        db.close()
      }
    } finally {
      store.close()
    }
  })

  it('does not downgrade a classified tombstone when a later absence event is already classified', () => {
    withStore((store) => {
      store.appendEvent(
        decode(SyncEvent, {
          _tag: 'TombstoneRecorded',
          ...eventBase({
            eventId: 'event-tombstone-recorded',
            family: 'TombstoneClassified',
            eventType: 'TombstoneRecorded',
            idempotencyKey: 'tombstone:page-1',
            canonicalJson: '{}',
            surface: 'page:page-1',
          }),
          pageId: 'page-1',
          reason: 'remote_trash',
        }),
      )
      store.appendEvent(
        tombstoneCandidate({
          eventId: 'event-classified-absence',
          idempotencyKey: 'absence:page-1:classified',
          directRetrieve: 'in-trash',
        }),
      )

      expect(store.readTombstones(rootId)).toEqual([
        {
          pageId: 'page-1',
          classification: 'remote_trash',
          reason: 'remote_trash',
          eventId: 'event-tombstone-recorded',
        },
      ])
    })
  })

  it('exposes tombstone direct-retrieve evidence only for the matching source/query identity', () => {
    withStore((store) => {
      store.appendEvent(
        tombstoneCandidate({
          eventId: 'event-unrelated-absence',
          idempotencyKey: 'absence:page-1:other-source',
          pageId: 'page-1',
          dataSourceId: 'data-source-2',
          queryContractHash: hash('8'),
          directRetrieve: 'accessible',
        }),
      )
      store.appendEvent(
        decode(SyncEvent, {
          _tag: 'TombstoneCandidateObserved',
          ...eventBase({
            eventId: 'event-candidate-without-query-evidence',
            family: 'RemoteObserved',
            eventType: 'TombstoneCandidateObserved',
            idempotencyKey: 'absence:page-1:no-query-evidence',
            canonicalJson: '{}',
            surface: 'page:page-1',
          }),
          pageId: 'page-1',
          reason: 'query_absence_unclassified',
        }),
      )

      expect(store.readPlannerProjectionSnapshot(rootId).tombstones).toEqual([
        {
          pageId: 'page-1',
          dataSourceId: undefined,
          queryContractHash: undefined,
          state: 'candidate',
          directRetrieve: 'not-run',
        },
      ])
      expect(store.readPlannerProjectionSnapshot(rootId).queries).toEqual([
        {
          dataSourceId: 'data-source-2',
          pageId: 'page-1',
          queryContractHash: hash('8'),
          completeness: { terminal: false, cappedAtLimit: false, contractChanged: false },
          absence: {
            classified: true,
            membershipScope: 'all-data-source-rows',
            filtered: false,
            directRetrieve: 'accessible',
          },
        },
      ])
    })
  })

  it('persists outbox envelope fields and keeps first settlement terminal', () => {
    withStore((store) => {
      store.appendEvent(
        remoteWritePlanned({
          eventId: 'event-1',
          idempotencyKey: 'command:cmd-1',
          commandId: 'cmd-1',
          intentEventId: 'intent-1',
          desiredHash: hash('c'),
        }),
      )
      store.appendEvent(
        remoteWriteAttempted({
          eventId: 'event-2',
          idempotencyKey: 'attempt:cmd-1:1',
          commandId: 'cmd-1',
          attemptState: 'running',
          leaseToken: 'lease-1',
        }),
      )
      store.appendEvent(
        remoteWriteSettled({
          eventId: 'event-3',
          idempotencyKey: 'settled:cmd-1:first',
          commandId: 'cmd-1',
          desiredHash: hash('c'),
        }),
      )
      store.appendEvent(
        remoteWriteSettled({
          eventId: 'event-4',
          idempotencyKey: 'settled:cmd-1:duplicate',
          commandId: 'cmd-1',
          desiredHash: hash('d'),
        }),
      )

      expect(store.readOutbox(rootId)).toEqual([
        {
          commandId: 'cmd-1',
          commandKey: 'command:cmd-1',
          intentEventId: 'intent-1',
          surface: 'page:page-1',
          commandTag: 'PatchPageProperties',
          state: 'settled',
          baseHash: hash('a'),
          desiredHash: hash('c'),
          attemptCount: 1,
          leaseToken: undefined,
          settlementEventId: 'event-3',
        },
      ])
    })
  })

  it('ignores settlement events without sufficient command proof', () => {
    withStore((store) => {
      store.appendEvent(
        remoteWriteSettled({
          eventId: 'event-ignored-missing-command',
          idempotencyKey: 'settled:missing',
          commandId: 'missing-command',
        }),
      )
      expect(store.readOutbox(rootId)).toEqual([])

      store.appendEvent(
        remoteWritePlanned({
          eventId: 'event-1',
          idempotencyKey: 'command:cmd-1',
          commandId: 'cmd-1',
          desiredHash: hash('c'),
        }),
      )
      store.appendEvent(
        remoteWriteSettled({
          eventId: 'event-ignored-no-attempt',
          idempotencyKey: 'settled:cmd-1:no-attempt',
          commandId: 'cmd-1',
          desiredHash: hash('c'),
        }),
      )

      expect(store.readOutbox(rootId)).toMatchObject([
        {
          commandId: 'cmd-1',
          state: 'queued',
          settlementEventId: undefined,
        },
      ])

      store.appendEvent(
        remoteWriteAttempted({
          eventId: 'event-2',
          idempotencyKey: 'attempt:cmd-1:1',
          commandId: 'cmd-1',
          attemptState: 'running',
          leaseToken: 'lease-1',
        }),
      )
      store.appendEvent(
        remoteWriteSettled({
          eventId: 'event-ignored-hash-mismatch',
          idempotencyKey: 'settled:cmd-1:hash-mismatch',
          commandId: 'cmd-1',
          desiredHash: hash('c'),
          observedHash: hash('d'),
        }),
      )
      store.appendEvent(
        remoteWriteSettled({
          eventId: 'event-ignored-command-tag',
          idempotencyKey: 'settled:cmd-1:tag-mismatch',
          commandId: 'cmd-1',
          commandTag: 'TrashPage',
          desiredHash: hash('c'),
          observedHash: hash('c'),
        }),
      )

      expect(store.readOutbox(rootId)).toMatchObject([
        {
          commandId: 'cmd-1',
          state: 'running',
          settlementEventId: undefined,
        },
      ])
    })
  })

  it('settles a command only with matching attempted command evidence', () => {
    withStore((store) => {
      store.appendEvent(
        remoteWritePlanned({
          eventId: 'event-1',
          idempotencyKey: 'command:cmd-1',
          commandId: 'cmd-1',
          desiredHash: hash('c'),
        }),
      )
      store.appendEvent(
        remoteWriteAttempted({
          eventId: 'event-2',
          idempotencyKey: 'attempt:cmd-1:1',
          commandId: 'cmd-1',
          attemptState: 'running',
          leaseToken: 'lease-1',
        }),
      )
      store.appendEvent(
        remoteWriteSettled({
          eventId: 'event-3',
          idempotencyKey: 'settled:cmd-1',
          commandId: 'cmd-1',
          desiredHash: hash('c'),
          observedHash: hash('c'),
        }),
      )

      expect(store.readOutbox(rootId)).toMatchObject([
        {
          commandId: 'cmd-1',
          state: 'settled',
          settlementEventId: 'event-3',
        },
      ])
    })
  })

  it('blocks compaction for unsafe outbox, open conflicts, unclassified tombstones, and digest drift', () => {
    withStore((store) => {
      store.appendEvent(
        remoteWritePlanned({
          eventId: 'event-1',
          idempotencyKey: 'command:cmd-1',
          commandId: 'cmd-1',
        }),
      )
      store.appendEvent(
        decode(SyncEvent, {
          _tag: 'ConflictRaised',
          ...eventBase({
            eventId: 'event-2',
            family: 'ConflictDetected',
            eventType: 'ConflictRaised',
            idempotencyKey: 'conflict:page-1',
            canonicalJson: '{"conflict":true}',
            surface: 'page:page-1',
          }),
          conflictKind: 'delete-vs-edit',
          pageId: 'page-1',
          baseHash: hash('a'),
          localHash: hash('b'),
          remoteHash: hash('c'),
        }),
      )
      store.appendEvent(
        decode(SyncEvent, {
          _tag: 'TombstoneCandidateObserved',
          ...eventBase({
            eventId: 'event-3',
            family: 'RemoteObserved',
            eventType: 'TombstoneCandidateObserved',
            idempotencyKey: 'candidate:page-1',
            canonicalJson: '{"absence":true}',
            surface: 'page:page-1',
          }),
          pageId: 'page-1',
          reason: 'query_absence_unclassified',
        }),
      )
      store.replaceProjectionDigestForRepairTest({ rootId, digest: hash('f') })

      const decision = store.getCompactionDecision(rootId)

      expect(decision._tag).toBe('blocked')
      expect(decision).toMatchObject({
        blockers: expect.arrayContaining([
          expect.objectContaining({ guard: 'CheckpointDigestMismatch' }),
          expect.objectContaining({ guard: 'CompactionUnsafe' }),
        ]),
      })
    })
  })

  it('rebuilds deterministic projections from empty projection tables', () => {
    withStore((store) => {
      store.appendEvent(
        remoteWritePlanned({
          eventId: 'event-1',
          idempotencyKey: 'command:cmd-1',
          commandId: 'cmd-1',
        }),
      )
      store.appendEvent(
        remoteWriteAttempted({
          eventId: 'event-2',
          idempotencyKey: 'attempt:cmd-1:1',
          commandId: 'cmd-1',
          attemptState: 'running',
          leaseToken: 'lease-1',
        }),
      )
      store.appendEvent(
        remoteWriteSettled({
          eventId: 'event-3',
          idempotencyKey: 'settled:cmd-1',
          commandId: 'cmd-1',
        }),
      )
      const before = store.readProjectionMetadata(rootId)
      store.clearProjectionTables()
      const after = store.rebuildProjections(rootId)

      expect(after).toEqual(before)
      expect(store.getCompactionDecision(rootId)).toEqual({ _tag: 'allowed' })
      expect(store.readOutbox(rootId).map((row) => row.state)).toEqual(['settled'])
    })
  })

  it('rebuilds projections for one root without deleting another root', () => {
    withStore((store) => {
      store.appendEvent(
        remoteWritePlanned({
          eventId: 'root-1-event-1',
          idempotencyKey: 'root-1:command:cmd-1',
          commandId: 'cmd-1',
          rootId,
        }),
      )
      store.appendEvent(
        remoteWritePlanned({
          eventId: 'root-2-event-1',
          idempotencyKey: 'root-2:command:cmd-2',
          commandId: 'cmd-2',
          rootId: otherRootId,
        }),
      )
      store.appendEvent(
        rowObserved({
          eventId: 'root-1-row-1',
          idempotencyKey: 'root-1:row:page-1',
          rootId,
          pageId: 'page-1',
        }),
      )
      store.appendEvent(
        rowObserved({
          eventId: 'root-2-row-1',
          idempotencyKey: 'root-2:row:page-2',
          rootId: otherRootId,
          pageId: 'page-2',
        }),
      )

      store.rebuildProjections(rootId)

      expect(store.readOutbox(rootId).map((row) => row.commandId)).toEqual(['cmd-1'])
      expect(store.readOutbox(otherRootId).map((row) => row.commandId)).toEqual(['cmd-2'])
      expect(store.readPlannerProjectionSnapshot(rootId).rows.map((row) => row.pageId)).toEqual([
        'page-1',
      ])
      expect(
        store.readPlannerProjectionSnapshot(otherRootId).rows.map((row) => row.pageId),
      ).toEqual(['page-2'])
    })
  })

  it('persists query completeness checkpoints without treating absence as trash work', () => {
    withStore((store) => {
      store.appendEvent(
        decode(SyncEvent, {
          _tag: 'QueryScanCheckpointRecorded',
          ...eventBase({
            eventId: 'event-1',
            family: 'QueryScanRecorded',
            eventType: 'QueryScanCheckpointRecorded',
            idempotencyKey: 'query:scan:1',
            canonicalJson: '{"complete":false}',
            surface: 'datasource:data-source-1',
          }),
          dataSourceId: 'data-source-1',
          queryContractHash: hash('e'),
          nextCursor: 'cursor-1',
          complete: false,
          highWatermark: null,
        }),
      )
      store.appendEvent(
        decode(SyncEvent, {
          _tag: 'TombstoneCandidateObserved',
          ...eventBase({
            eventId: 'event-2',
            family: 'RemoteObserved',
            eventType: 'TombstoneCandidateObserved',
            idempotencyKey: 'candidate:local-file-delete:page-1',
            canonicalJson: '{"localFileMissing":true}',
            surface: 'page:page-1',
          }),
          pageId: 'page-1',
          reason: 'local_file_delete_candidate',
        }),
      )

      expect(store.readOutbox(rootId)).toEqual([])
      expect(store.getCompactionDecision(rootId)).toMatchObject({
        _tag: 'blocked',
        blockers: expect.arrayContaining([
          expect.objectContaining({
            message: 'Tombstone for page page-1 is unclassified',
          }),
        ]),
      })
    })
  })
})
