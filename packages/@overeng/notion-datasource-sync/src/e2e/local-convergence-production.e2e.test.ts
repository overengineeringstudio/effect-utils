/**
 * SM5c production-path convergence: a `shared` workspace where a scalar property
 * is edited in the SQLite `pages` data file AND in the page's `.nmd` frontmatter.
 *
 * This exercises the REAL observation channel (`buildPropertyConvergenceInputs`:
 * decode `.nmd` frontmatter → resolve name → stable `property_id` via the tracked
 * schema → baseline-diff against `_nds_replica_cells`) feeding the real
 * `convergeLocalSurfaces` engine, on a real established replica.
 *
 * - DIFFERENT value in each surface → a local conflict (raised into the
 *   `conflicts` view) + a `disagrees` property verdict (which blocks the remote
 *   write through the shared proof core as `LocalSurfaceDisagreement`).
 * - SAME value in each surface → coalesce: one converged verdict, no conflict.
 *
 * Divergence detection is structurally scalar-only (the public `pages` surface
 * only edits scalar columns), so this uses a `select` property.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect, Option } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import type { NmdFrontmatterV2 } from '@overeng/notion-effect-client'
import { renderNmdFile } from '@overeng/notion-md'

import {
  parseCliCommand,
  parseCliContext,
  raiseConvergenceConflicts,
  resolveCliCommandNotionRefs,
  runCliCommandWithRuntime,
} from '../cli/main.ts'
import { PagePropertyItemPage } from '../core/commands.ts'
import {
  AbsolutePath,
  Hash,
  PropertyId,
  type AbsolutePath as AbsolutePathType,
} from '../core/domain.ts'
import { SyncRootId as SyncRootIdSchema } from '../core/events.ts'
import type { NotionGatewayClient } from '../gateway/notion.ts'
import { pagesDirRelativePath, stateSqlitePath } from '../local/manifest.ts'
import {
  convergeLocalSurfaces,
  type DataFileLocalEdit,
  type NmdDesiredFact,
} from '../planner/local-convergence.ts'
import {
  projectReplicaFromSyncStore,
  readPendingReplicaChanges,
  readReplicaCellBases,
} from '../replica/replica.ts'
import { openNotionSyncStore } from '../store/store.ts'
import { buildPropertyConvergenceInputs } from '../sync/local-convergence-inputs.ts'
import {
  decode,
  fixedObservedAt,
  hash,
  makeFakeGatewayHarness,
  testIds,
} from '../testing/harness.ts'

const scratchDirs: string[] = []
const databaseUrl =
  'https://www.notion.so/example/0123456789abcdef0123456789abcdef?v=feedfacefeedfacefeedfacefeedface'

const selectProp = decode({ schema: PropertyId, value: 'p-priority' })
const selectPropName = 'Priority'

const sqlitePathForWorkspace = (workspace: string): string =>
  join(workspace, 'data', 'v1', `${testIds.databaseId}.sqlite`)

const tempWorkspace = async (): Promise<AbsolutePathType> => {
  const dir = await mkdtemp(join(tmpdir(), 'nds-sm5c-prod-'))
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

const schemaProperties = [
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

const establishShared = async (workspace: AbsolutePathType): Promise<string> => {
  const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('init')] })
  const gatewayClient = databaseResolverClient()
  const argv = [
    'track',
    databaseUrl,
    workspace,
    '--mode',
    'shared',
    '--schema-properties-json',
    JSON.stringify(schemaProperties),
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
  return sqlitePathForWorkspace(workspace)
}

/**
 * Run the internal `push` reconciliation phase on a tracked workspace with the
 * fake gateway. `push` is no longer a public verb (CLI-R01), so the command is
 * constructed directly and dispatched through the retained internal `push`
 * dispatch (`runLocalConvergenceForPush` → `pushOneShotSync`) rather than parsed
 * from argv. The argv is still used to extract context flags (`--sqlite`,
 * `--no-materialize-bodies`) via `resolvedCommand`, which bypasses the parser.
 */
