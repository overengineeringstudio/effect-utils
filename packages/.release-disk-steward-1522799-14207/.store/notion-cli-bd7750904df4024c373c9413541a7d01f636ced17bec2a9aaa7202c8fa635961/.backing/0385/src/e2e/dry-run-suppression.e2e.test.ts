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
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { parseCliCommand, parseCliContext, runCliCommandWithRuntime } from '../cli/main.ts'
import { CreatePageCommand, PagePropertyItemPage } from '../core/commands.ts'
import {
  AbsolutePath,
  CommandId,
  WorkspaceRelativePath,
  type AbsolutePath as AbsolutePathType,
  type PageId as PageIdType,
} from '../core/domain.ts'
import { LocalWorkspacePort, NotionDataSourceGateway, PageBodySyncPort } from '../core/ports.ts'
import { dataFilePath, pagesDirRelativePath, stateSqlitePath } from '../local/manifest.ts'
import { makeFilesystemLocalWorkspacePort } from '../local/workspace.ts'
import { initOneShotSync, syncOneShot } from '../sync/sync.ts'
import {
  captureWorkspaceSurfaces,
  dryRunPropertyPage,
  dryRunSyncDataSource,
  editSelectInSqlite,
  establishSharedWorkspace,
  writePageNmd,
} from '../testing/dry-run-workspace.ts'
import { makeTempWorkspace } from '../testing/filesystem.ts'
import {
  decode,
  defaultQueryContract,
  hash,
  makeFakeClock,
  makeFakeGatewayHarness,
  makeHarnessPorts,
  makeStoreFixture,
  testIds,
} from '../testing/harness.ts'
import { scenarioImplementationGaps, type ScenarioId } from '../testing/scenarios.ts'

const implementedDryRunSuppressionScenarioIds = new Set<ScenarioId>([
  'NDS-L4-dry-run-suppression-all-surfaces',
  'NDS-L4-dry-run-suppression-nmd-bodies',
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
    editSelectInSqlite({ sqlitePath, value: 'High' })
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

    editSelectInSqlite({ sqlitePath, value: 'High' })
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

/**
 * F2 (#775): bodies-ON falsifiable proof for the `.nmd` materialization surface
 * (CLI-R02 surface 6). The all-surfaces proof above runs
 * `--no-materialize-bodies`, so its `pages` invariance rests on the unconditional
 * `materializeBodies:false` force, NOT a falsifiable delta. Here the SAME pull
 * path runs with bodies ON: under `--dry-run` the body-observe + materialize
 * stage is suppressed (`sync.ts`, `dryRun → materializeBodies:false`), so the
 * `pages/v1/<src>/` dir stays empty; without `--dry-run` it materializes a
 * `.nmd`, proving the dry-run "no body write" assertion is non-vacuous.
 *
 * Driven through `syncOneShot` directly (not the CLI) because the CLI's body
 * runtime is fail-closed when a fake gateway is injected (the live NotionMD body
 * runtime is only wired for real Notion tokens), so a CLI fake-gateway run can
 * never materialize a body and the non-vacuity control would be impossible.
 * `syncOneShot` with the fake body port + a real filesystem workspace port
 * materializes a `.nmd` exactly through the production pull path being gated.
 */
describe('F2 one-shot sync --dry-run suppresses bodies-on .nmd materialization', () => {
  const schemaProperties = [
    {
      propertyId: testIds.propertyA,
      configHash: hash('config-a'),
      writeClass: 'writable' as const,
    },
  ]

  // Materialize the page body under `pages/v1/<databaseId>/<pageId>.nmd` so the
  // assertion reads the same dir the all-surfaces proof's `pages` surface does.
  const bodyPathForPage = (pageId: PageIdType): WorkspaceRelativePath =>
    decode({
      schema: WorkspaceRelativePath,
      value: `${pagesDirRelativePath(testIds.databaseId)}/${pageId}.nmd`,
    })

  const bodiesOnPropertyPage = decode({
    schema: PagePropertyItemPage,
    value: {
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
          itemHash: hash('item'),
          valueHash: hash('value'),
        },
      ],
      nextCursor: null,
      hasMore: false,
    },
  })

  const runBodiesOnSync = async ({
    root,
    dryRun,
  }: {
    readonly root: AbsolutePathType
    readonly dryRun: boolean
  }): Promise<void> => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const workspace = makeFilesystemLocalWorkspacePort({ root })
    const gateway = makeFakeGatewayHarness({ propertyPages: [bodiesOnPropertyPage] })
    const ports = makeHarnessPorts()
    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot: root,
        now: clock.now,
      })
      await Effect.runPromise(
        syncOneShot({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot: root,
          queryContract: defaultQueryContract(),
          schemaProperties,
          bodyPathForPage,
          now: clock.now,
          ...(dryRun === true ? { dryRun: true } : {}),
        }).pipe(
          Effect.provideService(NotionDataSourceGateway, gateway.gateway),
          Effect.provideService(PageBodySyncPort, ports.body),
          Effect.provideService(LocalWorkspacePort, workspace),
        ),
      )
    } finally {
      storeFixture.cleanup()
    }
  }

  const pagesDirEntries = (root: AbsolutePathType): ReadonlyArray<string> => {
    const dir = join(root, pagesDirRelativePath(testIds.databaseId))
    return existsSync(dir) === true ? readdirSync(dir).toSorted() : []
  }

  it('keeps the bodies-on dry-run scenario metadata implemented', () => {
    expect(
      scenarioImplementationGaps({
        file: 'src/e2e/dry-run-suppression.e2e.test.ts',
        implementedScenarioIds: implementedDryRunSuppressionScenarioIds,
      }),
    ).toEqual([])
  })

  // NDS-L4-dry-run-suppression-nmd-bodies
  it('writes NO .nmd page body under sync --dry-run with bodies enabled', async () => {
    const fixture = await makeTempWorkspace()
    try {
      const before = pagesDirEntries(fixture.root)
      await runBodiesOnSync({ root: fixture.root, dryRun: true })
      const after = pagesDirEntries(fixture.root)

      // The body materialize stage is gated off under dry-run, so no `.nmd` lands.
      expect(after).toEqual(before)
      expect(after).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  // Falsifiability anchor: the SAME bodies-on path WITHOUT --dry-run materializes
  // a `.nmd`, proving the dry-run assertion above is suppression, not a body that
  // would never have been written.
  it('DOES materialize a .nmd under a non-dry bodies-on sync (proof is non-vacuous)', async () => {
    const fixture = await makeTempWorkspace()
    try {
      const before = pagesDirEntries(fixture.root)
      await runBodiesOnSync({ root: fixture.root, dryRun: false })
      const after = pagesDirEntries(fixture.root)

      expect(before).toEqual([])
      expect(after).not.toEqual(before)
      expect(after).toContain(`${testIds.pageId}.nmd`)
    } finally {
      await fixture.cleanup()
    }
  })
})
