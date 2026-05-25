import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeFakePageBodySyncPort } from '../body-adapter.ts'
import { PatchPagePropertiesCommand, PagePropertyItemPage } from '../commands.ts'
import { AbsolutePath, type MaterializePlan } from '../domain.ts'
import { makeFakeLocalWorkspacePort } from '../local-workspace.ts'
import { LocalWorkspacePort, NotionDataSourceGateway, PageBodySyncPort } from '../ports.ts'
import { hashStoreBytes } from '../store-projections.ts'
import { initOneShotSync, pullOneShotSync, pushOneShotSync, syncOneShot } from '../sync.ts'
import {
  defaultQueryContract,
  decode,
  fakeBodyPage,
  fixedObservedAt,
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

const workspaceRoot = decode(AbsolutePath, '/tmp/notion-ds-sync-one-shot')

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

describe('one-shot sync orchestration', () => {
  it('initial bind and pull produce clean status while dry-run status does not write', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gatewayHarness = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })

    try {
      expect(
        initOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          dryRun: true,
          now: clock.now,
        }),
      ).toMatchObject({ state: 'clean', binding: undefined })
      expect(storeFixture.store.replay(testIds.rootId)).toEqual([])

      const initStatus = initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      expect(initStatus).toMatchObject({
        state: 'clean',
        binding: { dataSourceId: testIds.dataSourceId, workspaceRoot },
      })

      const pull = await runWithPorts(
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

      expect(pull.status).toMatchObject({
        state: 'clean',
        counts: {
          pending: 0,
          conflict: 0,
          blocked: 0,
          projections: { dataSources: 1, rows: 1, properties: 1, bodies: 1 },
        },
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('pulls a remote property change into projections and remains locally clean', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })

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
        { gateway: makeFakeGatewayHarness({ propertyPages: [propertyPage()] }).gateway },
      )
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
        {
          gateway: makeFakeGatewayHarness({
            pages: [pageSnapshot({ propertiesHash: hash('properties-remote') })],
            propertyPages: [propertyPage(hash('property-a-remote'))],
          }).gateway,
        },
      )

      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).properties).toEqual([
        {
          pageId: testIds.pageId,
          propertyId: testIds.propertyA,
          baseHash: hash('property-a-base'),
          remoteHash: hash('property-a-remote'),
          availability: 'complete',
          pendingLocal: undefined,
        },
      ])
      expect(storeFixture.store.readStatusProjection(testIds.rootId).outbox.queued).toBe(0)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('plans, enqueues, and executes a local property edit through the fake gateway', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gatewayHarness = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const expectedPropertiesHash = hashStoreBytes(
      `page-properties\t${testIds.pageId}\t${testIds.commandId}\t${testIds.propertyA}`,
    )

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

      const command = decode(PatchPagePropertiesCommand, {
        _tag: 'PatchPagePropertiesCommand',
        commandId: testIds.commandId,
        pageId: testIds.pageId,
        basePropertiesHash: hash('properties-a'),
        propertyPatch: { [testIds.propertyA]: propertyPatchValue('Local edit') },
      })
      const push = await runWithPorts(
        pushOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          workspaceRoot,
          localIntents: [
            propertyEditIntent({
              command,
              baseHash: hash('property-a-base'),
              desiredHash: expectedPropertiesHash,
              expectedPropertyConfigHash: hash('config-a'),
            }),
          ],
          now: clock.now,
        }),
        { gateway: gatewayHarness.gateway },
      )

      expect(push.plan).toMatchObject({ enqueuedCommands: 1, blocked: 0, conflicts: 0 })
      expect(push.executor.results).toContainEqual({
        _tag: 'settled',
        commandId: testIds.commandId,
        settlementKind: 'verified-success',
      })
      expect(gatewayHarness.ledger.successfulPatchPageProperties).toEqual([command])
      expect(push.status).toMatchObject({ state: 'clean', counts: { pending: 0 } })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('records query cap incompleteness without advancing absence or tombstone facts', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gatewayHarness = makeFakeGatewayHarness({
      queryResultCap: 1,
      pages: [
        pageSnapshot(),
        pageSnapshot({
          pageId: testIds.otherPageId,
          propertiesHash: hash('properties-other'),
        }),
      ],
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
      const pull = await runWithPorts(
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

      expect(pull.observation.query).toMatchObject({
        rows: 1,
        complete: false,
        cappedAtLimit: true,
      })
      expect(pull.status).toMatchObject({
        state: 'blocked',
        counts: {
          blocked: 2,
          tombstones: { unclassified: 0 },
          checkpoints: { incompleteQueries: 1, cappedQueries: 1 },
        },
      })
      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).tombstones).toEqual(
        [],
      )
    } finally {
      storeFixture.cleanup()
    }
  })

  it('materializes bodies through PageBodySyncPort without datasource mutation', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gatewayHarness = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const materializedPlans: MaterializePlan[] = []
    const baseWorkspace = makeFakeLocalWorkspacePort()
    const workspace = {
      ...baseWorkspace,
      materialize: (plan: MaterializePlan) =>
        baseWorkspace
          .materialize(plan)
          .pipe(Effect.tap(() => Effect.sync(() => materializedPlans.push(plan)))),
    }
    let observedBodies = 0
    const baseBody = makeFakePageBodySyncPort({ pages: [fakeBodyPage()] })
    const body = {
      ...baseBody,
      observe: (input: {
        readonly _tag: 'ObserveBodyInput'
        readonly pageId: typeof testIds.pageId
      }) =>
        baseBody.observe(input).pipe(Effect.tap(() => Effect.sync(() => (observedBodies += 1)))),
    }

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
        { gateway: gatewayHarness.gateway, body, workspace },
      )

      expect(observedBodies).toBe(1)
      expect(materializedPlans).toMatchObject([
        { pageId: testIds.pageId, bodyPointer: { bodyHash: hash('body-a') } },
      ])
      expect(gatewayHarness.ledger.successfulPatchPageProperties).toEqual([])
      expect(gatewayHarness.ledger.successfulPatchDataSourceSchemas).toEqual([])
      expect(gatewayHarness.ledger.successfulTrashPages).toEqual([])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('is clean and no-op on an idempotent second sync', async () => {
    const clock = makeFakeClock(fixedObservedAt)
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
      const options = {
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        queryContract: defaultQueryContract(),
        schemaProperties,
        now: clock.now,
      }
      const first = await runWithPorts(syncOneShot(options), { gateway: gatewayHarness.gateway })
      const eventCountAfterFirst = storeFixture.store.replay(testIds.rootId).length
      const second = await runWithPorts(syncOneShot(options), { gateway: gatewayHarness.gateway })

      expect(first.status.state).toBe('clean')
      expect(second.status.state).toBe('clean')
      expect(second.push.plan).toMatchObject({
        appendedEvents: 0,
        enqueuedCommands: 0,
        blocked: 0,
        conflicts: 0,
      })
      expect(second.push.executor.results).toEqual([{ _tag: 'idle' }])
      expect(storeFixture.store.replay(testIds.rootId)).toHaveLength(eventCountAfterFirst)
    } finally {
      storeFixture.cleanup()
    }
  })
})
