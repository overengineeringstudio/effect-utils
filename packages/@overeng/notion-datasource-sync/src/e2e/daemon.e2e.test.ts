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
import { AbsolutePath, BodyPointer, WorkspaceRelativePath } from '../domain.ts'
import { BodySyncError } from '../errors.ts'
import { SyncEventId } from '../events.ts'
import { makeGatewayError } from '../gateway.ts'
import { presentArtifactObservation } from '../local-workspace.ts'
import { LocalWorkspacePort, NotionDataSourceGateway, PageBodySyncPort } from '../ports.ts'
import { initOneShotSync, pullOneShotSync } from '../sync.ts'
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

const propertyPage = () =>
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
        itemHash: hash('property-a-base'),
        valueHash: hash('property-a-base'),
      },
    ],
    nextCursor: null,
    hasMore: false,
  })

const bodyPage = () =>
  fakeBodyPage({
    pointer: decode(BodyPointer, {
      _tag: 'BodyPointer',
      pageId: testIds.pageId,
      bodyHash: hash('body-a'),
      observedAt: fixedObservedAt,
    }),
  })

const localBodyChange = () =>
  presentArtifactObservation({
    pageId: testIds.pageId,
    path: decode(WorkspaceRelativePath, 'row--page-1.nmd'),
    contentHash: hash('body-local'),
    observedAt: decode(Schema.DateTimeUtc, fixedObservedAt),
  })

const context = (input: {
  readonly store: CliContext['store']
  readonly clock: ReturnType<typeof makeFakeClock>
}): CliContext => ({
  store: input.store,
  rootId: testIds.rootId,
  dataSourceId: testIds.dataSourceId,
  workspaceRoot,
  queryContract: defaultQueryContract(),
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
}): WatchDaemonOptions => ({
  store: input.store,
  rootId: testIds.rootId,
  dataSourceId: testIds.dataSourceId,
  workspaceRoot,
  queryContract: defaultQueryContract(),
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
