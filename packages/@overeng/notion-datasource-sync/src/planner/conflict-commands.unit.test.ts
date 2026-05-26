import { describe, expect, it } from 'vitest'

import { propertySurfaceKey } from '../core/canonical.ts'
import { SyncEvent, SyncEventId, type SyncEvent as SyncEventType } from '../core/events.ts'
import { makeConflictRaisedEvent } from '../sync/observation.ts'
import {
  decode,
  hash,
  appendPlannedCommand,
  makeFakeClock,
  makeStoreFixture,
  propertyEditIntent,
  propertyPatchValue,
  testIds,
} from '../testing/harness.ts'
import { resolveConflictCommand } from './conflict-commands.ts'
import { forgetPageCommand, listUserCommandSurface } from './user-commands.ts'

const conflictEvent = (): SyncEventType =>
  makeConflictRaisedEvent({
    rootId: testIds.rootId,
    pageId: testIds.pageId,
    propertyId: testIds.propertyA,
    surface: propertySurfaceKey({ pageId: testIds.pageId, propertyId: testIds.propertyA }),
    baseHash: hash('property-a-base'),
    localHash: hash('property-a-local'),
    remoteHash: hash('property-a-remote'),
    conflictKind: 'property',
    message: 'Local and remote changed the same property',
    now: () => new Date('2026-05-25T00:00:00.000Z'),
  })

const rowObserved = () =>
  decode({ schema: SyncEvent, value: {
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
  } })

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
        conflictId: decode({ schema: SyncEventId, value: conflict.eventId }),
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
      appendPlannedCommand({ store: storeFixture.store, command: {
        commandId: testIds.commandId,
        commandKey: testIds.commandKey,
        rootId: testIds.rootId,
        intentEventId: testIds.intentEventId,
        surface: propertySurfaceKey({ pageId: testIds.pageId, propertyId: testIds.propertyA }),
        command: propertyEditIntent().command,
        baseHash: hash('properties-a'),
        desiredHash: hash('properties-next'),
        preflight: ['StaleSurfaceBase'],
      } })
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
          conflictId: decode({ schema: SyncEventId, value: 'missing-conflict' }),
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

  it.each([
    ['keep-local', { _tag: 'keep-local' as const, value: propertyPatchValue('Local') }],
    ['manual', { _tag: 'manual' as const, value: propertyPatchValue('Manual') }],
  ])(
    'keeps a %s resolution conflict open when planning is blocked by a guard',
    (_label, choice) => {
      const clock = makeFakeClock()
      const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })

      try {
        const conflict = storeFixture.store.appendEvent(conflictEvent())
        const conflictId = decode({ schema: SyncEventId, value: conflict.eventId })

        const result = resolveConflictCommand({
          store: storeFixture.store,
          rootId: testIds.rootId,
          conflictId,
          choice,
          now: clock.now,
        })

        expect(result).toMatchObject({
          status: { state: 'conflict' },
          planned: {
            events: [],
            commands: [],
            guards: [{ guard: 'CurrentSurfaceMissing' }],
          },
          applied: {
            events: [],
            commands: [],
            guards: [{ guard: 'CurrentSurfaceMissing' }],
          },
          surface: {
            conflicts: [{ conflictId: conflict.eventId, state: 'open' }],
            outbox: [],
          },
        })
        expect(storeFixture.store.readConflicts(testIds.rootId)).toMatchObject([
          { conflictId: conflict.eventId, state: 'open' },
        ])
        expect(storeFixture.store.readOutbox(testIds.rootId)).toEqual([])

        storeFixture.store.clearProjectionTables()
        storeFixture.store.rebuildProjections(testIds.rootId)
        expect(
          listUserCommandSurface({ store: storeFixture.store, rootId: testIds.rootId }),
        ).toMatchObject({
          status: { state: 'conflict' },
          surface: {
            conflicts: [{ conflictId: conflict.eventId, state: 'open' }],
            outbox: [],
          },
        })
      } finally {
        storeFixture.cleanup()
      }
    },
  )
})
