import { DatabaseSync } from 'node:sqlite'

import { Effect, Fiber, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeFakePageBodySyncPort } from '../body/adapter.ts'
import { runCliCommand, type CliContext } from '../cli/main.ts'
import { PagePropertyItemPage } from '../core/commands.ts'
import {
  AbsolutePath,
  BodyPointer,
  PageId,
  WorkspaceRelativePath,
  type Hash as HashType,
  type PageId as PageIdType,
} from '../core/domain.ts'
import { BodySyncError } from '../core/errors.ts'
import { SyncEventId } from '../core/events.ts'
import { LocalWorkspacePort, NotionDataSourceGateway, PageBodySyncPort } from '../core/ports.ts'
import {
  readWatchDaemonState,
  runWatchDaemon,
  runWatchDaemonCycle,
  type WatchDaemonOptions,
} from '../daemon/watch.ts'
import { makeGatewayError } from '../gateway/gateway.ts'
import {
  isOwnWriteObservation,
  makeFilesystemLocalWorkspacePort,
  presentArtifactObservation,
} from '../local/workspace.ts'
import { initOneShotSync, pullOneShotSync } from '../sync/sync.ts'
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

type QueryCheckpointRow = {
  readonly data_source_id: string
  readonly query_contract_hash: string
  readonly next_cursor: string | null
  readonly complete: 0 | 1
  readonly capped_at_limit: 0 | 1
  readonly contract_changed: 0 | 1
  readonly high_watermark: string | null
}

const readQueryCheckpointRows = (path: string): ReadonlyArray<QueryCheckpointRow> => {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return database
      .prepare(
        `SELECT data_source_id,
                query_contract_hash,
                next_cursor,
                complete,
                capped_at_limit,
                contract_changed,
                high_watermark
         FROM query_scan_checkpoint
         WHERE root_id = ?
         ORDER BY data_source_id, query_contract_hash`,
      )
      .all(testIds.rootId)
      .map((row) => ({
        data_source_id: String(row.data_source_id),
        query_contract_hash: String(row.query_contract_hash),
        next_cursor: row.next_cursor === null ? null : String(row.next_cursor),
        complete: row.complete === 1 ? 1 : 0,
        capped_at_limit: row.capped_at_limit === 1 ? 1 : 0,
        contract_changed: row.contract_changed === 1 ? 1 : 0,
        high_watermark: row.high_watermark === null ? null : String(row.high_watermark),
      }))
  } finally {
    database.close()
  }
}

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

