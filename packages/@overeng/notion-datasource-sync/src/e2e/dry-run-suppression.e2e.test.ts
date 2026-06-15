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
 * delta here; a bodies-on / attachment-bearing falsifiable proof is SM5.3 scope.
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
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect, Option, Schema } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import type { NmdFrontmatterV2 } from '@overeng/notion-effect-client'
import { renderNmdFile } from '@overeng/notion-md'

import {
  parseCliCommand,
  parseCliContext,
  resolveCliCommandNotionRefs,
  runCliCommandWithRuntime,
} from '../cli/main.ts'
import { CreatePageCommand, PagePropertyItemPage } from '../core/commands.ts'
import {
  AbsolutePath,
  CommandId,
  PropertyName,
  PropertyId,
  type AbsolutePath as AbsolutePathType,
  type DataSourceSnapshot,
} from '../core/domain.ts'
import { SyncRootId, type SyncRootId as SyncRootIdType } from '../core/events.ts'
import type { NotionGatewayClient } from '../gateway/notion.ts'
import {
  dataFilePath,
  objectsDir,
  pagesDirRelativePath,
  stateSqlitePath,
} from '../local/manifest.ts'
import { readPendingReplicaChanges } from '../replica/replica.ts'
import { openNotionSyncStore } from '../store/store.ts'
import {
  decode,
  fixedObservedAt,
  hash,
  makeFakeGatewayHarness,
  testIds,
} from '../testing/harness.ts'
import { scenarioImplementationGaps, type ScenarioId } from '../testing/scenarios.ts'

const implementedDryRunSuppressionScenarioIds = new Set<ScenarioId>([
  'NDS-L4-dry-run-suppression-all-surfaces',
])

const databaseUrl =
  'https://www.notion.so/example/0123456789abcdef0123456789abcdef?v=feedfacefeedfacefeedfacefeedface'

const selectProp = decode({ schema: PropertyId, value: 'p-priority' })
const selectPropName = 'Priority'

const rootId: SyncRootIdType = decode({
  schema: SyncRootId,
  value: `data-source:${testIds.dataSourceId}`,
})

const scratchDirs: string[] = []

const tempWorkspace = async (): Promise<AbsolutePathType> => {
  const dir = await mkdtemp(join(tmpdir(), 'nds-sm52-dryrun-'))
  scratchDirs.push(dir)
  return decode({ schema: AbsolutePath, value: dir })
}

const propertyPage = (plainText: string) =>
  decode({
    schema: PagePropertyItemPage,
    value: {
      _tag: 'PagePropertyItemPage',
      apiVersion: '2026-03-11',
      requestId: testIds.requestId,
      pageId: testIds.pageId,
      propertyId: selectProp,
      items: [
        {
          _tag: 'PagePropertyItem',
          pageId: testIds.pageId,
          propertyId: selectProp,
          itemHash: hash(`item-${plainText}`),
          valueHash: hash(`value-${plainText}`),
          valueJson: JSON.stringify({ _tag: 'title', plainText }),
        },
      ],
      nextCursor: null,
      hasMore: false,
    },
  })

/** Notion client used only to resolve the database URL to a data source during `track`. */
const databaseResolverClient = (): NotionGatewayClient => ({
  retrieveDataSource: () => Effect.succeed({ id: testIds.dataSourceId, properties: {} }),
  queryDataSource: () => Effect.succeed({ results: [], nextCursor: Option.none(), hasMore: false }),
  retrievePage: () =>
    Effect.succeed({
      id: testIds.pageId,
      parent: { type: 'data_source_id', data_source_id: testIds.dataSourceId },
      properties: {},
      last_edited_time: fixedObservedAt,
      in_trash: false,
    }),
  retrievePageProperty: () =>
    Effect.succeed({ results: [], nextCursor: Option.none(), hasMore: false }),
  retrieveDatabase: () =>
    Effect.succeed({
      id: testIds.databaseId,
      title: [],
      description: [],
      icon: null,
      data_sources: [{ id: testIds.dataSourceId, name: 'Rows' }],
    }),
  updatePage: () =>
    Effect.succeed({
      id: testIds.pageId,
      parent: { type: 'data_source_id', data_source_id: testIds.dataSourceId },
      properties: {},
      last_edited_time: fixedObservedAt,
      in_trash: false,
    }),
  createPage: () =>
    Effect.succeed({
      id: 'created-page',
      parent: { type: 'data_source_id', data_source_id: testIds.dataSourceId },
      properties: {},
      last_edited_time: fixedObservedAt,
      in_trash: false,
    }),
  updateDataSource: () => Effect.succeed({ id: testIds.dataSourceId, properties: {} }),
  updateDatabase: () =>
    Effect.succeed({ id: testIds.databaseId, title: [], description: [], icon: null }),
})

