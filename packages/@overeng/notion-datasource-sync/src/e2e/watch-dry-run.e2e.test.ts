/**
 * SM5.3 (CLI-R02 watch dimension / R49 + R64): `sync --watch --dry-run` runs as
 * an observe/plan/report loop with ZERO durable effects.
 *
 * Where SM5.2 proved the one-shot `sync --dry-run` guarantee, SM5.3 proves the
 * WATCH-LOOP dimension: every per-cycle durable effect is gated, AND a real
 * concurrent daemon's leased signal is never claimed/settled/released (observer
 * non-interference — a dry-run observer must not fence a running daemon).
 *
 * Three proofs, reusing the SM5.2 `captureWorkspaceSurfaces` harness + the
 * fake-gateway write-call counter:
 *
 *  - PLAN FRAME: drive `runWatchDaemonCycle` directly. The cycle REPORTS the
 *    planned local-outbound work — `fastPush.plan.decisions` carries the
 *    `EnqueueCommands` for the staged edit — while EXECUTING nothing
 *    (`writeCalls === 0`, every surface frozen). Planned-but-not-done is the
 *    whole point: under dry-run `enqueuedCommands` is 0 (the durable append is
 *    suppressed) yet the decision is present in the frame.
 *
 *  - OBSERVER NON-INTERFERENCE: a pending Signal-1 (the load-bearing, falsifiable
 *    oracle — a non-dry cycle claims+settles it) stays `pending`/`attemptCount:0`
 *    under dry-run; a second signal CLAIMED by a distinct `real-daemon-lease`
 *    (defense-in-depth; also store-guarded by the lease cutoff + lease-token
 *    match) is left byte-identical.
 *
 *  - RUN-LEVEL: drive the real CLI `sync --watch --dry-run --max-cycles 2` through
 *    `runCliCommandWithRuntime` (exercising the removed rejection) and assert the
 *    daemon `statePath` file is never written.
 *
 * The file-backed split workspace + the rootId/storePath/dataSource triple match
 * the established workspace exactly (else the cycle silently observes nothing).
 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { makeUnsupportedPageBodySyncPort } from '../body/adapter.ts'
import { parseCliCommand, parseCliContext, runCliCommandWithRuntime } from '../cli/main.ts'
import { AbsolutePath, type AbsolutePath as AbsolutePathType } from '../core/domain.ts'
import {
  LocalWorkspacePort,
  NotionDataSourceGateway,
  PageBodySyncPort,
  type NotionDataSourceGatewayShape,
} from '../core/ports.ts'
import { SignalExternalId, SignalId, SignalProvider } from '../core/signals.ts'
import {
  runWatchDaemonCycle,
  type WatchDaemonCycleResult,
  type WatchDaemonOptions,
} from '../daemon/watch.ts'
import { dataFilePath, stateSqlitePath } from '../local/manifest.ts'
import { makeFilesystemLocalWorkspacePort } from '../local/workspace.ts'
import { openNotionSyncStore, type NotionSyncStore } from '../store/store.ts'
import {
  captureWorkspaceSurfaces,
  dryRunPropertyPage,
  dryRunSyncDataSource,
  dryRunWorkspaceRootId,
  editSelectInSqlite,
  establishSharedWorkspace,
  writePageNmd,
} from '../testing/dry-run-workspace.ts'
import {
  decode,
  defaultQueryContract,
  makeFakeGatewayHarness,
  testIds,
} from '../testing/harness.ts'
import { scenarioImplementationGaps, type ScenarioId } from '../testing/scenarios.ts'

const implementedWatchDryRunScenarioIds = new Set<ScenarioId>(['NDS-L5-watch-dry-run-loop'])

const scratchDirs: string[] = []

const tempWorkspace = async (): Promise<AbsolutePathType> => {
  const dir = await mkdtemp(join(tmpdir(), 'nds-sm53-watch-dryrun-'))
  scratchDirs.push(dir)
  return decode({ schema: AbsolutePath, value: dir })
}

const signalProvider = decode({ schema: SignalProvider, value: 'real-daemon-provider' })
const pendingSignalId = decode({ schema: SignalId, value: 'signal-pending' })
const pendingSignalExternalId = decode({ schema: SignalExternalId, value: 'external-pending' })
const claimedSignalId = decode({ schema: SignalId, value: 'signal-claimed' })
const claimedSignalExternalId = decode({ schema: SignalExternalId, value: 'external-claimed' })
const realDaemonLease = 'real-daemon-lease'

/**
 * Set up the shared-state fixture for both the dry-run and non-dry proofs:
 * establish the workspace, stage a pending property edit + `.nmd` edit, then
 * plant two signals — one CLAIMED by a distinct real-daemon lease, one PENDING.
 */
