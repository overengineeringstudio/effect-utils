/**
 * SM5.2 (CLI-R02 / R49): the one-shot `sync --dry-run` suppression GUARANTEE.
 *
 * This is the CRITICAL proof for Phase 5: a single durable write slipping
 * through dry-run is a Critical-class bug. The guarantee is NOT an audit of the
 * ~50 write call sites — it is a PROOF TEST that opens the REAL durable surfaces
 * of an established split workspace and asserts byte/row/count invariance after
 * `sync --dry-run`, plus a fake-gateway write-call counter at exactly zero.
 *
 * Seven surfaces (CLI-R02): the hidden control-plane event log
 * (`.notion/v1/state.sqlite`), the public projection / CDC data file
 * (`data/v1/<source>.sqlite`), the outbox, settlement state, the
 * content-addressed object store (`.notion/v1/objects`), the page body files
 * (`pages/v1/<source>/*.nmd`), and Notion itself (the fake gateway).
 *
 * NON-VACUITY: the SAME fixture under a non-dry-run `sync` mutates four surfaces
 * — the gateway (a clean `PatchPageProperties` settles), the event log, the
 * outbox, and the data file (its CDC status advances off `pending`). The `does
 * not freeze ...` sibling test proves all four move, so the dry-run "unchanged"
 * assertion distinguishes suppression from "nothing would have written" rather
 * than passing vacuously FOR THOSE FOUR.
 *
 * The object store (surface 5) and `.nmd` body files (surface 6) are snapshotted
 * and asserted unchanged but are NOT exercised by this fixture (it runs
 * `--no-materialize-bodies`, and the property path writes no body). Their
 * dry-run suppression rests structurally on the unconditional
 * `materializeBodies:false` force (sync.ts:569), not on a falsifiable non-dry
 * delta here. SM5.3 (`sync --watch --dry-run`) reuses this harness but ALSO runs
 * `--no-materialize-bodies`, so it does not deliver the bodies-on falsifiable
 * proof either — a bodies-on / attachment-bearing fixture remains future work.
 * See the inline note at those assertions.
 *
 * The split-workspace store is file-backed (NOT `:memory:`) on purpose: several
 * dry-run gates (`projectReplicaIfWritable`, `runLocalConvergenceForPush`)
 * short-circuit on `:memory:` BEFORE reaching the `dryRun` branch, so a
 * `:memory:` fixture would prove suppression through the wrong gate. The proof
 * asserts `context.storePath` stays file-backed under dry-run.
 *
 * The surface-snapshot harness (`captureWorkspaceSurfaces`) is intentionally
 * reusable: SM5.3 (`sync --watch --dry-run`) reuses it to assert per-cycle
 * non-interference.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { parseCliCommand, parseCliContext, runCliCommandWithRuntime } from '../cli/main.ts'
import { CreatePageCommand } from '../core/commands.ts'
import { AbsolutePath, CommandId, type AbsolutePath as AbsolutePathType } from '../core/domain.ts'
import { dataFilePath, stateSqlitePath } from '../local/manifest.ts'
import {
  captureWorkspaceSurfaces,
  dryRunPropertyPage,
  dryRunSyncDataSource,
  editSelectInSqlite,
  establishSharedWorkspace,
  writePageNmd,
} from '../testing/dry-run-workspace.ts'
import { decode, hash, makeFakeGatewayHarness, testIds } from '../testing/harness.ts'
import { scenarioImplementationGaps, type ScenarioId } from '../testing/scenarios.ts'

const implementedDryRunSuppressionScenarioIds = new Set<ScenarioId>([
  'NDS-L4-dry-run-suppression-all-surfaces',
])

const scratchDirs: string[] = []

const tempWorkspace = async (): Promise<AbsolutePathType> => {
  const dir = await mkdtemp(join(tmpdir(), 'nds-sm52-dryrun-'))
  scratchDirs.push(dir)
  return decode({ schema: AbsolutePath, value: dir })
}

const runDryRunSync = async (
  workspace: AbsolutePathType,
): Promise<{ readonly writeCalls: number; readonly storePath: string | undefined }> => {
  const gateway = makeFakeGatewayHarness({
    dataSource: dryRunSyncDataSource(),
    propertyPages: [dryRunPropertyPage('init')],
  })
  const argv = ['sync', workspace, '--no-materialize-bodies', '--dry-run'] as readonly string[]
  const command = parseCliCommand(argv)
  const context = parseCliContext({ argv, resolvedCommand: command })
  const storePath = context.storePath
  try {
    await Effect.runPromise(
      runCliCommandWithRuntime({ command, context, options: { gateway: gateway.gateway } }),
    )
  } finally {
    context.store.close()
  }
  return { writeCalls: gateway.writeCalls(), storePath }
}

describe('SM5.2 one-shot sync --dry-run suppression guarantee (all surfaces)', () => {
  afterEach(async () => {
    await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('keeps dry-run suppression scenario metadata implemented', () => {
    expect(
      scenarioImplementationGaps({
        file: 'src/e2e/dry-run-suppression.e2e.test.ts',
        implementedScenarioIds: implementedDryRunSuppressionScenarioIds,
      }),
    ).toEqual([])
  })

  // The `writeCalls` counter is the hard "zero Notion mutation" oracle. It must
  // count `createPage`, which the assertion ledger does NOT separately track —
  // so a createPage leak would otherwise be invisible. This pins that boundary.
  it('counts createPage in the gateway write-call counter (no ledger blind spot)', async () => {
    const gateway = makeFakeGatewayHarness({ propertyPages: [dryRunPropertyPage('init')] })
    expect(gateway.writeCalls()).toBe(0)
    await Effect.runPromise(
      gateway.gateway.createPage(
        decode({
          schema: CreatePageCommand,
          value: {
            _tag: 'CreatePageCommand',
            commandId: decode({ schema: CommandId, value: 'cmd-create-1' }),
            dataSourceId: testIds.dataSourceId,
            clientRequestKey: 'create-key-1',
            // The harness default data source uses `hash('schema')` as its schema hash.
            baseSchemaHash: hash('schema'),
            initialProperties: {},
          },
        }),
      ),
    )
    expect(gateway.writeCalls()).toBe(1)
  })

  // NDS-L4-dry-run-suppression-all-surfaces
  it('writes NOTHING durable to any of the seven surfaces and never asks the gateway to mutate', async () => {
    const workspace = await tempWorkspace()
    await establishSharedWorkspace(workspace)
    const sqlitePath = dataFilePath({ workspaceRoot: workspace, name: testIds.databaseId })

    // Stage PENDING work on every reachable surface: a public-SQLite property
    // intent AND a `.nmd` body/frontmatter edit. `High` in the data file
    // diverges from the unchanged remote base (`init`) → a clean outbound edit
    // that a non-dry-run sync would settle through the gateway.
    editSelectInSqlite(sqlitePath, 'High')
    await writePageNmd({
      workspace,
      selectValue: 'High',
      body: '# Body\n\nPending local body edit.\n',
    })

    const before = captureWorkspaceSurfaces(workspace)

    const { writeCalls, storePath } = await runDryRunSync(workspace)

    const after = captureWorkspaceSurfaces(workspace)

    // The dry-run must reach the REAL file-backed write boundaries (so the
    // `dryRun` gate is what suppresses them, not a `:memory:` short-circuit).
    expect(storePath).toBe(stateSqlitePath(workspace))

    // Surface 7 (Notion): the gateway is NEVER asked to mutate. Hard assertion.
    expect(writeCalls).toBe(0)

    // Surface 1: hidden control-plane event log — event count unchanged.
    expect(after.eventLog).toEqual(before.eventLog)
    // Surface 2: public data file — row values unchanged, and the staged local
    // edit is STILL `pending` (no settle / plan / write-back).
    expect(after.dataRows).toEqual(before.dataRows)
    expect(after.dataChanges).toEqual(before.dataChanges)
    expect(after.dataChanges).toEqual([{ kind: 'cell_patch', status: 'pending' }])
    // Surface 3: outbox — no rows enqueued.
    expect(after.outbox).toEqual(before.outbox)
    // Surface 4: settlement — outbox settlement state unchanged.
    expect(after.settlement).toEqual(before.settlement)
    // Surfaces 5 + 6 (object store + page `.nmd` bodies): snapshotted and
    // asserted unchanged, but NOTE this fixture runs `--no-materialize-bodies`,
    // so neither surface is exercised by the non-vacuity sibling — under non-dry
    // the property write alone moves the other four surfaces, not these two.
    // Their suppression here therefore rests on the UNCONDITIONAL
    // `materializeBodies:false` force under dry-run (sync.ts:569, which disables
    // the body-observe + materialize path that writes `.nmd` files and the
    // content-addressed object store) plus the absence of any body write in the
    // property path — NOT on a falsifiable non-dry delta in this fixture. A
    // bodies-on / attachment-bearing falsifiable proof of these two surfaces is
    // future work (SM5.3 reuses this harness but also runs
    // `--no-materialize-bodies`). Asserting invariance still guards against an
    // accidental write through this path.
    expect(after.objects).toEqual(before.objects)
    expect(after.pages).toEqual(before.pages)
  })

  // Falsifiability anchor: the SAME staged fixture, run WITHOUT --dry-run,
  // mutates the event log + outbox + gateway. This proves the dry-run assertions
  // above are non-vacuous (suppression, not "nothing would have written").
  it('does NOT freeze those surfaces under a non-dry-run sync (proof is non-vacuous)', async () => {
    const workspace = await tempWorkspace()
    await establishSharedWorkspace(workspace)
    const sqlitePath = dataFilePath({ workspaceRoot: workspace, name: testIds.databaseId })

    editSelectInSqlite(sqlitePath, 'High')
    await writePageNmd({
      workspace,
      selectValue: 'High',
      body: '# Body\n\nPending local body edit.\n',
    })

    const before = captureWorkspaceSurfaces(workspace)

    const gateway = makeFakeGatewayHarness({
      dataSource: dryRunSyncDataSource(),
      propertyPages: [dryRunPropertyPage('init')],
    })
    const argv = ['sync', workspace, '--no-materialize-bodies'] as readonly string[]
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

    // The gateway WAS asked to mutate (a clean PatchPageProperties settled).
    expect(gateway.writeCalls()).toBeGreaterThan(0)
    // The event log grew (re-observation + settlement events appended).
    expect(after.eventLog.count).toBeGreaterThan(before.eventLog.count)
    // The outbox recorded the settled command.
    expect(after.outbox.length).toBeGreaterThan(before.outbox.length)
    expect(after.settlement).toContain('settled')
    // The data-file CDC status advanced away from `pending` (settled / planned),
    // so the dry-run invariant `dataChanges === [{cell_patch, pending}]` is
    // falsifiable rather than a value that never moves.
    expect(after.dataChanges).not.toEqual(before.dataChanges)
  })
})