const runPush = async (workspace: AbsolutePathType) => {
  const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('init')] })
  // `--no-materialize-bodies`: the push must not re-scan/observe the synthetic
  // `.nmd` body (it has no sidecar identity); convergence reads the frontmatter
  // directly, separate from body materialization.
  const argv = [
    'push',
    '--sqlite',
    sqlitePathForWorkspace(workspace),
    '--no-materialize-bodies',
  ] as readonly string[]
  const command = { _tag: 'push', dryRun: false } as const
  const context = parseCliContext({ argv, resolvedCommand: command })
  try {
    const result = await Effect.runPromise(
      runCliCommandWithRuntime({ command, context, options: { gateway: gateway.gateway } }),
    )
    return { gateway, result }
  } finally {
    context.store.close()
  }
}

const openConflictsCount = (sqlitePath: string): number => {
  const db = new DatabaseSync(sqlitePath, { readOnly: true })
  try {
    const row = db.prepare(`SELECT count(*) AS n FROM conflicts`).get() as { n: number }
    return row.n
  } finally {
    db.close()
  }
}

/**
 * The guard names recorded for the active blocks. For a tracked workspace the
 * guard-block events live in the hidden control-plane store (`state.sqlite`),
 * NOT the public data file (which holds only the `conflicts`/`pages`
 * projection). ADR 0011.
 */
const guardBlockNames = (workspace: AbsolutePathType): readonly string[] => {
  const db = new DatabaseSync(stateSqlitePath(workspace), { readOnly: true })
  try {
    const rows = db.prepare(`SELECT guard FROM _nds_guard_block`).all() as { guard: string }[]
    return rows.map((r) => r.guard)
  } finally {
    db.close()
  }
}

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

const writeNmdWithSelect = async ({
  workspace,
  value,
}: {
  readonly workspace: AbsolutePathType
  readonly value: string
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
      page: {
        title: 'Page',
        icon: null,
        cover: null,
        in_trash: false,
        is_locked: false,
      },
      properties: { [selectPropName]: { _tag: 'select' as const, value } },
    },
  } as unknown as NmdFrontmatterV2
  const content = renderNmdFile({ frontmatter, body: '# Body\n' })
  await writeFile(join(pagesDir, `${testIds.pageId}.nmd`), content, 'utf8')
}