const setupWorkspace = async (
  workspace: AbsolutePathType,
): Promise<{ readonly sqlitePath: string }> => {
  await establishSharedWorkspace(workspace)
  const sqlitePath = dataFilePath({ workspaceRoot: workspace, name: testIds.databaseId })
  editSelectInSqlite({ sqlitePath, value: 'High' })
  await writePageNmd({
    workspace,
    selectValue: 'High',
    body: '# Body\n\nPending local body edit.\n',
  })

  const store = openNotionSyncStore({ path: stateSqlitePath(workspace) })
  try {
    // Signal-2: enqueue THEN claim with the real daemon's lease so it is in
    // `claimed`/`attemptCount:1`/`lease_token=real-daemon-lease` before any dry
    // run — this is the concurrent real daemon's in-flight work.
    store.enqueueSignal({
      rootId: dryRunWorkspaceRootId,
      signalId: claimedSignalId,
      provider: signalProvider,
      externalId: claimedSignalExternalId,
      dataSourceId: testIds.dataSourceId,
      pageId: testIds.pageId,
    })
    store.claimNextSignal({
      rootId: dryRunWorkspaceRootId,
      leaseToken: realDaemonLease,
      leaseDurationMs: 60_000,
    })
    // Signal-1: pending — the falsifiable oracle (a non-dry cycle claims it).
    store.enqueueSignal({
      rootId: dryRunWorkspaceRootId,
      signalId: pendingSignalId,
      provider: signalProvider,
      externalId: pendingSignalExternalId,
      dataSourceId: testIds.dataSourceId,
      pageId: testIds.pageId,
    })
  } finally {
    store.close()
  }
  return { sqlitePath }
}

const watchCycleOptions = ({
  store,
  workspace,
  sqlitePath,
  dryRun,
}: {
  readonly store: NotionSyncStore
  readonly workspace: AbsolutePathType
  readonly sqlitePath: string
  readonly dryRun: boolean
}): WatchDaemonOptions => ({
  store,
  storePath: stateSqlitePath(workspace),
  replicaPath: sqlitePath,
  rootId: dryRunWorkspaceRootId,
  dataSourceId: testIds.dataSourceId,
  workspaceRoot: workspace,
  queryContract: defaultQueryContract(),
  statePath: join(workspace, '.notion', 'v1', 'watch.json'),
  materializeBodies: false,
  authorityMode: 'shared',
  maxExecutorSteps: 8,
  // The daemon's own lease, distinct from the planted real-daemon lease so the
  // non-dry sibling claims/settles Signal-1 (not Signal-2).
  leaseToken: 'watch-observer-lease',
  dryRun,
})

const runCycle = (
  options: WatchDaemonOptions,
  workspace: AbsolutePathType,
  gateway: NotionDataSourceGatewayShape,
) =>
  runWatchDaemonCycle(options).pipe(
    Effect.provideService(NotionDataSourceGateway, gateway),
    Effect.provideService(PageBodySyncPort, makeUnsupportedPageBodySyncPort()),
    Effect.provideService(
      LocalWorkspacePort,
      makeFilesystemLocalWorkspacePort({ root: workspace }),
    ),
  )