const schemaPropertiesJson = [
  {
    propertyId: selectProp,
    name: selectPropName,
    type: 'select',
    configHash: hash('c-select'),
    writeClass: 'writable',
    ordinal: 0,
    configJson: JSON.stringify({
      id: selectProp,
      name: selectPropName,
      type: 'select',
      select: {
        options: [
          { id: 'hi', name: 'High', color: 'red' },
          { id: 'lo', name: 'Low', color: 'green' },
        ],
      },
    }),
  },
] as const

/**
 * A `DataSourceSnapshot` whose schema carries the writable `select` property, so
 * the `sync` re-observation projects it and the local edit reaches a clean
 * `PatchPageProperties` write rather than being blocked by `CurrentSurfaceMissing`.
 */
const syncDataSource = (): DataSourceSnapshot => ({
  _tag: 'DataSourceSnapshot',
  dataSourceId: testIds.dataSourceId,
  parentDatabaseId: testIds.databaseId,
  requestId: testIds.requestId,
  observedAt: decode({ schema: Schema.DateTimeUtc, value: fixedObservedAt }),
  schemaHash: hash('schema'),
  schemaProperties: [
    {
      _tag: 'DataSourcePropertySnapshot',
      propertyId: selectProp,
      name: decode({ schema: PropertyName, value: selectPropName }),
      type: 'select',
      configHash: hash('c-select'),
      writeClass: 'writable',
      ordinal: 0,
      configJson: JSON.stringify({ type: 'select' }),
    },
  ],
  metadataHash: hash('metadata'),
  metadataJson: JSON.stringify({
    _tag: 'CanonicalDataSourceMetadata',
    titlePlainText: 'DS',
    descriptionPlainText: '',
    icon: { _tag: 'none' },
  }),
  metadataTitlePlainText: 'DS',
  metadataDescriptionPlainText: '',
})

/** Establish a `shared`-authority tracked workspace with a real file-backed split store. */
const establishShared = async (workspace: AbsolutePathType): Promise<void> => {
  const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('init')] })
  const gatewayClient = databaseResolverClient()
  const argv = [
    'track',
    databaseUrl,
    workspace,
    '--mode',
    'shared',
    '--schema-properties-json',
    JSON.stringify(schemaPropertiesJson),
    '--no-materialize-bodies',
  ] as readonly string[]
  const command = await Effect.runPromise(
    resolveCliCommandNotionRefs({ command: parseCliCommand(argv), options: { gatewayClient } }),
  )
  const context = parseCliContext({ argv, resolvedCommand: command })
  try {
    await Effect.runPromise(
      runCliCommandWithRuntime({
        command,
        context,
        options: { gateway: gateway.gateway, gatewayClient },
      }),
    )
  } finally {
    context.store.close()
  }
}

/** Stage a PENDING local property edit in the public SQLite data file. */
const editSelectInSqlite = (sqlitePath: string, value: string): void => {
  const db = new DatabaseSync(sqlitePath)
  try {
    db.prepare(`UPDATE pages SET "${selectPropName}" = ? WHERE _page_id = ?`).run(
      value,
      testIds.pageId,
    )
  } finally {
    db.close()
  }
}

/** Write a `.nmd` page file carrying frontmatter properties + a body edit. */
const writeNmd = async ({
  workspace,
  selectValue,
  body,
}: {
  readonly workspace: AbsolutePathType
  readonly selectValue: string
  readonly body: string
}): Promise<void> => {
  const pagesDir = join(workspace, pagesDirRelativePath(testIds.databaseId))
  await mkdir(pagesDir, { recursive: true })
  const frontmatter = {
    notion_md: {
      version: 2 as const,
      api_version: '2026-03-11' as const,
      object: 'page' as const,
      source: 'shared' as const,
      page_id: testIds.pageId,
      parent: { _tag: 'data_source' as const, id: testIds.dataSourceId },
      page: { title: 'Page', icon: null, cover: null, in_trash: false, is_locked: false },
      properties: { [selectPropName]: { _tag: 'select' as const, value: selectValue } },
    },
  } as unknown as NmdFrontmatterV2
  await writeFile(
    join(pagesDir, `${testIds.pageId}.nmd`),
    renderNmdFile({ frontmatter, body }),
    'utf8',
  )
}

/** Stable per-entry name+sha256 listing of a directory tree, or `undefined` when absent. */
const dirDigest = (dir: string): ReadonlyArray<readonly [string, string]> | undefined => {
  if (existsSync(dir) === false) return undefined
  const walk = (base: string, prefix: string): Array<readonly [string, string]> =>
    readdirSync(base)
      .toSorted()
      .flatMap((entry) => {
        const abs = join(base, entry)
        const rel = prefix === '' ? entry : `${prefix}/${entry}`
        return statSync(abs).isDirectory() === true
          ? walk(abs, rel)
          : [[rel, createHash('sha256').update(readFileSync(abs)).digest('hex')] as const]
      })
  return walk(dir, '')
}