describe('SM5c production local convergence (.nmd frontmatter ↔ SQLite pages)', () => {
  afterEach(async () => {
    await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('DIVERGE: different select value in SQLite vs .nmd → local conflict + disagrees verdict', async () => {
    const workspace = await tempWorkspace()
    const sqlitePath = await establishShared(workspace)

    editSelectInSqlite(sqlitePath, 'High')
    await writeNmdWithSelect({ workspace, value: 'Low' })

    const changes = readPendingReplicaChanges(sqlitePath)
    const bases = readReplicaCellBases(sqlitePath)
    const { dataFileEdits, nmdFacts } = buildPropertyConvergenceInputs({
      workspaceRoot: workspace,
      pagesDir: pagesDirRelativePath(testIds.databaseId),
      changes,
      bases,
    })

    // Both surfaces produced a property fact/edit for the same identity.
    expect(dataFileEdits.length).toBeGreaterThanOrEqual(1)
    expect(nmdFacts.length).toBe(1)

    const result = convergeLocalSurfaces({ authorityMode: 'shared', dataFileEdits, nmdFacts })
    expect(result._tag).toBe('shared')
    if (result._tag !== 'shared') return

    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]?.kind).toBe('same-property')
    expect(result.blockedIdentities).toHaveLength(1)
    expect(result.propertyVerdicts).toEqual([
      { pageId: testIds.pageId, propertyId: selectProp, status: 'disagrees' },
    ])
  })

  it('REAL PUSH: divergent SQLite vs .nmd select → conflict raised + remote write blocked', async () => {
    const workspace = await tempWorkspace()
    const sqlitePath = await establishShared(workspace)

    editSelectInSqlite(sqlitePath, 'High')
    await writeNmdWithSelect({ workspace, value: 'Low' })

    const { gateway, result } = await runPush(workspace)

    // The remote property write is blocked — no PatchPageProperties attempted.
    expect(gateway.ledger.attemptedPatchPageProperties).toHaveLength(0)
    // A local conflict is surfaced in the read-only conflicts view (decision 0005).
    expect(openConflictsCount(sqlitePath)).toBeGreaterThanOrEqual(1)
    // The block must come from the convergence verdict driving the shared proof
    // core, NOT from a side-channel intent drop — the diverged property write is
    // planned and blocked by name as `LocalSurfaceDisagreement`. (`attempted... === 0`
    // alone would pass for ANY block reason; this asserts the production chain
    // `convergenceVerdicts → applyConvergenceVerdicts → LocalSurfaceDisagreement`.)
    // The exact-array assertion also rules out an earlier planner guard
    // (`StaleSurfaceBase`, `CurrentSurfaceMissing`) firing instead.
    expect(guardBlockNames(workspace)).toEqual(['LocalSurfaceDisagreement'])
    expect(result).toMatchObject({ _tag: 'CliResultEnvelope', command: 'push' })
  })

  it('COALESCE: same select value in SQLite and .nmd → one converged verdict, no conflict', async () => {
    const workspace = await tempWorkspace()
    const sqlitePath = await establishShared(workspace)

    editSelectInSqlite(sqlitePath, 'High')
    await writeNmdWithSelect({ workspace, value: 'High' })

    const changes = readPendingReplicaChanges(sqlitePath)
    const bases = readReplicaCellBases(sqlitePath)
    const { dataFileEdits, nmdFacts } = buildPropertyConvergenceInputs({
      workspaceRoot: workspace,
      pagesDir: pagesDirRelativePath(testIds.databaseId),
      changes,
      bases,
    })

    expect(nmdFacts).toHaveLength(1)
    const result = convergeLocalSurfaces({ authorityMode: 'shared', dataFileEdits, nmdFacts })
    if (result._tag !== 'shared') throw new Error('expected shared')

    expect(result.conflicts).toHaveLength(0)
    expect(result.blockedIdentities).toHaveLength(0)
    expect(result.propertyVerdicts).toEqual([
      { pageId: testIds.pageId, propertyId: selectProp, status: 'converged' },
    ])
  })

  it('REAL PUSH COALESCE: agreeing SQLite and .nmd → no LocalSurfaceDisagreement block', async () => {
    const workspace = await tempWorkspace()
    const sqlitePath = await establishShared(workspace)

    editSelectInSqlite(sqlitePath, 'High')
    await writeNmdWithSelect({ workspace, value: 'High' })

    const { gateway } = await runPush(workspace)

    // A `converged` verdict must NOT block the write through the proof core — the
    // surfaces agree, so no `LocalSurfaceDisagreement` is raised and no conflict
    // lands in the read-only view.
    expect(guardBlockNames(workspace)).not.toContain('LocalSurfaceDisagreement')
    expect(openConflictsCount(sqlitePath)).toBe(0)
    // The deliverable is that the single coalesced intent PROCEEDS to remote —
    // not merely that nothing diverged. The remote property write is attempted.
    // (This also rules out the converged intent being silently dropped or blocked
    // by an unrelated guard such as `StaleSurfaceBase`.)
    expect(gateway.ledger.attemptedPatchPageProperties.length).toBeGreaterThanOrEqual(1)
  })
})

const establishedRootId = decode({
  schema: SyncRootIdSchema,
  value: `data-source:${testIds.dataSourceId}`,
})

const bodyHash = (char: string) => decode({ schema: Hash, value: `sha256:${char.repeat(64)}` })

/**
 * Two DISAGREEING local body surfaces for the same page, ONE per physical surface
 * (a SQLite `body_patch` edit + an `.nmd` body fact). This is the forward-looking
 * input — production keeps the SQLite body channel dormant, so the engine only sees
 * one body surface there; here the second surface is supplied to drive the
 * `body-body-delegated` conflict the rail must carry.
 */
const divergentBodySurfaces = (): {
  readonly sqlite: DataFileLocalEdit
  readonly nmd: NmdDesiredFact
} => ({
  sqlite: {
    identity: { kind: 'body', pageId: testIds.pageId },
    desiredHash: bodyHash('a'),
    baseHash: bodyHash('0'),
  },
  nmd: {
    identity: { kind: 'body', pageId: testIds.pageId },
    desiredHash: bodyHash('b'),
    baseHash: bodyHash('0'),
  },
})