const makeDeferred = <TValue = void>() => {
  let resolve!: (value: TValue) => void
  const promise = new Promise<TValue>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const withFailsafe = async <TValue>(promise: Promise<TValue>, label: string): Promise<TValue> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(label)), 2_000)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}

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

  it('drains fake cursor pages without skipping same-timestamp rows', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const queryContract = { ...defaultQueryContract(), pageSize: 1 }
    const thirdPageId = decode(PageId, 'page-3')
    const gateway = makeFakeGatewayHarness({
      pages: [
        pageSnapshot({ pageId: testIds.pageId }),
        pageSnapshot({
          pageId: testIds.otherPageId,
          propertiesHash: hash('properties-b'),
        }),
        pageSnapshot({
          pageId: thirdPageId,
          propertiesHash: hash('properties-c'),
        }),
      ],
      propertyPages: [
        propertyPage(),
        propertyPage({ pageId: testIds.otherPageId, itemHash: hash('property-b-base') }),
        propertyPage({ pageId: thirdPageId, itemHash: hash('property-c-base') }),
      ],
    })
    const ports = makeHarnessPorts({
      bodyPages: [
        bodyPage(),
        bodyPage({ pageId: testIds.otherPageId, bodyHash: hash('body-b') }),
        bodyPage({ pageId: thirdPageId, bodyHash: hash('body-c') }),
      ],
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
        pages: 3,
        rows: 3,
        complete: true,
      })
      const projectedRows = storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).rows
      expect(projectedRows.map((row) => row.pageId)).toEqual([
        testIds.pageId,
        testIds.otherPageId,
        thirdPageId,
      ])
      expect(new Set(projectedRows.map((row) => row.propertiesHash)).size).toBe(3)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('persists capped incomplete query checkpoint evidence when the fake cap has no resume cursor', async () => {
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
      expect(readQueryCheckpointRows(storeFixture.path)).toEqual([
        {
          data_source_id: testIds.dataSourceId,
          query_contract_hash: result.sync.pull.observation.query.queryContractHash,
          next_cursor: null,
          complete: 0,
          capped_at_limit: 1,
          contract_changed: 0,
          high_watermark: null,
        },
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('resumes an interrupted high-watermark query from the persisted cursor', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const queryContract = {
      ...defaultQueryContract(),
      pageSize: 1,
      highWatermark: decode(Schema.DateTimeUtc, '2026-05-24T23:59:00.000Z'),
    }
    const thirdPageId = decode(PageId, 'page-3')
    const pages = [
      pageSnapshot({ pageId: testIds.pageId }),
      pageSnapshot({
        pageId: testIds.otherPageId,
        propertiesHash: hash('properties-b'),
      }),
      pageSnapshot({
        pageId: thirdPageId,
        propertiesHash: hash('properties-c'),
      }),
    ]
    const propertyPages = [
      propertyPage(),
      propertyPage({ pageId: testIds.otherPageId, itemHash: hash('property-b-base') }),
      propertyPage({ pageId: thirdPageId, itemHash: hash('property-c-base') }),
    ]
    const ports = makeHarnessPorts({
      bodyPages: [
        bodyPage(),
        bodyPage({ pageId: testIds.otherPageId, bodyHash: hash('body-b') }),
        bodyPage({ pageId: thirdPageId, bodyHash: hash('body-c') }),
      ],
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

      const first = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            queryContract,
          }),
        ),
        {
          gateway: makeFakeGatewayHarness({
            pages,
            propertyPages,
            queryPageLimit: 1,
          }).gateway,
          body: ports.body,
          workspace: ports.workspace,
        },
      )

      expect(first.sync.pull.observation.query).toMatchObject({
        startCursor: null,
        pages: 1,
        rows: 1,
        complete: false,
      })
      expect(readQueryCheckpointRows(storeFixture.path)).toEqual([
        {
          data_source_id: testIds.dataSourceId,
          query_contract_hash: first.sync.pull.observation.query.queryContractHash,
          next_cursor: 'offset:1',
          complete: 0,
          capped_at_limit: 0,
          contract_changed: 0,
          high_watermark: '2026-05-24T23:59:00.000Z',
        },
      ])

      const resumedStartCursors: Array<string | null> = []
      const resumedGatewayHarness = makeFakeGatewayHarness({ pages, propertyPages })
      const resumedGateway = {
        ...resumedGatewayHarness.gateway,
        queryRows: (input: Parameters<typeof resumedGatewayHarness.gateway.queryRows>[0]) => {
          resumedStartCursors.push(input.startCursor)
          return resumedGatewayHarness.gateway.queryRows(input)
        },
      }
      const second = await runWithPorts(
        runWatchDaemonCycle(
          daemonOptions({
            store: storeFixture.store,
            statePath,
            clock,
            queryContract,
          }),
        ),
        {
          gateway: resumedGateway,
          body: ports.body,
          workspace: ports.workspace,
        },
      )

      expect(resumedStartCursors).toEqual(['offset:1'])
      expect(second.sync.pull.observation.query).toMatchObject({
        startCursor: 'offset:1',
        pages: 2,
        rows: 2,
        complete: true,
      })
      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).rows).toMatchObject([
        { pageId: testIds.pageId },
        { pageId: testIds.otherPageId },
        { pageId: thirdPageId },
      ])
      expect(readQueryCheckpointRows(storeFixture.path)).toEqual([
        {
          data_source_id: testIds.dataSourceId,
          query_contract_hash: first.sync.pull.observation.query.queryContractHash,
          next_cursor: null,
          complete: 1,
          capped_at_limit: 0,
          contract_changed: 0,
          high_watermark: fixedObservedAt,
        },
      ])
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

  it('settles the current outbox attempt before honoring cancellation at the cycle boundary', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const baseBody = makeFakePageBodySyncPort({ pages: [bodyPage()] })
    const statePath = `${storeFixture.path}.watch.json`
    const controller = new AbortController()
    let bodyPushes = 0

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
            bodyPushes += 1
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
      expect(bodyPushes).toBe(1)
      expect(storeFixture.store.readOutbox(testIds.rootId)).toEqual([
        expect.objectContaining({ state: 'settled' }),
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('interrupts an in-flight body push when the daemon is cancelled mid-cycle', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const baseBody = makeFakePageBodySyncPort({ pages: [bodyPage()] })
    const statePath = `${storeFixture.path}.watch.json`
    const controller = new AbortController()
    const inFlight = makeDeferred()
    const interrupted = makeDeferred()

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
        push: (_command: Parameters<typeof baseBody.push>[0]) =>
          Effect.sync(() => inFlight.resolve()).pipe(
            Effect.zipRight(Effect.never),
            Effect.ensuring(Effect.sync(() => interrupted.resolve())),
          ),
      }
      const program = runWatchDaemon(
        daemonOptions({
          store: storeFixture.store,
          statePath,
          clock,
          signal: controller.signal,
        }),
      ).pipe(
        Effect.provideService(NotionDataSourceGateway, gateway.gateway),
        Effect.provideService(PageBodySyncPort, body),
        Effect.provideService(
          LocalWorkspacePort,
          makeHarnessPorts({ localObservations: [localBodyChange()] }).workspace,
        ),
      )

      const fiber = Effect.runFork(program)
      await withFailsafe(inFlight.promise, 'body push did not start')
      controller.abort()
      await withFailsafe(interrupted.promise, 'body push was not interrupted')
      const result = await withFailsafe(Effect.runPromise(Fiber.join(fiber)), 'daemon did not stop')
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
        repair: {
          _tag: 'retry',
          reason: 'WatchDaemonCancelled',
          failedCycle: 1,
        },
      })
      expect(storeFixture.store.readOutbox(testIds.rootId)).toEqual([
        expect.objectContaining({
          state: 'running',
          attemptCount: 1,
          settlementEventId: undefined,
        }),
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
