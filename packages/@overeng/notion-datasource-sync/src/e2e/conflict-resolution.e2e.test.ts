import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { PagePropertyItemPage } from '../core/commands.ts'
import { AbsolutePath } from '../core/domain.ts'
import { SyncEvent, SyncEventId } from '../core/events.ts'
import { LocalWorkspacePort, NotionDataSourceGateway, PageBodySyncPort } from '../core/ports.ts'
import {
  forgetPageCommand,
  listUserCommandSurface,
  resolveConflictCommand,
  restorePageCommand,
  type ConflictResolutionChoice,
} from '../planner/user-commands.ts'
import { hashStoreBytes } from '../store/projections.ts'
import { executeOutboxOnce } from '../sync/executor.ts'
import { initOneShotSync, pullOneShotSync, pushOneShotSync } from '../sync/sync.ts'
import {
  defaultQueryContract,
  decode,
  hash,
  makeFakeClock,
  makeFakeGatewayHarness,
  makeHarnessPorts,
  makeStoreFixture,
  pageSnapshot,
  propertyEditIntent,
  propertyPatchValue,
  testIds,
} from '../testing/harness.ts'

const workspaceRoot = decode(AbsolutePath, '/tmp/notion-ds-sync-conflicts')

const schemaProperties = [
  {
    propertyId: testIds.propertyA,
    configHash: hash('config-a'),
    writeClass: 'writable' as const,
  },
]

const propertyPage = (valueHash = hash('property-a-base')) =>
  decode(PagePropertyItemPage, {
    _tag: 'PagePropertyItemPage',
    apiVersion: '2026-03-11',
    requestId: testIds.requestId,
    pageId: testIds.pageId,
    propertyId: testIds.propertyA,
    items: [
      {
        _tag: 'PagePropertyItem',
        pageId: testIds.pageId,
        propertyId: testIds.propertyA,
        itemHash: valueHash,
        valueHash,
      },
    ],
    nextCursor: null,
    hasMore: false,
  })

const runWithPorts = <TValue, TError>(
  effect: Effect.Effect<
    TValue,
    TError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  >,
  input: {
    readonly gateway: ReturnType<typeof makeFakeGatewayHarness>['gateway']
    readonly body?: ReturnType<typeof makeHarnessPorts>['body']
    readonly workspace?: ReturnType<typeof makeHarnessPorts>['workspace']
  },
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(NotionDataSourceGateway, input.gateway),
      Effect.provideService(PageBodySyncPort, input.body ?? makeHarnessPorts().body),
      Effect.provideService(LocalWorkspacePort, input.workspace ?? makeHarnessPorts().workspace),
    ),
  )

const seedSamePropertyConflict = async () => {
  const clock = makeFakeClock()
  const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
  const baseGateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
  const remoteGateway = makeFakeGatewayHarness({
    pages: [pageSnapshot({ propertiesHash: hash('properties-remote') })],
    propertyPages: [propertyPage(hash('property-a-remote'))],
  })

  initOneShotSync({
    store: storeFixture.store,
    rootId: testIds.rootId,
    dataSourceId: testIds.dataSourceId,
    workspaceRoot,
    now: clock.now,
  })
  await runWithPorts(
    pullOneShotSync({
      store: storeFixture.store,
      rootId: testIds.rootId,
      dataSourceId: testIds.dataSourceId,
      workspaceRoot,
      queryContract: defaultQueryContract(),
      schemaProperties,
      now: clock.now,
    }),
    { gateway: baseGateway.gateway },
  )
  clock.advanceMillis(1)
  await runWithPorts(
    pullOneShotSync({
      store: storeFixture.store,
      rootId: testIds.rootId,
      dataSourceId: testIds.dataSourceId,
      workspaceRoot,
      queryContract: defaultQueryContract(),
      schemaProperties,
      now: clock.now,
    }),
    { gateway: remoteGateway.gateway },
  )
  clock.advanceMillis(1)
  await runWithPorts(
    pushOneShotSync({
      store: storeFixture.store,
      rootId: testIds.rootId,
      workspaceRoot,
      localIntents: [
        propertyEditIntent({
          baseHash: hash('property-a-base'),
          desiredHash: hashStoreBytes(
            `page-properties\t${testIds.pageId}\t${testIds.commandId}\t${testIds.propertyA}`,
          ),
          expectedPropertyConfigHash: hash('config-a'),
        }),
      ],
      maxExecutorSteps: 1,
      now: clock.now,
    }),
    { gateway: remoteGateway.gateway },
  )

  return { clock, storeFixture }
}