/**
 * Logical snapshot of every durable workspace surface (CLI-R02).
 *
 * The invariants are LOGICAL, not byte-level, by design: opening a SQLite
 * connection (even a read) can rewrite header/free-list pages, so a raw byte
 * hash of `.notion/v1/state.sqlite` or `data/v1/<src>.sqlite` is a false signal
 * (it diffs without any logical change). Instead each SQLite surface is read
 * through its own query: event count, outbox rows, data-file row values, AND the
 * pending-replica-change status (which proves the data file was not settled /
 * planned / written back). The object store and `.nmd` files are plain
 * content-addressed files that do NOT churn, so those keep byte hashes.
 *
 * Reusable across one-shot (SM5.2) and watch (SM5.3) dry-run proofs.
 */
const captureWorkspaceSurfaces = (workspace: AbsolutePathType) => {
  const statePath = stateSqlitePath(workspace)
  const dataPath = dataFilePath({ workspaceRoot: workspace, name: testIds.databaseId })
  const pagesDir = join(workspace, pagesDirRelativePath(testIds.databaseId))

  // Surface 1 (event log) + surfaces 3/4 (outbox + settlement): logical reads
  // from the hidden control-plane store.
  const store = openNotionSyncStore({ path: statePath })
  let eventLog: { readonly count: number }
  let outbox: ReadonlyArray<{ readonly commandId: string; readonly state: string }>
  try {
    eventLog = { count: store.replay(rootId).length }
    outbox = store.readOutbox(rootId).map((row) => ({ commandId: row.commandId, state: row.state }))
  } finally {
    store.close()
  }

  // Surface 2 (public data file): logical row values for the tracked page.
  const dataRows = (() => {
    if (existsSync(dataPath) === false) return undefined
    const db = new DatabaseSync(dataPath, { readOnly: true })
    try {
      return db
        .prepare(`SELECT _page_id, "${selectPropName}" AS v FROM pages ORDER BY _page_id`)
        .all()
    } finally {
      db.close()
    }
  })()

  // Surface 2 (continued): the staged local edit's CDC status. Any settle /
  // plan / write-back under dry-run would advance this away from `pending`.
  const dataChanges =
    existsSync(dataPath) === true
      ? readPendingReplicaChanges(dataPath).map((change) => ({
          kind: change.kind,
          status: change.status,
        }))
      : undefined

  return {
    /** Surface 1: hidden control-plane event log. */
    eventLog,
    /** Surface 3: outbox rows. */
    outbox,
    /** Surface 4: settlement = outbox `state` (settlement events live in the event log). */
    settlement: outbox.map((row) => row.state),
    /** Surface 2 (public data file): logical row values. */
    dataRows,
    /** Surface 2 (public data file): staged-edit CDC status. */
    dataChanges,
    /** Surface 5: content-addressed object store listing+hashes. */
    objects: dirDigest(objectsDir(workspace)),
    /** Surface 6: page body `.nmd` files. */
    pages: dirDigest(pagesDir),
  }
}

const runDryRunSync = async (
  workspace: AbsolutePathType,
): Promise<{ readonly writeCalls: number; readonly storePath: string | undefined }> => {
  const gateway = makeFakeGatewayHarness({
    dataSource: syncDataSource(),
    propertyPages: [propertyPage('init')],
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
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('init')] })
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
    await establishShared(workspace)
    const sqlitePath = dataFilePath({ workspaceRoot: workspace, name: testIds.databaseId })

    // Stage PENDING work on every reachable surface: a public-SQLite property
    // intent AND a `.nmd` body/frontmatter edit. `High` in the data file
    // diverges from the unchanged remote base (`init`) → a clean outbound edit
    // that a non-dry-run sync would settle through the gateway.
    editSelectInSqlite(sqlitePath, 'High')
    await writeNmd({ workspace, selectValue: 'High', body: '# Body\n\nPending local body edit.\n' })

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
    // SM5.3 scope (watch dry-run reuses `captureWorkspaceSurfaces`). Asserting
    // invariance still guards against an accidental write through this path.
    expect(after.objects).toEqual(before.objects)
    expect(after.pages).toEqual(before.pages)
  })

  // Falsifiability anchor: the SAME staged fixture, run WITHOUT --dry-run,
  // mutates the event log + outbox + gateway. This proves the dry-run assertions
  // above are non-vacuous (suppression, not "nothing would have written").
  it('does NOT freeze those surfaces under a non-dry-run sync (proof is non-vacuous)', async () => {
    const workspace = await tempWorkspace()
    await establishShared(workspace)
    const sqlitePath = dataFilePath({ workspaceRoot: workspace, name: testIds.databaseId })

    editSelectInSqlite(sqlitePath, 'High')
    await writeNmd({ workspace, selectValue: 'High', body: '# Body\n\nPending local body edit.\n' })

    const before = captureWorkspaceSurfaces(workspace)

    const gateway = makeFakeGatewayHarness({
      dataSource: syncDataSource(),
      propertyPages: [propertyPage('init')],
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