type ReplicaConflictRow = {
  readonly page_id: string | null
  readonly property_id: string | null
  readonly state: string
}

const replicaConflictRows = (dataFilePath: string): readonly ReplicaConflictRow[] => {
  const db = new DatabaseSync(dataFilePath, { readOnly: true })
  try {
    return db
      .prepare(`SELECT page_id, property_id, state FROM _nds_replica_conflicts`)
      .all() as ReplicaConflictRow[]
  } finally {
    db.close()
  }
}

describe('decision 0013 body convergence — engine raise loop + per-surface blocking', () => {
  afterEach(async () => {
    await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  // Test (4): an engine-detected body divergence (two disagreeing local body
  // surfaces) raised through `raiseConvergenceConflicts` lands a page-keyed,
  // NULL-property_id `_nds_replica_conflicts` row and blocks the body identity.
  // Production is single-surface, so the second surface is constructed here — this
  // is the forward-looking activation path.
  it('engine body divergence lands a page-keyed _nds_replica_conflicts row (null property_id) and blocks the body', async () => {
    const workspace = await tempWorkspace()
    await establishShared(workspace)

    const { sqlite, nmd } = divergentBodySurfaces()
    const result = convergeLocalSurfaces({
      authorityMode: 'shared',
      dataFileEdits: [sqlite],
      nmdFacts: [nmd],
    })
    if (result._tag !== 'shared') throw new Error('expected shared')

    // The engine surfaces a body-body-delegated conflict AND blocks the body
    // identity from remote mutation.
    expect(result.conflicts.map((c) => c.kind)).toEqual(['body-body-delegated'])
    expect(result.blockedIdentities).toEqual([{ kind: 'body', pageId: testIds.pageId }])

    // Raise it onto the conflict rail through the SAME helper the CLI push uses,
    // then project the replica.
    const store = openNotionSyncStore({ path: stateSqlitePath(workspace) })
    try {
      raiseConvergenceConflicts({
        outcomes: result.outcomes,
        store,
        rootId: establishedRootId,
      })
    } finally {
      store.close()
    }
    projectReplicaFromSyncStore({
      syncStorePath: stateSqlitePath(workspace),
      replicaPath: sqlitePathForWorkspace(workspace),
      rootId: establishedRootId,
    })

    // The conflict reached `_nds_replica_conflicts`: page-keyed, NULL property_id.
    const rows = replicaConflictRows(sqlitePathForWorkspace(workspace))
    expect(rows).toMatchObject([{ page_id: testIds.pageId, property_id: null, state: 'open' }])
  })

  // Test (5): per-surface blocking (the ADR's load-bearing claim). A DIVERGENT body
  // and an AGREEING property on the SAME page in one pass: the body identity is
  // blocked, the property is NOT — there is no cross-surface atomicity.
  it('per-surface blocking: a divergent body does NOT block a co-page agreeing property', () => {
    const propertyIdentity = {
      kind: 'property',
      pageId: testIds.pageId,
      propertyId: selectProp,
    } as const
    const { sqlite: bodySqlite, nmd: bodyNmd } = divergentBodySurfaces()
    const result = convergeLocalSurfaces({
      authorityMode: 'shared',
      dataFileEdits: [
        { identity: propertyIdentity, desiredHash: bodyHash('c'), baseHash: bodyHash('d') },
        bodySqlite,
      ],
      nmdFacts: [
        { identity: propertyIdentity, desiredHash: bodyHash('c'), baseHash: bodyHash('d') },
        bodyNmd,
      ],
    })
    if (result._tag !== 'shared') throw new Error('expected shared')

    // ONLY the body identity is blocked; the agreeing property coalesces (converged).
    expect(result.blockedIdentities).toEqual([{ kind: 'body', pageId: testIds.pageId }])
    expect(result.propertyVerdicts).toEqual([
      { pageId: testIds.pageId, propertyId: selectProp, status: 'converged' },
    ])
    // The body conflict is raised independently of the clean property write.
    expect(result.conflicts.map((c) => c.kind)).toEqual(['body-body-delegated'])
  })
})
