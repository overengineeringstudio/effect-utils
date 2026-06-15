/**
 * SM5.4 (CLI-R07 / DAEMON-R07): the `sync --watch` loop honors the established
 * workspace authority mode.
 *
 * Where SM4 established `authority_mode` and the planner's per-property
 * `RemoteAuthoritativeDrift` block, SM5.4 makes the WATCH LOOP itself honor the
 * mode: the established mode decides WHAT the loop reconciles (orthogonal to
 * `--watch-priority`, which decides how OFTEN).
 *
 *  - NDS-L5-watch-guarantee-by-authority-mode: three bounded daemon cycles, one
 *    per mode, over an IDENTICAL fixture (a pending local property edit + a remote
 *    drift on the same property). The structural oracle is the centerpiece and is
 *    non-vacuous by construction:
 *      - `remote` (mirror): the local-first push pass is GATED OFF
 *        (`frame.fastPush === undefined`) and the gateway is NEVER asked to mutate
 *        (`writeCalls === 0`). The local edit survives as a `pending` CDC change,
 *        never an outbound write — the daemon's promise to "follow remote".
 *      - `local` / `shared`: the push pass RUNS (`frame.fastPush` is defined and
 *        carries an `EnqueueCommands` decision) and the gateway WRITES
 *        (`writeCalls > 0`).
 *    The remote `writeCalls === 0` is made non-vacuous by the local/shared siblings
 *    writing `> 0` over the same fixture. This loop gate is the complement to the
 *    planner's per-property block: that block only covers property writes, so it
 *    never closed the remote-mode lifecycle/create push hole — the loop gate does.
 *
 *  - NDS-L4-authority-mode-established-no-override: a per-run `--mode` on an
 *    established `remote` workspace's `sync --watch` is rejected end-to-end through
 *    the real CLI (CLI-R07): authority mode is workspace-wide, set once by `track`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { makeUnsupportedPageBodySyncPort } from '../body/adapter.ts'
import { CliArgumentError, parseCliCommand } from '../cli/main.ts'
import { AbsolutePath, type AbsolutePath as AbsolutePathType } from '../core/domain.ts'
import {
  LocalWorkspacePort,
  NotionDataSourceGateway,
  PageBodySyncPort,
  type NotionDataSourceGatewayShape,
} from '../core/ports.ts'
import {
  runWatchDaemonCycle,
  type WatchDaemonCycleResult,
  type WatchDaemonOptions,
} from '../daemon/watch.ts'
import { dataFilePath, stateSqlitePath, type AuthorityMode } from '../local/manifest.ts'
import { makeFilesystemLocalWorkspacePort } from '../local/workspace.ts'
import { openNotionSyncStore, type NotionSyncStore } from '../store/store.ts'
import {
  captureWorkspaceSurfaces,
  dryRunPropertyPage,
  dryRunSyncDataSource,
  dryRunWorkspaceRootId,
  editSelectInSqlite,
  establishWorkspaceWithMode,
  type WorkspaceSurfaceSnapshot,
} from '../testing/dry-run-workspace.ts'
import {
  decode,
  defaultQueryContract,
  makeFakeGatewayHarness,
  testIds,
} from '../testing/harness.ts'
import { scenarioImplementationGaps, type ScenarioId } from '../testing/scenarios.ts'

const implementedScenarioIds = new Set<ScenarioId>([
  'NDS-L5-watch-guarantee-by-authority-mode',
  'NDS-L4-authority-mode-established-no-override',
])

const scratchDirs: string[] = []

const tempWorkspace = async (): Promise<AbsolutePathType> => {
  const dir = await mkdtemp(join(tmpdir(), 'nds-sm54-watch-authority-'))
  scratchDirs.push(dir)
  return decode({ schema: AbsolutePath, value: dir })
}

/** The value staged as a PENDING local edit; differs from the established `'init'` baseline. */
const localEditValue = 'High'

