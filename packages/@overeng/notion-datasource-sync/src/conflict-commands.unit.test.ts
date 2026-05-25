import { describe, expect, it } from 'vitest'

import { propertySurfaceKey } from './canonical.ts'
import { resolveConflictCommand } from './conflict-commands.ts'
import { SyncEvent, SyncEventId, type SyncEvent as SyncEventType } from './events.ts'
import { makeConflictRaisedEvent } from './observation.ts'
import {
  decode,
  hash,
  appendPlannedCommand,
  makeFakeClock,
  makeStoreFixture,
  propertyEditIntent,
  propertyPatchValue,
  testIds,
} from './testing/harness.ts'
import { forgetPageCommand, listUserCommandSurface } from './user-commands.ts'

const conflictEvent = (): SyncEventType =>
  makeConflictRaisedEvent({
    rootId: testIds.rootId,
    pageId: testIds.pageId,
    propertyId: testIds.propertyA,
    surface: propertySurfaceKey(testIds.pageId, testIds.propertyA),
    baseHash: hash('property-a-base'),
    localHash: hash('property-a-local'),
    remoteHash: hash('property-a-remote'),
    conflictKind: 'property',
    message: 'Local and remote changed the same property',
    now: () => new Date('2026-05-25T00:00:00.000Z'),
  })

const rowObserved = () =>
  decode(SyncEvent, {
    _tag: 'RowObserved',
    eventId: 'row-observed',
    rootId: testIds.rootId,
    sequence: '0',
    codecVersion: 'v1',
    family: 'RemoteObserved',
    eventType: 'RowObserved',
    idempotencyKey: 'row-observed',
    surface: `page:${testIds.pageId}`,
    causedByEventIds: [],
    payloadHash: hash('payload'),
    payload: {
      _tag: 'VersionedJson',
      codecVersion: 'v1',
      canonicalJson: JSON.stringify({ bodyPath: 'page-1.nmd', sidecarIdentityProven: true }),
    },
    observedAt: '2026-05-25T00:00:00.000Z',
    dataSourceId: testIds.dataSourceId,
    pageId: testIds.pageId,
    propertiesHash: hash('properties-a'),
    inTrash: false,
  })

describe('conflict and user command surface', () => {
  it('lists open conflicts in a stable result envelope', () => {
    const storeFixture = makeStoreFixture({ mode: 'memory' })

    try {
      storeFixture.store.appendEvent(conflictEvent())

      expect(
        listUserCommandSurface({ store: storeFixture.store, rootId: testIds.rootId }),
      ).toMatchObject({
        _tag: 'UserCommandResultEnvelope',
        version: 'v1',
        action: 'list',
        dryRun: false,
        status: { state: 'conflict' },
        surface: {
          conflicts: [
            {
              conflictId: expect.any(String),
              state: 'open',
              kind: 'same-property',
              pageId: testIds.pageId,
              propertyId: testIds.propertyA,
            },
          ],
          outbox: [],
        },
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('dry-runs conflict resolution without appending events or commands', () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })

    try {
      const conflict = storeFixture.store.appendEvent(conflictEvent())
      const beforeEvents = storeFixture.store.replay(testIds.rootId).length
      const beforeOutbox = storeFixture.store.readOutbox(testIds.rootId).length

      const result = resolveConflictCommand({
        store: storeFixture.store,
        rootId: testIds.rootId,
        conflictId: decode(SyncEventId, conflict.eventId),
        choice: { _tag: 'keep-remote' },
        dryRun: true,
        now: clock.now,
      })

      expect(result).toMatchObject({
        dryRun: true,
        planned: { events: [{ _tag: 'ConflictResolved' }], commands: [], guards: [] },
        applied: { events: [], commands: [], guards: [] },
        status: { state: 'conflict' },
      })
      expect(storeFixture.store.replay(testIds.rootId)).toHaveLength(beforeEvents)
      expect(storeFixture.store.readOutbox(testIds.rootId)).toHaveLength(beforeOutbox)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('forget appends a durable event and removes local row tracking through replay', () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })

    try {
      storeFixture.store.appendEvent(rowObserved())
      appendPlannedCommand(storeFixture.store, {
        commandId: testIds.commandId,
        commandKey: testIds.commandKey,
        rootId: testIds.rootId,
        intentEventId: testIds.intentEventId,
        surface: propertySurfaceKey(testIds.pageId, testIds.propertyA),
        command: propertyEditIntent().command,
        baseHash: hash('properties-a'),
        desiredHash: hash('properties-next'),
        preflight: ['StaleSurfaceBase'],
      })
      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).rows).toHaveLength(1)
      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([{ state: 'queued' }])

      const result = forgetPageCommand({
        store: storeFixture.store,
        rootId: testIds.rootId,
        pageId: testIds.pageId,
        now: clock.now,
      })

      expect(result.applied.events).toMatchObject([{ _tag: 'RowForgotten' }])
      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).rows).toEqual([])
      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([{ state: 'fenced' }])
      storeFixture.store.clearProjectionTables()
      storeFixture.store.rebuildProjections(testIds.rootId)
      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).rows).toEqual([])
      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([{ state: 'fenced' }])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('returns a guard envelope when resolving a missing conflict', () => {
    const storeFixture = makeStoreFixture({ mode: 'memory' })

    try {
      expect(
        resolveConflictCommand({
          store: storeFixture.store,
          rootId: testIds.rootId,
          conflictId: decode(SyncEventId, 'missing-conflict'),
          choice: { _tag: 'keep-local', value: propertyPatchValue('Local') },
        }),
      ).toMatchObject({
        planned: {
          guards: [{ guard: 'CurrentSurfaceMissing' }],
        },
        applied: {
          guards: [{ guard: 'CurrentSurfaceMissing' }],
        },
      })
    } finally {
      storeFixture.cleanup()
    }
  })
})
