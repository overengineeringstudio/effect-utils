import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeFakePageBodySyncPort } from '../body-adapter.ts'
import { runCliCommand, type CliContext } from '../cli.ts'
import { PagePropertyItemPage } from '../commands.ts'
import {
  readWatchDaemonState,
  runWatchDaemon,
  runWatchDaemonCycle,
  type WatchDaemonOptions,
} from '../daemon.ts'
import {
  AbsolutePath,
  BodyPointer,
  WorkspaceRelativePath,
  type Hash as HashType,
  type PageId as PageIdType,
} from '../domain.ts'
import { BodySyncError } from '../errors.ts'
import { SyncEventId } from '../events.ts'
import { makeGatewayError } from '../gateway.ts'
import {
  isOwnWriteObservation,
  makeFilesystemLocalWorkspacePort,
  presentArtifactObservation,
} from '../local-workspace.ts'
import { LocalWorkspacePort, NotionDataSourceGateway, PageBodySyncPort } from '../ports.ts'
import { initOneShotSync, pullOneShotSync } from '../sync.ts'
import { collectWorkspaceScan, makeTempWorkspace } from '../testing/filesystem.ts'
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
  testIds,
} from '../testing/harness.ts'

const workspaceRoot = decode(AbsolutePath, '/tmp/notion-ds-sync-daemon')

const schemaProperties = [
  {
    propertyId: testIds.propertyA,
    configHash: hash('config-a'),
    writeClass: 'writable' as const,
  },
]

const propertyPage = ({
  pageId = testIds.pageId,
  itemHash = hash('property-a-base'),
}: {
  readonly pageId?: PageIdType
  readonly itemHash?: HashType
} = {}) =>
  decode(PagePropertyItemPage, {
    _tag: 'PagePropertyItemPage',
    apiVersion: '2026-03-11',
    requestId: testIds.requestId,
    pageId,
    propertyId: testIds.propertyA,
    items: [
      {
        _tag: 'PagePropertyItem',
        pageId,
        propertyId: testIds.propertyA,
        itemHash,
        valueHash: itemHash,
      },
    ],
    nextCursor: null,
    hasMore: false,
  })

const bodyPage = ({
  pageId = testIds.pageId,
  bodyHash = hash('body-a'),
}: {
  readonly pageId?: PageIdType
  readonly bodyHash?: HashType
} = {}) =>
  fakeBodyPage({
    pageId,
    pointer: decode(BodyPointer, {
      _tag: 'BodyPointer',
      pageId,
      bodyHash,
      observedAt: fixedObservedAt,
    }),
  })

const localBodyChange = ({
  pageId = testIds.pageId,
  path = decode(WorkspaceRelativePath, 'row--page-1.nmd'),
  contentHash = hash('body-local'),
}: {
  readonly pageId?: PageIdType
  readonly path?: typeof WorkspaceRelativePath.Type
  readonly contentHash?: HashType
} = {}) =>
  presentArtifactObservation({
    pageId,
    path,
    contentHash,
    observedAt: decode(Schema.DateTimeUtc, fixedObservedAt),
  })

const context = (input: {
  readonly store: CliContext['store']
  readonly clock: ReturnType<typeof makeFakeClock>
  readonly queryContract?: CliContext['queryContract']
  readonly workspaceRoot?: CliContext['workspaceRoot']
}): CliContext => ({
  store: input.store,
  rootId: testIds.rootId,
  dataSourceId: testIds.dataSourceId,
  workspaceRoot: input.workspaceRoot ?? workspaceRoot,
  queryContract: input.queryContract ?? defaultQueryContract(),
  schemaProperties,
  now: input.clock.now,
})

const daemonOptions = (input: {
  readonly store: WatchDaemonOptions['store']
  readonly statePath: string
  readonly clock: ReturnType<typeof makeFakeClock>
  readonly maxExecutorSteps?: number
  readonly maxCycles?: number
  readonly leaseToken?: string
  readonly signal?: AbortSignal
  readonly useDefaultLease?: boolean
  readonly leaseDurationMs?: number
  readonly sleep?: WatchDaemonOptions['sleep']
  readonly queryContract?: WatchDaemonOptions['queryContract']
  readonly workspaceRoot?: WatchDaemonOptions['workspaceRoot']
}): WatchDaemonOptions => ({
  store: input.store,
  rootId: testIds.rootId,
  dataSourceId: testIds.dataSourceId,
  workspaceRoot: input.workspaceRoot ?? workspaceRoot,
  queryContract: input.queryContract ?? defaultQueryContract(),
  schemaProperties,
  statePath: input.statePath,
  ...(input.useDefaultLease === true
    ? {}
    : { leaseToken: input.leaseToken ?? 'daemon-test-lease' }),
  now: input.clock.now,
  ...(input.maxExecutorSteps === undefined ? {} : { maxExecutorSteps: input.maxExecutorSteps }),
  ...(input.maxCycles === undefined ? {} : { maxCycles: input.maxCycles }),
  ...(input.leaseDurationMs === undefined ? {} : { leaseDurationMs: input.leaseDurationMs }),
  ...(input.signal === undefined ? {} : { signal: input.signal }),
  ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
})