describe('SM5.3 sync --watch --dry-run observe/plan/report loop', () => {
  afterEach(async () => {
    await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('keeps watch dry-run scenario metadata implemented', () => {
    expect(
      scenarioImplementationGaps({
        file: 'src/e2e/watch-dry-run.e2e.test.ts',
        implementedScenarioIds: implementedWatchDryRunScenarioIds,
      }),
    ).toEqual([])
  })

  // NDS-L5-watch-dry-run-loop
  it('reports a per-cycle plan frame while freezing every surface and never fencing the real daemon signal', async () => {
    const workspace = await tempWorkspace()
    const { sqlitePath } = await setupWorkspace(workspace)

    const before = captureWorkspaceSurfaces(workspace)

    // Run two bounded dry-run cycles directly (so each frame is observable).
    const frames: WatchDaemonCycleResult[] = []
    let totalWriteCalls = 0
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const gateway = makeFakeGatewayHarness({
        dataSource: dryRunSyncDataSource(),
        propertyPages: [dryRunPropertyPage('init')],
      })
      const store = openNotionSyncStore({ path: stateSqlitePath(workspace) })
      try {
        const frame = await Effect.runPromise(
          runCycle(
            watchCycleOptions({ store, workspace, sqlitePath, dryRun: true }),
            workspace,
            gateway.gateway,
          ),
        )
        frames.push(frame)
      } finally {
        store.close()
      }
      totalWriteCalls += gateway.writeCalls()
    }

    const after = captureWorkspaceSurfaces(workspace)

    // (a) A plan frame is reported PER cycle, and each frame carries the planned
    // local-outbound work: the staged cell edit is planned as an EnqueueCommands
    // decision, even though the durable append is suppressed (enqueuedCommands 0).
    expect(frames).toHaveLength(2)
    for (const frame of frames) {
      expect(frame._tag).toBe('WatchDaemonCycleResult')
      const decisions = frame.fastPush?.plan.decisions ?? []
      expect(decisions.map((decision) => decision._tag)).toContain('EnqueueCommands')
      // Planned, not done: the durable enqueue append is suppressed under dry-run.
      expect(frame.fastPush?.plan.enqueuedCommands).toBe(0)
      // The frame reports the pending signal it WOULD process (read-only).
      expect(frame.signal?.signalId).toBe(pendingSignalId)
    }

    // (b) Surface 7 (Notion): the gateway is NEVER asked to mutate across cycles.
    expect(totalWriteCalls).toBe(0)
    // Surfaces 1-4: event log, data file rows + CDC, outbox, settlement frozen.
    expect(after.eventLog).toEqual(before.eventLog)
    expect(after.dataRows).toEqual(before.dataRows)
    expect(after.dataChanges).toEqual(before.dataChanges)
    expect(after.dataChanges).toEqual([{ kind: 'cell_patch', status: 'pending' }])
    expect(after.outbox).toEqual(before.outbox)
    expect(after.settlement).toEqual(before.settlement)
    // Surfaces 5-6: object store + page `.nmd` bodies unchanged (suppressed by the
    // unconditional materializeBodies:false force, as in SM5.2).
    expect(after.objects).toEqual(before.objects)
    expect(after.pages).toEqual(before.pages)

    // (c) Observer non-interference. Signal-1 (pending) is untouched — the
    // load-bearing oracle, falsified by the non-dry sibling below. Signal-2
    // (claimed by the real daemon) is byte-identical: a dry-run observer never
    // settles/releases a running daemon's in-flight work.
    expect(after.signals).toEqual(before.signals)
    const pendingAfter = after.signals.find((signal) => signal.signalId === pendingSignalId)
    expect(pendingAfter).toMatchObject({ state: 'pending', attemptCount: 0, leaseToken: undefined })
    const claimedAfter = after.signals.find((signal) => signal.signalId === claimedSignalId)
    expect(claimedAfter).toMatchObject({
      state: 'claimed',
      attemptCount: 1,
      leaseToken: realDaemonLease,
    })
  })

  // Falsifiability anchor (mirrors SM5.2): the SAME fixture under a non-dry watch
  // cycle moves the surfaces AND claims+settles the pending Signal-1, while the
  // real daemon's Signal-2 stays untouched (concurrent work undisturbed).
  it('does NOT freeze the surfaces or the pending signal under a non-dry watch cycle', async () => {
    const workspace = await tempWorkspace()
    const { sqlitePath } = await setupWorkspace(workspace)

    const before = captureWorkspaceSurfaces(workspace)

    const gateway = makeFakeGatewayHarness({
      dataSource: dryRunSyncDataSource(),
      propertyPages: [dryRunPropertyPage('init')],
    })
    const store = openNotionSyncStore({ path: stateSqlitePath(workspace) })
    try {
      await Effect.runPromise(
        runCycle(
          watchCycleOptions({ store, workspace, sqlitePath, dryRun: false }),
          workspace,
          gateway.gateway,
        ),
      )
    } finally {
      store.close()
    }

    const after = captureWorkspaceSurfaces(workspace)

    // The gateway WAS asked to mutate, the event log + outbox grew, the CDC status
    // advanced off `pending` — so the dry-run "frozen" assertions are non-vacuous.
    expect(gateway.writeCalls()).toBeGreaterThan(0)
    expect(after.eventLog.count).toBeGreaterThan(before.eventLog.count)
    expect(after.outbox.length).toBeGreaterThan(before.outbox.length)
    expect(after.dataChanges).not.toEqual(before.dataChanges)

    // The pending Signal-1 was claimed + settled (falsifying the non-interference
    // assertion above), while the real daemon's Signal-2 lease is undisturbed.
    const pendingAfter = after.signals.find((signal) => signal.signalId === pendingSignalId)
    expect(pendingAfter?.state).toBe('processed')
    expect(pendingAfter?.attemptCount).toBe(1)
    const claimedAfter = after.signals.find((signal) => signal.signalId === claimedSignalId)
    expect(claimedAfter).toMatchObject({
      state: 'claimed',
      attemptCount: 1,
      leaseToken: realDaemonLease,
    })

    // The daemon state file WAS written by the non-dry cycle.
    expect(existsSync(join(workspace, '.notion', 'v1', 'watch.json'))).toBe(true)
  })

  // Run-level wiring through the real CLI (exercises the removed `--dry-run`
  // rejection): a bounded `sync --watch --dry-run --max-cycles 2` writes no
  // daemon state file and no surface.
  it('runs the CLI sync --watch --dry-run loop without writing the daemon state file', async () => {
    const workspace = await tempWorkspace()
    await setupWorkspace(workspace)
    const statePath = join(workspace, '.notion', 'v1', 'watch.json')

    const before = captureWorkspaceSurfaces(workspace)

    const gateway = makeFakeGatewayHarness({
      dataSource: dryRunSyncDataSource(),
      propertyPages: [dryRunPropertyPage('init')],
    })
    const argv = [
      'sync',
      '--watch',
      workspace,
      '--max-cycles',
      '2',
      '--no-materialize-bodies',
      '--dry-run',
    ] as readonly string[]
    const command = parseCliCommand(argv)
    const context = parseCliContext({ argv, resolvedCommand: command })
    try {
      await Effect.runPromise(
        runCliCommandWithRuntime({ command, context, options: { gateway: gateway.gateway } }),
      )
    } finally {
      context.store.close()
    }

    const after = captureWorkspaceSurfaces(workspace)

    // No daemon state file written (CLI-R02: dry-run leaves the daemon statePath
    // absent).
    expect(existsSync(statePath)).toBe(false)
    // No Notion mutation, no surface change across the bounded run.
    expect(gateway.writeCalls()).toBe(0)
    expect(after.eventLog).toEqual(before.eventLog)
    expect(after.dataChanges).toEqual(before.dataChanges)
    expect(after.outbox).toEqual(before.outbox)
    expect(after.signals).toEqual(before.signals)
  })
})