const runExecutor = ({
  store,
  gateway,
}: {
  readonly store: ReturnType<typeof makeStoreFixture>['store']
  readonly gateway: ReturnType<typeof makeFakeGatewayHarness>['gateway']
}) =>
  runWithPorts(
    executeOutboxOnce({
      store,
      rootId: testIds.rootId,
      leaseToken: 'lease-1',
      leaseDurationMs: 60_000,
    }),
    { gateway },
  )

const conflictIdFromList = (store: ReturnType<typeof makeStoreFixture>['store']) => {
  const list = listUserCommandSurface({ store, rootId: testIds.rootId })
  expect(list).toMatchObject({
    status: { state: 'conflict' },
    surface: { conflicts: [{ kind: 'same-property', propertyId: testIds.propertyA }] },
  })

  return decode(SyncEventId, list.surface.conflicts[0]!.conflictId)
}

describe('conflict resolution user command E2E', () => {
  it.each([
    ['keep-local', { _tag: 'keep-local', value: propertyPatchValue('Local wins') }],
    ['manual', { _tag: 'manual', value: propertyPatchValue('Manual value') }],
  ] satisfies ReadonlyArray<readonly [string, ConflictResolutionChoice]>)(
    'lists and resolves a same-property conflict with %s through the outbox executor',
    async (_label, choice) => {
      const { clock, storeFixture } = await seedSamePropertyConflict()
      const conflictId = conflictIdFromList(storeFixture.store)
      const gatewayHarness = makeFakeGatewayHarness({
        pages: [pageSnapshot({ propertiesHash: hash('properties-remote') })],
        propertyPages: [propertyPage(hash('property-a-remote'))],
      })

      try {
        clock.advanceMillis(1)
        const resolved = resolveConflictCommand({
          store: storeFixture.store,
          rootId: testIds.rootId,
          conflictId,
          choice,
          now: clock.now,
        })

        expect(resolved).toMatchObject({
          status: { state: 'pending' },
          applied: {
            events: [{ _tag: 'ConflictResolved' }],
            commands: [{ command: { _tag: 'PatchPagePropertiesCommand' } }],
          },
        })
        await expect(
          runExecutor({ store: storeFixture.store, gateway: gatewayHarness.gateway }),
        ).resolves.toMatchObject({
          _tag: 'settled',
          settlementKind: 'verified-success',
        })
        expect(gatewayHarness.ledger.successfulPatchPageProperties).toHaveLength(1)
        expect(
          listUserCommandSurface({ store: storeFixture.store, rootId: testIds.rootId }),
        ).toMatchObject({
          status: { state: 'clean' },
          surface: { conflicts: [], outbox: [] },
        })
      } finally {
        storeFixture.cleanup()
      }
    },
  )

  it('lists and resolves a same-property conflict by keeping remote without enqueueing a write', async () => {
    const { clock, storeFixture } = await seedSamePropertyConflict()

    try {
      const result = resolveConflictCommand({
        store: storeFixture.store,
        rootId: testIds.rootId,
        conflictId: conflictIdFromList(storeFixture.store),
        choice: { _tag: 'keep-remote' },
        now: clock.now,
      })

      expect(result).toMatchObject({
        status: { state: 'clean' },
        applied: { events: [{ _tag: 'ConflictResolved' }], commands: [] },
        surface: { conflicts: [], outbox: [] },
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it.each([
    ['keep-local', { _tag: 'keep-local', value: propertyPatchValue('Local wins') }],
    ['manual', { _tag: 'manual', value: propertyPatchValue('Manual value') }],
  ] satisfies ReadonlyArray<readonly [string, ConflictResolutionChoice]>)(
    'blocks stale %s resolution when the remote property moved after the conflict snapshot',
    async (_label, choice) => {
      const { clock, storeFixture } = await seedSamePropertyConflict()
      const conflictId = conflictIdFromList(storeFixture.store)
      const newerRemoteGateway = makeFakeGatewayHarness({
        pages: [pageSnapshot({ propertiesHash: hash('properties-newer-remote') })],
        propertyPages: [propertyPage(hash('property-a-newer-remote'))],
      })

      try {
        clock.advanceMillis(1)
        await runWithPorts(
          pullOneShotSync({
            store: storeFixture.store,
            rootId: testIds.rootId,
            dataSourceId: testIds.dataSourceId,
            workspaceRoot,
            queryContract: defaultQueryContract(),
            schemaProperties,
            now: clock.now,
          }),
          { gateway: newerRemoteGateway.gateway },
        )

        clock.advanceMillis(1)
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
            guards: [{ guard: 'StaleSurfaceBase' }],
          },
          applied: {
            events: [],
            commands: [],
            guards: [{ guard: 'StaleSurfaceBase' }],
          },
          surface: {
            conflicts: [{ conflictId, state: 'open' }],
            outbox: [],
          },
        })
        expect(newerRemoteGateway.ledger.successfulPatchPageProperties).toHaveLength(0)
        expect(storeFixture.store.readOutbox(testIds.rootId)).toEqual([])

        storeFixture.store.clearProjectionTables()
        storeFixture.store.rebuildProjections(testIds.rootId)
        expect(
          listUserCommandSurface({ store: storeFixture.store, rootId: testIds.rootId }),
        ).toMatchObject({
          status: { state: 'conflict' },
          surface: {
            conflicts: [{ conflictId, state: 'open' }],
            outbox: [],
          },
        })
      } finally {
        storeFixture.cleanup()
      }
    },
  )

  it('forget removes local tracking without calling remote mutations', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gatewayHarness = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          now: clock.now,
        }),
        { gateway: gatewayHarness.gateway },
      )

      const result = forgetPageCommand({
        store: storeFixture.store,
        rootId: testIds.rootId,
        pageId: testIds.pageId,
        now: clock.now,
      })

      expect(result.applied.events).toMatchObject([{ _tag: 'RowForgotten' }])
      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId)).toMatchObject({
        rows: [],
        properties: [],
        bodies: [],
      })
      expect(gatewayHarness.ledger).toMatchObject({
        attemptedPatchPageProperties: [],
        attemptedTrashPages: [],
        attemptedRestorePages: [],
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('restore from a classified tombstone enqueues restore and executor verifies restored state', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gatewayHarness = makeFakeGatewayHarness({
      pages: [pageSnapshot({ inTrash: true })],
      propertyPages: [propertyPage()],
    })

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          now: clock.now,
        }),
        { gateway: gatewayHarness.gateway },
      )
      storeFixture.store.appendEvent(
        decode(SyncEvent, {
          _tag: 'TombstoneRecorded',
          eventId: 'tombstone-remote-trash',
          rootId: testIds.rootId,
          sequence: '0',
          codecVersion: 'v1',
          family: 'TombstoneClassified',
          eventType: 'TombstoneRecorded',
          idempotencyKey: 'tombstone-remote-trash',
          surface: `page:${testIds.pageId}`,
          causedByEventIds: [],
          payloadHash: hash('tombstone'),
          payload: {
            _tag: 'VersionedJson',
            codecVersion: 'v1',
            canonicalJson: '{}',
          },
          observedAt: clock.now().toISOString(),
          pageId: testIds.pageId,
          reason: 'remote_trash',
        }),
      )

      const result = restorePageCommand({
        store: storeFixture.store,
        rootId: testIds.rootId,
        pageId: testIds.pageId,
        now: clock.now,
      })

      expect(result).toMatchObject({
        status: { state: 'pending' },
        applied: { commands: [{ command: { _tag: 'RestorePageCommand' } }] },
      })
      await expect(
        runExecutor({ store: storeFixture.store, gateway: gatewayHarness.gateway }),
      ).resolves.toMatchObject({
        _tag: 'settled',
        settlementKind: 'verified-success',
      })
      expect(gatewayHarness.ledger.successfulRestorePages).toHaveLength(1)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('dry-run reports planned changes and leaves event and outbox counts unchanged', async () => {
    const { clock, storeFixture } = await seedSamePropertyConflict()

    try {
      const conflictId = conflictIdFromList(storeFixture.store)
      const beforeEvents = storeFixture.store.replay(testIds.rootId).length
      const beforeOutbox = storeFixture.store.readOutbox(testIds.rootId).length
      const result = resolveConflictCommand({
        store: storeFixture.store,
        rootId: testIds.rootId,
        conflictId,
        choice: { _tag: 'manual', value: propertyPatchValue('Dry run') },
        dryRun: true,
        now: clock.now,
      })

      expect(result).toMatchObject({
        dryRun: true,
        planned: {
          events: [{ _tag: 'ConflictResolved' }],
          commands: [{ command: { _tag: 'PatchPagePropertiesCommand' } }],
        },
        applied: { events: [], commands: [] },
        status: { state: 'conflict' },
      })
      expect(storeFixture.store.replay(testIds.rootId)).toHaveLength(beforeEvents)
      expect(storeFixture.store.readOutbox(testIds.rootId)).toHaveLength(beforeOutbox)
    } finally {
      storeFixture.cleanup()
    }
  })
})
