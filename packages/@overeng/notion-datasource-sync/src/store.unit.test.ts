import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Schema } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  Hash,
  SyncEvent,
  SyncRootId,
  hashStoreBytes,
  openNotionSyncStore,
  type NotionSyncStore,
  type SyncEvent as SyncEventType,
} from './mod.ts'

const decode = <TSchema extends Schema.Schema.AnyNoContext>(schema: TSchema, value: unknown) =>
  Schema.decodeUnknownSync(schema)(value)

const hash = (value: string) => decode(Hash, `sha256:${value.repeat(64).slice(0, 64)}`)
const rootId = decode(SyncRootId, 'root-1')
const otherRootId = decode(SyncRootId, 'root-2')
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
      surface: 'page:page-1',
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
    attempt: 1,
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
      store.replaceProjectionDigestForRepairTest(rootId, hash('f'))

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

      store.rebuildProjections(rootId)

      expect(store.readOutbox(rootId).map((row) => row.commandId)).toEqual(['cmd-1'])
      expect(store.readOutbox(otherRootId).map((row) => row.commandId)).toEqual(['cmd-2'])
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