const runWithPorts = <TValue, TError>(
  effect: Effect.Effect<
    TValue,
    TError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  >,
  input: {
    readonly gateway: ReturnType<typeof makeFakeGatewayHarness>['gateway']
    readonly body: ReturnType<typeof makeHarnessPorts>['body']
    readonly workspace: ReturnType<typeof makeHarnessPorts>['workspace']
  },
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(NotionDataSourceGateway, input.gateway),
      Effect.provideService(PageBodySyncPort, input.body),
      Effect.provideService(LocalWorkspacePort, input.workspace),
    ),
  )

describe('watch daemon surface', () => {
  it('runs unbounded by default until cancellation instead of stopping after one cycle', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ports = makeHarnessPorts()
    const statePath = `${storeFixture.path}.watch.json`
    const controller = new AbortController()
    const sleeps: number[] = []

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })

      const result = await runWithPorts(
        runWatchDaemon(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            signal: controller.signal,
            sleep: (millis) =>
              Effect.sync(() => {
                sleeps.push(millis)
                controller.abort()
              }),
          }),
        ),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )

      expect(result).toMatchObject({
        cycles: 2,
        completed: 1,
        cancelled: true,
      })
      expect(sleeps).toEqual([5_000])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('records retry repair state, honors backoff, and continues after a cycle failure', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ports = makeHarnessPorts()
    const statePath = `${storeFixture.path}.watch.json`
    const sleeps: number[] = []
    let retrieveAttempts = 0
    const flakyGateway = {
      ...gateway.gateway,
      retrieveDataSource: (
        dataSourceId: Parameters<typeof gateway.gateway.retrieveDataSource>[0],
      ) =>
        retrieveAttempts === 0
          ? Effect.sync(() => {
              retrieveAttempts += 1
            }).pipe(
              Effect.zipRight(
                Effect.fail(
                  makeGatewayError({
                    operation: 'retrieveDataSource',
                    dataSourceId,
                    message: 'temporary retrieve failure',
                  }),
                ),
              ),
            )
          : gateway.gateway.retrieveDataSource(dataSourceId),
    }

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })

      const result = await runWithPorts(
        runWatchDaemon(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxCycles: 2,
            sleep: (millis) =>
              Effect.sync(() => {
                sleeps.push(millis)
              }),
          }),
        ),
        { gateway: flakyGateway, body: ports.body, workspace: ports.workspace },
      )

      expect(result).toMatchObject({
        cycles: 2,
        completed: 1,
        cancelled: false,
        state: { repair: { _tag: 'none' } },
      })
      expect(sleeps).toEqual([5_000])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('uses process-unique default lease tokens across overlapping watcher attempts', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const statePath = `${storeFixture.path}.watch.json`
    const baseBody = makeFakePageBodySyncPort({ pages: [bodyPage()] })
    const failingBody = {
      ...baseBody,
      push: (command: Parameters<typeof baseBody.push>[0]) =>
        Effect.fail(
          new BodySyncError({
            operation: 'push',
            pageId: command.pageId,
            message: 'temporary body push failure',
          }),
        ),
    }
    const workspace = makeHarnessPorts({ localObservations: [localBodyChange()] }).workspace

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
          ...context({ store: storeFixture.store, clock }),
          store: storeFixture.store,
        }),
        { gateway: gateway.gateway, body: baseBody, workspace: makeHarnessPorts().workspace },
      )
      await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxExecutorSteps: 0,
          }),
        ),
        { gateway: gateway.gateway, body: baseBody, workspace },
      )

      await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxExecutorSteps: 1,
            useDefaultLease: true,
          }),
        ),
        { gateway: gateway.gateway, body: failingBody, workspace },
      )
      const staleLeaseToken = storeFixture.store.readOutbox(testIds.rootId)[0]?.leaseToken

      await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxExecutorSteps: 1,
            useDefaultLease: true,
          }),
        ),
        { gateway: gateway.gateway, body: failingBody, workspace },
      )
      const currentLeaseToken = storeFixture.store.readOutbox(testIds.rootId)[0]?.leaseToken

      expect(staleLeaseToken).toMatch(/^watch:root-1:/)
      expect(currentLeaseToken).toMatch(/^watch:root-1:/)
      expect(currentLeaseToken).not.toBe(staleLeaseToken)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('processes a local body change once across restart and cancellation', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const statePath = `${storeFixture.path}.watch.json`
    let bodyPushes = 0
    const baseBody = makeFakePageBodySyncPort({ pages: [bodyPage()] })
    const body = {
      ...baseBody,
      push: (command: Parameters<typeof baseBody.push>[0]) =>
        Effect.sync(() => {
          bodyPushes += 1
        }).pipe(Effect.zipRight(baseBody.push(command))),
    }
    const workspace = makeHarnessPorts({ localObservations: [localBodyChange()] }).workspace

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
          ...context({ store: storeFixture.store, clock }),
          store: storeFixture.store,
        }),
        { gateway: gateway.gateway, body, workspace: makeHarnessPorts().workspace },
      )

      const pending = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxExecutorSteps: 0,
          }),
        ),
        { gateway: gateway.gateway, body, workspace },
      )
      expect(pending.status.state).toBe('pending')
      expect(bodyPushes).toBe(0)

      const controller = new AbortController()
      controller.abort()
      const cancelled = await runWithPorts(
        runWatchDaemon(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            signal: controller.signal,
          }),
        ),
        { gateway: gateway.gateway, body, workspace },
      )
      expect(cancelled.cancelled).toBe(true)
      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([{ state: 'queued' }])

      const restarted = await runWithPorts(
        runWatchDaemonCycle(daemonOptions({ store: storeFixture.store, statePath, clock })),
        { gateway: gateway.gateway, body, workspace },
      )
      expect(restarted.status.state).toBe('clean')
      expect(bodyPushes).toBe(1)

      const repeated = await runWithPorts(
        runWatchDaemonCycle(daemonOptions({ store: storeFixture.store, statePath, clock })),
        { gateway: gateway.gateway, body, workspace },
      )
      expect(repeated.status.state).toBe('clean')
      expect(bodyPushes).toBe(1)

      const state = await Effect.runPromise(
        readWatchDaemonState({ rootId: testIds.rootId, statePath }),
      )
      expect(state.lastCompleteCycle).toBe(3)
      expect(state.repair).toEqual({ _tag: 'none' })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('drains same-bucket query pages without skipping rows that share ordering timestamps', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const queryContract = { ...defaultQueryContract(), pageSize: 1 }
    const gateway = makeFakeGatewayHarness({
      pages: [
        pageSnapshot({ pageId: testIds.pageId }),
        pageSnapshot({
          pageId: testIds.otherPageId,
          propertiesHash: hash('properties-b'),
        }),
      ],
      propertyPages: [
        propertyPage(),
        propertyPage({ pageId: testIds.otherPageId, itemHash: hash('property-b-base') }),
      ],
    })
    const ports = makeHarnessPorts({
      bodyPages: [bodyPage(), bodyPage({ pageId: testIds.otherPageId, bodyHash: hash('body-b') })],
    })
    const statePath = `${storeFixture.path}.watch.json`

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })

      const result = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            queryContract,
          }),
        ),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )

      expect(result.sync.pull.observation.query).toMatchObject({
        pages: 2,
        rows: 2,
        complete: true,
      })
      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).rows).toEqual([
        expect.objectContaining({ pageId: testIds.pageId }),
        expect.objectContaining({ pageId: testIds.otherPageId }),
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('persists incomplete query cursor evidence for partial daemon cycles', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({
      queryResultCap: 1,
      pages: [
        pageSnapshot({ pageId: testIds.pageId }),
        pageSnapshot({
          pageId: testIds.otherPageId,
          propertiesHash: hash('properties-b'),
        }),
      ],
      propertyPages: [propertyPage()],
    })
    const ports = makeHarnessPorts()
    const statePath = `${storeFixture.path}.watch.json`

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })

      const result = await runWithPorts(
        runWatchDaemonCycle(daemonOptions({ store: storeFixture.store, statePath, clock })),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )

      expect(result.sync.pull.observation.query).toMatchObject({
        pages: 1,
        rows: 1,
        complete: false,
        cappedAtLimit: true,
      })
      expect(result.status).toMatchObject({
        state: 'blocked',
        counts: {
          checkpoints: {
            incompleteQueries: 1,
            cappedQueries: 1,
          },
        },
      })
      expect(result.state).toMatchObject({
        lastCompleteCycle: 1,
        repair: { _tag: 'none' },
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('bounds outbox execution per cycle and leaves queued work for backpressure recovery', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({
      pages: [
        pageSnapshot({ pageId: testIds.pageId }),
        pageSnapshot({
          pageId: testIds.otherPageId,
          propertiesHash: hash('properties-b'),
        }),
      ],
      propertyPages: [
        propertyPage(),
        propertyPage({ pageId: testIds.otherPageId, itemHash: hash('property-b-base') }),
      ],
    })
    const baseBody = makeFakePageBodySyncPort({
      pages: [bodyPage(), bodyPage({ pageId: testIds.otherPageId, bodyHash: hash('body-b') })],
    })
    let bodyPushes = 0
    const body = {
      ...baseBody,
      push: (command: Parameters<typeof baseBody.push>[0]) =>
        Effect.sync(() => {
          bodyPushes += 1
        }).pipe(Effect.zipRight(baseBody.push(command))),
    }
    const statePath = `${storeFixture.path}.watch.json`

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
          ...context({ store: storeFixture.store, clock }),
          store: storeFixture.store,
        }),
        { gateway: gateway.gateway, body, workspace: makeHarnessPorts().workspace },
      )

      const workspace = makeHarnessPorts({
        localObservations: [
          localBodyChange(),
          localBodyChange({
            pageId: testIds.otherPageId,
            path: decode(WorkspaceRelativePath, 'row--page-2.nmd'),
            contentHash: hash('body-local-2'),
          }),
        ],
      }).workspace
      const result = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxExecutorSteps: 1,
          }),
        ),
        { gateway: gateway.gateway, body, workspace },
      )

      expect(bodyPushes).toBe(1)
      expect(result.sync.push.executor).toMatchObject({
        steps: 1,
        maxStepsReached: true,
      })
      expect(result.status).toMatchObject({
        state: 'pending',
        counts: { outbox: { queued: 1, settled: 1 } },
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('lets a second daemon settle an expired running command as a verified no-op', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const baseBody = makeFakePageBodySyncPort({ pages: [bodyPage()] })
    const statePath = `${storeFixture.path}.watch.json`

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
          ...context({ store: storeFixture.store, clock }),
          store: storeFixture.store,
        }),
        { gateway: gateway.gateway, body: baseBody, workspace: makeHarnessPorts().workspace },
      )
      await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            maxExecutorSteps: 0,
          }),
        ),
        {
          gateway: gateway.gateway,
          body: baseBody,
          workspace: makeHarnessPorts({ localObservations: [localBodyChange()] }).workspace,
        },
      )

      const oldClaim = storeFixture.store.claimNextOutboxCommand({
        rootId: testIds.rootId,
        leaseToken: 'daemon-a',
        leaseDurationMs: 60_000,
      })
      expect(oldClaim).toMatchObject({ leaseToken: 'daemon-a', attemptState: 'running' })
      clock.advanceMillis(60_001)

      const alreadyWrittenBody = makeFakePageBodySyncPort({
        pages: [bodyPage({ bodyHash: hash('body-local') })],
      })
      const result = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            leaseToken: 'daemon-b',
            leaseDurationMs: -1,
            maxExecutorSteps: 1,
          }),
        ),
        {
          gateway: gateway.gateway,
          body: alreadyWrittenBody,
          workspace: makeHarnessPorts({ localObservations: [localBodyChange()] }).workspace,
        },
      )

      expect(result.sync.push.executor.results).toEqual([
        expect.objectContaining({
          _tag: 'settled',
          settlementKind: 'verified-no-op',
        }),
      ])
      expect(storeFixture.store.readOutbox(testIds.rootId)).toEqual([
        expect.objectContaining({
          state: 'settled',
          leaseToken: undefined,
          settlementEventId: expect.any(String),
        }),
      ])
      expect(
        storeFixture.store.isOutboxLeaseActive({
          rootId: testIds.rootId,
          commandId: oldClaim!.commandId,
          leaseToken: oldClaim!.leaseToken,
        }),
      ).toBe(false)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('persists partial-cycle state when cancellation happens during an outbox attempt', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const baseBody = makeFakePageBodySyncPort({ pages: [bodyPage()] })
    const statePath = `${storeFixture.path}.watch.json`
    const controller = new AbortController()

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
          ...context({ store: storeFixture.store, clock }),
          store: storeFixture.store,
        }),
        { gateway: gateway.gateway, body: baseBody, workspace: makeHarnessPorts().workspace },
      )
      const body = {
        ...baseBody,
        push: (command: Parameters<typeof baseBody.push>[0]) =>
          Effect.sync(() => {
            controller.abort()
          }).pipe(Effect.zipRight(baseBody.push(command))),
      }

      const result = await runWithPorts(
        runWatchDaemon(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            signal: controller.signal,
          }),
        ),
        {
          gateway: gateway.gateway,
          body,
          workspace: makeHarnessPorts({ localObservations: [localBodyChange()] }).workspace,
        },
      )
      const persisted = await Effect.runPromise(
        readWatchDaemonState({ rootId: testIds.rootId, statePath }),
      )

      expect(result).toMatchObject({
        cycles: 1,
        completed: 0,
        cancelled: true,
      })
      expect(persisted).toMatchObject({
        cycle: 1,
        lastCompleteCycle: 0,
        lastStartedAt: fixedObservedAt,
      })
      expect(persisted.lastCompletedAt).toBeUndefined()
      expect(storeFixture.store.readOutbox(testIds.rootId)).toEqual([
        expect.objectContaining({ state: 'settled' }),
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('suppresses own materialization writes through the daemon on a real temp filesystem', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const fixture = await makeTempWorkspace()
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const baseBody = makeFakePageBodySyncPort({ pages: [bodyPage()] })
    const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })
    const statePath = `${storeFixture.path}.watch.json`
    let bodyPushes = 0
    const countingBody = {
      ...baseBody,
      push: (command: Parameters<typeof baseBody.push>[0]) =>
        Effect.sync(() => {
          bodyPushes += 1
        }).pipe(Effect.zipRight(baseBody.push(command))),
    }

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot: fixture.root,
        now: clock.now,
      })
      const first = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            workspaceRoot: fixture.root,
          }),
        ),
        { gateway: gateway.gateway, body: baseBody, workspace },
      )
      const [ownWriteObservation] = await collectWorkspaceScan(workspace, fixture.root)
      const materializeResult = first.sync.pull.observation.materialized[0]
      expect(materializeResult).toBeDefined()
      expect(ownWriteObservation).toMatchObject({
        pageId: testIds.pageId,
        contentHash: hash('body-a'),
        state: 'present',
        ownWriteSuppressionToken: materializeResult!.ownWriteSuppressionToken,
      })
      expect(
        isOwnWriteObservation({
          observation: ownWriteObservation!,
          token: materializeResult!.ownWriteSuppressionToken,
        }),
      ).toBe(true)

      const second = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            workspaceRoot: fixture.root,
          }),
        ),
        { gateway: gateway.gateway, body: countingBody, workspace },
      )

      expect(second.status.state).toBe('clean')
      expect(bodyPushes).toBe(0)
    } finally {
      storeFixture.cleanup()
      await fixture.cleanup()
    }
  })

  it('doctor reports clean after a fake daemon scenario and blocked when guards are present', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const ports = makeHarnessPorts()

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
          ...context({ store: storeFixture.store, clock }),
          store: storeFixture.store,
        }),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )
      const clean = await runWithPorts(
        runCliCommand({ _tag: 'doctor' }, context({ store: storeFixture.store, clock })),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )
      expect(clean.result).toMatchObject({
        _tag: 'DoctorResult',
        clean: true,
        status: { state: 'clean' },
      })

      const blocked = await runWithPorts(
        runCliCommand(
          {
            _tag: 'conflicts-resolve',
            conflictId: decode(SyncEventId, 'missing-conflict'),
            choice: { _tag: 'keep-local', value: { _tag: 'title', plainText: 'Local' } },
          },
          context({ store: storeFixture.store, clock }),
        ),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )
      expect(blocked.status.state).toBe('blocked')

      const doctor = await runWithPorts(
        runCliCommand({ _tag: 'doctor' }, context({ store: storeFixture.store, clock })),
        { gateway: gateway.gateway, body: ports.body, workspace: ports.workspace },
      )
      expect(doctor.result).toMatchObject({
        _tag: 'DoctorResult',
        clean: false,
        status: { state: 'blocked' },
        surface: { guards: [{ guard: expect.any(String) }] },
      })
    } finally {
      storeFixture.cleanup()
    }
  })
})