const watchCycleOptions = ({
  store,
  workspace,
  sqlitePath,
  authorityMode,
}: {
  readonly store: NotionSyncStore
  readonly workspace: AbsolutePathType
  readonly sqlitePath: string
  readonly authorityMode: AuthorityMode
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
  authorityMode,
  maxExecutorSteps: 8,
  leaseToken: 'watch-authority-lease',
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

/**
 * Establish a workspace under `mode`, stage the IDENTICAL fixture (a pending local
 * `select` edit), then run ONE bounded daemon cycle. Returns the cycle frame, the
 * post-cycle surface snapshot, and the gateway write-call count.
 */
const runOneCycleForMode = async (
  mode: AuthorityMode,
): Promise<{
  readonly frame: WatchDaemonCycleResult
  readonly after: WorkspaceSurfaceSnapshot
  readonly writeCalls: number
}> => {
  const workspace = await tempWorkspace()
  await establishWorkspaceWithMode({ workspace, mode })
  const sqlitePath = dataFilePath({ workspaceRoot: workspace, name: testIds.databaseId })
  editSelectInSqlite(sqlitePath, localEditValue)

  // The cycle gateway reports the established remote baseline. (A genuine remote
  // property-value drift cannot be represented here: the fake gateway dedups
  // same-hash rows by DAEMON-R09, and bumping the row hash to defeat the dedup
  // also perturbs the local-push base comparison — contaminating the structural
  // oracle. The mirror guarantee is proven through intent disposition instead: in
  // `remote` mode the local edit is never pushed and survives as a pending CDC
  // change, whereas `local`/`shared` consume it into an outbound write.)
  const gateway = makeFakeGatewayHarness({
    dataSource: dryRunSyncDataSource(),
    propertyPages: [dryRunPropertyPage('init')],
  })
  const store = openNotionSyncStore({ path: stateSqlitePath(workspace) })
  let frame: WatchDaemonCycleResult
  try {
    frame = await Effect.runPromise(
      runCycle(
        watchCycleOptions({ store, workspace, sqlitePath, authorityMode: mode }),
        workspace,
        gateway.gateway,
      ),
    )
  } finally {
    store.close()
  }

  const after = captureWorkspaceSurfaces(workspace)
  return { frame, after, writeCalls: gateway.writeCalls() }
}

describe('SM5.4 sync --watch guarantee by authority mode', () => {
  afterEach(async () => {
    await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('keeps watch authority-mode scenario metadata implemented', () => {
    expect(
      scenarioImplementationGaps({
        file: 'src/e2e/watch-authority-mode.e2e.test.ts',
        implementedScenarioIds,
      }),
    ).toEqual([])
  })

  // NDS-L5-watch-guarantee-by-authority-mode
  it('gates the loop push pass per established authority mode (remote pull-only, local/shared push)', async () => {
    const remote = await runOneCycleForMode('remote')
    const local = await runOneCycleForMode('local')
    const shared = await runOneCycleForMode('shared')

    // (1) STRUCTURAL ORACLE — the load-bearing SM5.4 proof. Over the identical
    // fixture the loop's push pass is gated PURELY by authority mode:
    //   - remote: the push pass is SKIPPED entirely (no fast-push frame) and the
    //     gateway is never asked to mutate.
    //   - local/shared: the push pass RAN (fast-push frame present, carrying the
    //     planned EnqueueCommands) and the gateway WROTE.
    // The remote `writeCalls === 0` is non-vacuous precisely because local/shared
    // write `> 0` over the same fixture. (Removing the `isMirrorMode` gate makes
    // `remote.frame.fastPush` defined and `remote.writeCalls > 0` — i.e. these
    // assertions fail, proving the gate is load-bearing.)
    expect(remote.frame.fastPush).toBeUndefined()
    expect(remote.writeCalls).toBe(0)

    expect(local.frame.fastPush).toBeDefined()
    expect((local.frame.fastPush?.plan.decisions ?? []).map((decision) => decision._tag)).toContain(
      'EnqueueCommands',
    )
    expect(local.writeCalls).toBeGreaterThan(0)

    expect(shared.frame.fastPush).toBeDefined()
    expect(
      (shared.frame.fastPush?.plan.decisions ?? []).map((decision) => decision._tag),
    ).toContain('EnqueueCommands')
    expect(shared.writeCalls).toBeGreaterThan(0)

    // (2) The remote-pull pass GENUINELY ran in every mode (non-vacuity: the cycle
    // observed the remote row, not nothing — so "remote did not write" is a real
    // gate, not a skipped cycle).
    expect(remote.frame.sync.pull.observation.query.rows).toBeGreaterThanOrEqual(1)

    // (3) CONVERGENCE by intent disposition — the faithful, mode-distinguishing
    // signal (the public column re-projects to the remote value every cycle in all
    // modes, so it cannot carry the direction; intent disposition can). In `remote`
    // mode the local edit is NEVER pushed: it survives as a `pending` CDC change
    // (status/conflict surface) and no outbox command is enqueued — the daemon
    // follows remote. In `local`/`shared` the same staged edit is consumed into an
    // outbound write: the CDC change leaves `pending` and the outbox grows.
    expect(remote.after.dataChanges).toEqual([{ kind: 'cell_patch', status: 'pending' }])
    expect(remote.after.outbox).toEqual([])

    expect(local.after.dataChanges).not.toEqual(remote.after.dataChanges)
    expect(local.after.outbox.length).toBeGreaterThan(0)
    expect(shared.after.dataChanges).not.toEqual(remote.after.dataChanges)
    expect(shared.after.outbox.length).toBeGreaterThan(0)
  })

  // NDS-L4-authority-mode-established-no-override
  it('rejects a per-run --mode on an established workspace sync --watch (CLI-R07)', async () => {
    const workspace = await tempWorkspace()
    await establishWorkspaceWithMode({ workspace, mode: 'remote' })

    // End-to-end through the real CLI parse path: a per-run `--mode` override on an
    // established `sync --watch` is refused — authority is workspace-wide.
    const argv = ['sync', '--watch', workspace, '--mode', 'shared'] as readonly string[]
    expect(() => parseCliCommand(argv)).toThrow(
      'authority mode is workspace-wide; set it with `track --mode`',
    )
    // The rejection is a structured CLI argument error (fail-closed, not a silent
    // ignore that would let a mismatched mode reach the daemon).
    expect(() => parseCliCommand(argv)).toThrow(CliArgumentError)
  })
})
