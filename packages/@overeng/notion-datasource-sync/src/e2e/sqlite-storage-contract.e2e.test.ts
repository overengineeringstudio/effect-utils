import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect, Option } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  parseCliCommand,
  parseCliContext,
  resolveCliCommandNotionRefs,
  runCliCommandWithRuntime,
} from '../cli/main.ts'
import { PagePropertyItemPage } from '../core/commands.ts'
import { AbsolutePath, PropertyId, type AbsolutePath as AbsolutePathType } from '../core/domain.ts'
import { WorkspaceNamespaceError } from '../core/errors.ts'
import { SyncRootId } from '../core/events.ts'
import type { NotionGatewayClient } from '../gateway/notion.ts'
import {
  dataFileRelativePath,
  loadWorkspaceManifest,
  manifestPath,
  pagesDirRelativePath,
} from '../local/manifest.ts'
import {
  markReplicaChangeStatus,
  projectReplicaFromSyncStore,
  readPendingReplicaChanges,
} from '../replica/replica.ts'
import {
  decode,
  fixedObservedAt,
  hash,
  makeFakeGatewayHarness,
  testIds,
} from '../testing/harness.ts'

type SqlRow = Record<string, unknown>
type SqlParam = string | number | bigint | null | Uint8Array

const scratchDirs: string[] = []

const sqliteContractTimeoutMs = 15_000

const databaseUrl =
  'https://www.notion.so/example/0123456789abcdef0123456789abcdef?v=feedfacefeedfacefeedfacefeedface'

const propertyPage = (plainText: string) =>
  decode({
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
          itemHash: hash(`item-${plainText}`),
          valueHash: hash(`value-${plainText}`),
          valueJson: JSON.stringify({ _tag: 'title', plainText }),
        },
      ],
      nextCursor: null,
      hasMore: false,
    },
  })

const makeDatabaseResolverClient = (calls: { retrieveDatabase: number }): NotionGatewayClient => ({
  retrieveDataSource: () => Effect.succeed({ id: testIds.dataSourceId, properties: {} }),
  queryDataSource: () =>
    Effect.succeed({
      results: [],
      nextCursor: Option.none(),
      hasMore: false,
    }),
  retrievePage: () =>
    Effect.succeed({
      id: testIds.pageId,
      parent: { type: 'data_source_id', data_source_id: testIds.dataSourceId },
      properties: {},
      last_edited_time: fixedObservedAt,
      in_trash: false,
    }),
  retrievePageProperty: () =>
    Effect.succeed({
      results: [],
      nextCursor: Option.none(),
      hasMore: false,
    }),
  retrieveDatabase: () => {
    calls.retrieveDatabase += 1
    return Effect.succeed({
      id: testIds.databaseId,
      title: [],
      description: [],
      icon: null,
      data_sources: [{ id: testIds.dataSourceId, name: 'Rows' }],
    })
  },
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
    Effect.succeed({
      id: testIds.databaseId,
      title: [],
      description: [],
      icon: null,
    }),
})

const sqlitePathForWorkspace = (workspace: string): string =>
  join(workspace, 'data', 'v1', `${testIds.databaseId}.sqlite`)

// Control-plane store (ADR 0011): the binding, event log, and all `_nds_*`
// control-plane tables live here, split out of the public data file.
const statePathForWorkspace = (workspace: string): string =>
  join(workspace, '.notion', 'v1', 'state.sqlite')

const sidecarStorePath = (workspace: string): string =>
  join(workspace, '.notion-datasource-sync', 'store.sqlite')

const sidecarConfigPath = (workspace: string): string =>
  join(workspace, '.notion-datasource-sync', 'config.json')

const tempWorkspace = async (): Promise<AbsolutePathType> => {
  const dir = await mkdtemp(join(tmpdir(), 'notion-ds-sync-storage-contract-'))
  scratchDirs.push(dir)
  return decode({ schema: AbsolutePath, value: dir })
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const rows = (db: DatabaseSync, sql: string, ...params: readonly SqlParam[]): readonly SqlRow[] =>
  db.prepare(sql).all(...params) as SqlRow[]

const row = (db: DatabaseSync, sql: string, ...params: readonly SqlParam[]): SqlRow | undefined =>
  db.prepare(sql).get(...params) as SqlRow | undefined

const syncStatus = (db: DatabaseSync): SqlRow => {
  const status = row(db, `SELECT * FROM sync_status LIMIT 1`)
  if (status === undefined) throw new Error('sync_status did not contain a row')
  return status
}

const tableColumns = (db: DatabaseSync, table: string): readonly string[] =>
  rows(db, `PRAGMA table_xinfo(${JSON.stringify(table)})`).map((entry) => String(entry.name))

const sqliteMasterObjects = (db: DatabaseSync) =>
  rows(
    db,
    `SELECT type, name, sql
     FROM sqlite_master
     WHERE type IN ('table', 'view', 'trigger')
       AND name NOT LIKE 'sqlite_%'
     ORDER BY type, name`,
  )

const publicSafeNames = new Set([
  'pages',
  'schema',
  'schema_properties',
  'changes',
  'conflicts',
  'sync_status',
])

// Control-plane tables (defined in store/schema.ts) that MUST NOT appear in the
// public data file post control-plane split (DD-A, ADR 0011). The public data
// file is created only by `createReplicaSchema`, so the invariant is: every
// `_nds_*` object is `_nds_replica_*` and none of these control-plane tables
// leak in. The authoritative guard is the structural `ndsLeaks` check below
// (it catches EVERY control-plane table, including ones added later); this
// named set is a redundant, human-readable spot-check and is not exhaustive.
const forbiddenControlPlaneTables = new Set([
  '_nds_sync_root',
  '_nds_sync_event',
  '_nds_workspace_binding',
  '_nds_outbox',
  '_nds_guard_block',
  '_nds_tombstone',
  '_nds_capability',
  '_nds_conflict',
  '_nds_data_source',
  '_nds_schema_property',
  '_nds_row',
  '_nds_body_pointer',
  '_nds_property_shadow',
  '_nds_query_absence',
  '_nds_query_scan_checkpoint',
  '_nds_page_property_checkpoint',
  '_nds_api_contract',
  '_nds_projection_metadata',
])

const assertStorageTaxonomy = (db: DatabaseSync): void => {
  const objects = sqliteMasterObjects(db)
  const names = objects.map((object) => String(object.name))

  expect(names).toEqual(expect.arrayContaining([...publicSafeNames]))
  // DD-A (ADR 0011): the control-plane binding moved to state.sqlite; it must
  // not appear in the public data file.
  expect(names).not.toContain('_nds_workspace_binding')
  expect(names.some((name) => name.startsWith('debug_'))).toBe(true)

  const unsafePublic = names.filter((name) => {
    if (publicSafeNames.has(name) === true) return false
    if (name.startsWith('debug_') === true) return false
    if (name.startsWith('_nds_') === true) return false
    return true
  })
  expect(unsafePublic).toEqual([])

  // Every `_nds_*` object in the data file is either a `_nds_replica_*`
  // projection table/trigger or a public `_nds_pages_*` CDC trigger; no
  // control-plane table leaks across the file boundary.
  const ndsLeaks = names.filter(
    (name) =>
      name.startsWith('_nds_') === true &&
      name.startsWith('_nds_replica_') === false &&
      name.startsWith('_nds_pages_') === false,
  )
  expect(ndsLeaks).toEqual([])
  const controlPlaneLeaks = names.filter((name) => forbiddenControlPlaneTables.has(name) === true)
  expect(controlPlaneLeaks).toEqual([])

  const legacyNames = names.filter(
    (name) => name.startsWith('notion_') || name.endsWith('_projection') || name === 'sync_event',
  )
  expect(legacyNames).toEqual([])
}

// Asserts the control-plane store holds the control-plane tables and exposes no
// public views; standalone-queryable with no ATTACH (DD-A, ADR 0011).
const assertControlPlaneTaxonomy = (db: DatabaseSync): void => {
  const names = sqliteMasterObjects(db).map((object) => String(object.name))
  for (const table of [
    '_nds_sync_root',
    '_nds_sync_event',
    '_nds_workspace_binding',
    '_nds_outbox',
    '_nds_guard_block',
    '_nds_tombstone',
    '_nds_capability',
    '_nds_query_scan_checkpoint',
    '_nds_page_property_checkpoint',
  ]) {
    expect(names).toContain(table)
  }
  for (const publicView of publicSafeNames) {
    expect(names).not.toContain(publicView)
  }
}

const openReadOnly = <TValue>(path: string, f: (db: DatabaseSync) => TValue): TValue => {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return f(db)
  } finally {
    db.close()
  }
}

const insertPublicRowsCreate = ({
  sqlitePath,
  title,
  clientRequestKey,
}: {
  readonly sqlitePath: string
  readonly title: string
  readonly clientRequestKey: string
}): void => {
  const db = new DatabaseSync(sqlitePath)
  try {
    db.prepare(`INSERT INTO pages ("Task name", _client_request_key) VALUES (?, ?)`).run(
      title,
      clientRequestKey,
    )
  } finally {
    db.close()
  }
}

const updatePublicRowsTitle = ({
  sqlitePath,
  title,
}: {
  readonly sqlitePath: string
  readonly title: string
}): void => {
  const db = new DatabaseSync(sqlitePath)
  try {
    db.prepare(`UPDATE pages SET "Task name" = ? WHERE _page_id = ?`).run(title, testIds.pageId)
  } finally {
    db.close()
  }
}

const rowsTitleSchemaProperty = {
  propertyId: testIds.propertyA,
  name: 'Task name',
  type: 'title',
  configHash: hash('property-a-config'),
  writeClass: 'writable',
  ordinal: 0,
  configJson: JSON.stringify({ type: 'title' }),
}

const rowsStatusSchemaProperty = {
  propertyId: decode({ schema: PropertyId, value: 'status-prop' }),
  name: 'Status',
  type: 'status',
  configHash: hash('status-config'),
  writeClass: 'writable',
  ordinal: 1,
  configJson: JSON.stringify({
    id: 'status-prop',
    name: 'Status',
    type: 'status',
    status: {
      options: [
        { id: 'next', name: 'Next up', color: 'gray' },
        { id: 'done', name: 'Done', color: 'green' },
      ],
    },
  }),
}

const rowsSelectSchemaProperty = {
  propertyId: decode({ schema: PropertyId, value: 'priority-prop' }),
  name: 'Priority',
  type: 'select',
  configHash: hash('priority-config'),
  writeClass: 'writable',
  ordinal: 2,
  configJson: JSON.stringify({
    id: 'priority-prop',
    name: 'Priority',
    type: 'select',
    select: {
      options: [
        { id: 'low', name: 'Low', color: 'green' },
        { id: 'high', name: 'High', color: 'red' },
      ],
    },
  }),
}

const establishWorkspace = async (
  workspace: AbsolutePathType,
  {
    schemaProperties = [rowsTitleSchemaProperty],
    authorityMode,
  }: {
    readonly schemaProperties?: readonly (typeof rowsTitleSchemaProperty)[]
    /**
     * When set, adopt via `track --mode <authorityMode>` so the workspace permits
     * the asserted authority contract (e.g. `shared`/`local` for local-write +
     * settle flows). When omitted, adopt via `track --mode remote`, the
     * safe-by-default mirror mode.
     */
    readonly authorityMode?: 'local' | 'remote' | 'shared'
  } = {},
) => {
  const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })
  const calls = {
    retrieveDatabase: 0,
  }
  const gatewayClient = makeDatabaseResolverClient(calls)
  const schemaPropertiesJson = JSON.stringify(schemaProperties)
  const argv = (
    authorityMode === undefined
      ? ['track', databaseUrl, workspace, '--mode', 'remote']
      : ['track', databaseUrl, workspace, '--mode', authorityMode]
  ).concat([
    '--schema-properties-json',
    schemaPropertiesJson,
    '--no-materialize-bodies',
  ]) as readonly string[]
  const command = await Effect.runPromise(
    resolveCliCommandNotionRefs({
      command: parseCliCommand(argv),
      options: { gatewayClient },
    }),
  )
  const context = parseCliContext({ argv, resolvedCommand: command })
  try {
    const result = await Effect.runPromise(
      runCliCommandWithRuntime({
        command,
        context,
        options: {
          gateway: gateway.gateway,
          gatewayClient,
        },
      }),
    )
    return {
      gateway,
      result,
      calls,
      sqlitePath: sqlitePathForWorkspace(workspace),
      statePath: statePathForWorkspace(workspace),
    }
  } finally {
    context.store.close()
  }
}

const runWorkspaceCommand = async ({
  argv,
  gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] }),
}: {
  readonly argv: ReadonlyArray<string>
  readonly gateway?: ReturnType<typeof makeFakeGatewayHarness>
}) => {
  const command = parseCliCommand(argv)
  const context = parseCliContext({ argv, resolvedCommand: command })
  try {
    const result = await Effect.runPromise(
      runCliCommandWithRuntime({
        command,
        context,
        options: { gateway: gateway.gateway },
      }),
    )
    return { gateway, result }
  } finally {
    context.store.close()
  }
}

const expectCommandFailsClosed = async ({
  argv,
  gateway,
}: {
  readonly argv: ReadonlyArray<string>
  readonly gateway: ReturnType<typeof makeFakeGatewayHarness>
}): Promise<void> => {
  let didFail = false
  try {
    await runWorkspaceCommand({ argv, gateway })
  } catch {
    didFail = true
  }
  expect(didFail).toBe(true)
  expectNoRemoteWrites(gateway)
}

const expectNoRemoteWrites = (gateway: ReturnType<typeof makeFakeGatewayHarness>): void => {
  expect(gateway.ledger.attemptedPatchPageProperties).toHaveLength(0)
  expect(gateway.ledger.attemptedPatchDataSourceSchemas).toHaveLength(0)
  expect(gateway.ledger.attemptedPatchDataSourceMetadata).toHaveLength(0)
  expect(gateway.ledger.attemptedPatchDatabaseMetadata).toHaveLength(0)
  expect(gateway.ledger.attemptedTrashPages).toHaveLength(0)
  expect(gateway.ledger.attemptedRestorePages).toHaveLength(0)
}

describe('clean-break self-contained SQLite storage contract', () => {
  afterEach(async () => {
    await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it(
    'fresh track --mode remote creates one required database-id SQLite file without store or config sidecars',
    async () => {
      const workspace = await tempWorkspace()
      const { gateway, sqlitePath, result } = await establishWorkspace(workspace)

      expect(result).toMatchObject({
        command: 'track',
        result: { pushed: false },
      })
      expect(await exists(sqlitePath)).toBe(true)
      expect(await exists(sidecarStorePath(workspace))).toBe(false)
      expect(await exists(sidecarConfigPath(workspace))).toBe(false)
      expectNoRemoteWrites(gateway)

      // `track` writes the v1 manifest tracking the established source; a fresh
      // adoption with `--mode remote` records the safe-by-default `remote`
      // authority mode (VRS cli/spec.md).
      const manifestResult = loadWorkspaceManifest(workspace)
      expect(manifestResult._tag).toBe('tracked')
      if (manifestResult._tag === 'tracked') {
        expect(manifestResult.manifest).toMatchObject({
          namespace_version: 'v1',
          authority_mode: 'remote',
          data_sources: [
            {
              data_source_id: testIds.dataSourceId,
              database_id: testIds.databaseId,
              data_file: dataFileRelativePath(testIds.databaseId),
              pages_dir: pagesDirRelativePath(testIds.databaseId),
            },
          ],
        })
      }

      // The control-plane store splits out of the data file (ADR 0011): the
      // binding lives in state.sqlite, the public projection in the data file.
      expect(await exists(statePathForWorkspace(workspace))).toBe(true)
      openReadOnly(statePathForWorkspace(workspace), (db) => {
        assertControlPlaneTaxonomy(db)
        expect(
          row(db, `SELECT database_id, data_source_id, workspace_root FROM _nds_workspace_binding`),
        ).toMatchObject({
          database_id: testIds.databaseId,
          data_source_id: testIds.dataSourceId,
          workspace_root: workspace,
        })
      })
      openReadOnly(sqlitePath, (db) => {
        assertStorageTaxonomy(db)
        expect(row(db, `SELECT property_name, property_type FROM schema_properties`)).toEqual({
          property_name: 'Task name',
          property_type: 'title',
        })

        const columns = tableColumns(db, 'pages')
        expect(columns).not.toContain('schema_json')
        const firstPrivateColumn = columns.findIndex((column) => column.startsWith('_'))
        expect(firstPrivateColumn).toBeGreaterThan(0)
        expect(columns.slice(0, firstPrivateColumn)).toEqual(['Task name'])
        expect(columns.slice(firstPrivateColumn).every((column) => column.startsWith('_'))).toBe(
          true,
        )
      })
    },
    sqliteContractTimeoutMs,
  )

  it(
    'exposes the v1 clean-break `pages` surface and no public `rows` view or `_local_row_id` column [NDS-L2-pages-clean-break-surface]',
    async () => {
      const workspace = await tempWorkspace()
      const { sqlitePath } = await establishWorkspace(workspace)

      openReadOnly(sqlitePath, (db) => {
        const objects = sqliteMasterObjects(db)
        const names = objects.map((object) => String(object.name))

        // Clean break (R05): no public `rows` view and no `rows`-named view/trigger leak.
        expect(names).toContain('pages')
        expect(names).not.toContain('rows')
        const rowsLeak = objects.filter(
          (object) =>
            object.type !== 'table' &&
            (String(object.name) === 'rows' || String(object.name).startsWith('_nds_rows_')),
        )
        expect(rowsLeak).toEqual([])

        // The public surface uses `_local_page_id`, never the internal `_local_row_id`.
        const pageColumns = tableColumns(db, 'pages')
        expect(pageColumns).toContain('_local_page_id')
        expect(pageColumns).not.toContain('_local_row_id')

        // `SELECT * FROM pages` works; `SELECT * FROM rows` fails closed.
        expect(() => db.prepare(`SELECT * FROM pages`).all()).not.toThrow()
        expect(() => db.prepare(`SELECT * FROM rows`).all()).toThrow(/no such table/i)
      })
    },
    sqliteContractTimeoutMs,
  )

  it(
    'rejects product query contracts and establishment path overrides before creating database files',
    async () => {
      const workspace = await tempWorkspace()
      const explicitPath = join(workspace, 'custom.sqlite')
      const queryContractJson = JSON.stringify({
        _tag: 'QueryContract',
        apiVersion: '2026-03-11',
        filter: {
          _tag: 'property_value',
          propertyId: testIds.propertyA,
          operator: 'contains',
          value: { _tag: 'title', plainText: 'subset' },
        },
        sorts: [],
        pageSize: 10,
        highWatermark: null,
        membershipScope: 'explicit-filter',
      })

      expect(() =>
        parseCliContext({
          argv: [
            'track',
            databaseUrl,
            workspace,
            '--mode',
            'remote',
            '--query-contract-json',
            queryContractJson,
          ],
          resolvedCommand: parseCliCommand(['track', databaseUrl, workspace, '--mode', 'remote']),
        }),
      ).toThrow('--query-contract-json is not supported')
      expect(await exists(sqlitePathForWorkspace(workspace))).toBe(false)

      expect(() =>
        parseCliContext({
          argv: ['track', databaseUrl, workspace, '--mode', 'remote', '--sqlite', explicitPath],
          resolvedCommand: parseCliCommand(['track', databaseUrl, workspace, '--mode', 'remote']),
        }),
      ).toThrow('always creates <workspace>/<database-id>.sqlite')
      expect(await exists(explicitPath)).toBe(false)
    },
    sqliteContractTimeoutMs,
  )

  it(
    'CLI status sync --watch and doctor discover the self-contained SQLite from workspace or --sqlite without sidecars',
    async () => {
      const workspace = await tempWorkspace()
      const { sqlitePath } = await establishWorkspace(workspace)

      await expect(runWorkspaceCommand({ argv: ['status', workspace] })).resolves.toMatchObject({
        result: { command: 'status', result: { state: 'clean' } },
      })
      await expect(
        runWorkspaceCommand({ argv: ['status', '--sqlite', sqlitePath] }),
      ).resolves.toMatchObject({
        result: { command: 'status', result: { state: 'clean' } },
      })
      await expect(
        runWorkspaceCommand({ argv: ['sync', workspace, '--dry-run'] }),
      ).resolves.toMatchObject({
        result: { command: 'sync' },
      })
      await expect(
        runWorkspaceCommand({
          argv: [
            'sync',
            '--watch',
            '--sqlite',
            sqlitePath,
            '--state',
            join(workspace, 'watch.json'),
            '--max-cycles',
            '1',
          ],
        }),
      ).resolves.toMatchObject({
        result: { command: 'sync' },
      })
      await expect(
        runWorkspaceCommand({ argv: ['doctor', '--sqlite', sqlitePath] }),
      ).resolves.toMatchObject({
        result: { command: 'doctor', result: { clean: true } },
      })

      expect(await exists(sidecarStorePath(workspace))).toBe(false)
      expect(await exists(sidecarConfigPath(workspace))).toBe(false)
    },
    sqliteContractTimeoutMs,
  )

  it(
    'public rows mutations queue scalar update insert archive restore while unsafe writes fail closed',
    async () => {
      const workspace = await tempWorkspace()
      const { sqlitePath } = await establishWorkspace(workspace)

      const db = new DatabaseSync(sqlitePath)
      try {
        db.prepare(`UPDATE pages SET "Task name" = ? WHERE _page_id = ?`).run(
          'Updated through rows',
          testIds.pageId,
        )
        db.prepare(`INSERT INTO pages ("Task name", _client_request_key) VALUES (?, ?)`).run(
          'Created through rows',
          'contract-create-1',
        )
        db.prepare(`UPDATE pages SET _in_trash = 1 WHERE _page_id = ?`).run(testIds.pageId)
        db.prepare(`UPDATE pages SET _in_trash = 0 WHERE _page_id = ?`).run(testIds.pageId)

        expect(
          rows(db, `SELECT kind, status FROM changes ORDER BY created_at, change_id`).map(
            (change) => change.kind,
          ),
        ).toEqual(
          expect.arrayContaining(['cell_patch', 'row_create', 'row_archive', 'row_restore']),
        )
        expect(
          row(
            db,
            `SELECT count(*) AS count
             FROM changes
             WHERE kind = 'row_archive' AND status = 'rejected'`,
          ),
        ).toMatchObject({ count: 1 })
        expect(row(db, `SELECT pending_local_changes FROM sync_status LIMIT 1`)).toMatchObject({
          pending_local_changes: 3,
        })

        expect(() =>
          db.prepare(`DELETE FROM pages WHERE _page_id = ?`).run(testIds.pageId),
        ).toThrow(/unsupported|unsafe|archive/i)
        expect(() =>
          db
            .prepare(
              `INSERT INTO changes (change_id, kind, data_source_id)
               VALUES ('manual-change', 'metadata_patch', ?)`,
            )
            .run(testIds.dataSourceId),
        ).toThrow(/view|read-only|modify/i)
        expect(() =>
          db
            .prepare(`UPDATE pages SET _page_id = 'other-page' WHERE _page_id = ?`)
            .run(testIds.pageId),
        ).toThrow(/read-only|system|identity/i)
        expect(() => db.prepare(`UPDATE schema SET name = 'Unsafe'`).run()).toThrow(
          /read-only|schema/i,
        )
        // DD-A (ADR 0011): the control-plane binding is not in the data file at
        // all, so a direct write fails because the table is absent here.
        expect(() => db.prepare(`INSERT INTO _nds_workspace_binding DEFAULT VALUES`).run()).toThrow(
          /no such table/i,
        )
      } finally {
        db.close()
      }
      // The binding lives in the control-plane store, where its insert guard
      // still fails closed against direct tampering.
      openReadOnly(statePathForWorkspace(workspace), (stateDb) => {
        expect(() =>
          stateDb.prepare(`INSERT INTO _nds_workspace_binding DEFAULT VALUES`).run(),
        ).toThrow(/read-only|internal|private|unsafe|attempt to write/i)
      })

      const beforePending = openReadOnly(sqlitePath, (readDb) =>
        row(readDb, `SELECT count(*) AS count FROM changes WHERE status = 'pending'`),
      )

      await establishWorkspace(workspace)

      openReadOnly(sqlitePath, (readDb) => {
        expect(
          row(readDb, `SELECT count(*) AS count FROM changes WHERE status = 'pending'`),
        ).toEqual(beforePending)
      })
    },
    sqliteContractTimeoutMs,
  )

  it(
    'public changes reports a pending row_create from direct rows INSERT before sync --watch runs',
    async () => {
      const workspace = await tempWorkspace()
      const { sqlitePath } = await establishWorkspace(workspace)

      insertPublicRowsCreate({
        sqlitePath,
        title: 'Created before watch',
        clientRequestKey: 'watch-create-pending',
      })

      openReadOnly(sqlitePath, (db) => {
        expect(
          row(
            db,
            `SELECT kind, status
             FROM changes
             WHERE kind = 'row_create'
             ORDER BY created_at DESC
             LIMIT 1`,
          ),
        ).toMatchObject({
          kind: 'row_create',
          status: 'pending',
        })
      })
    },
    sqliteContractTimeoutMs,
  )

  it(
    'public rows scalar UPDATE queues one mirrored cell change identity',
    async () => {
      const workspace = await tempWorkspace()
      const { sqlitePath } = await establishWorkspace(workspace)

      updatePublicRowsTitle({ sqlitePath, title: 'Single mirrored change' })

      openReadOnly(sqlitePath, (db) => {
        const localChange = row(
          db,
          `SELECT change_id, kind, property_id, status
           FROM _nds_replica_local_changes
           WHERE kind = 'cell_patch'`,
        )
        const cellChange = row(
          db,
          `SELECT change_id, property_id, status
           FROM _nds_replica_cell_changes`,
        )

        expect(localChange).toMatchObject({
          kind: 'cell_patch',
          property_id: testIds.propertyA,
          status: 'pending',
        })
        expect(cellChange).toMatchObject({
          property_id: testIds.propertyA,
          status: 'pending',
        })
        expect(localChange?.change_id).toBe(cellChange?.change_id)
        expect(row(db, `SELECT count(*) AS count FROM changes WHERE kind = 'cell_patch'`)).toEqual({
          count: 1,
        })
        expect(syncStatus(db)).toMatchObject({ pending_local_changes: 1 })
      })

      expect(readPendingReplicaChanges(sqlitePath)).toHaveLength(1)
    },
    sqliteContractTimeoutMs,
  )

  it(
    'sync --watch drains a direct public rows INSERT row_create through fake Notion and settles it',
    async () => {
      const workspace = await tempWorkspace()
      const { sqlitePath } = await establishWorkspace(workspace)
      insertPublicRowsCreate({
        sqlitePath,
        title: 'Created by watch',
        clientRequestKey: 'watch-create-settled',
      })

      const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })
      const watch = await runWorkspaceCommand({
        argv: [
          'sync',
          '--watch',
          '--sqlite',
          sqlitePath,
          '--state',
          join(workspace, 'watch.json'),
          '--max-cycles',
          '1',
          '--no-materialize-bodies',
        ],
        gateway,
      })

      expect(watch.result.status.state).toBe('clean')
      openReadOnly(sqlitePath, (db) => {
        expect(
          row(
            db,
            `SELECT kind, status
             FROM changes
             WHERE kind = 'row_create'
             ORDER BY created_at DESC
             LIMIT 1`,
          ),
        ).toMatchObject({
          kind: 'row_create',
          status: 'applied',
        })
        expect(
          row(
            db,
            `SELECT _page_id, _client_request_key, _sync_status
             FROM pages
             WHERE _client_request_key = ?`,
            'watch-create-settled',
          ),
        ).toMatchObject({
          _page_id: 'fake-created-watch-create-settled',
          _client_request_key: 'watch-create-settled',
          _sync_status: 'applied',
        })
        expect(
          row(db, `SELECT count(*) AS count FROM changes WHERE status = 'pending'`),
        ).toMatchObject({ count: 0 })
      })
    },
    sqliteContractTimeoutMs,
  )

  it(
    'CLI status stays non-clean while direct public rows INSERT leaves pending changes',
    async () => {
      const workspace = await tempWorkspace()
      const { sqlitePath } = await establishWorkspace(workspace)
      insertPublicRowsCreate({
        sqlitePath,
        title: 'Pending after watch',
        clientRequestKey: 'watch-create-not-clean',
      })

      const status = await runWorkspaceCommand({
        argv: ['status', '--sqlite', sqlitePath],
      })

      expect(status.result.command).toBe('status')
      if (status.result.command !== 'status') throw new Error('expected status result')
      expect(status.result.result).toMatchObject({
        state: 'pending',
        counts: {
          pending: expect.any(Number),
          clean: 0,
        },
      })
    },
    sqliteContractTimeoutMs,
  )

  it(
    'sync_status exposes explicit public state buckets without treating unsupported or incomplete hydration as pending local work',
    async () => {
      const workspace = await tempWorkspace()
      const { sqlitePath } = await establishWorkspace(workspace)

      openReadOnly(sqlitePath, (db) => {
        expect(syncStatus(db)).toMatchObject({
          state: 'clean',
          pending_local_changes: 0,
          conflicts_open: 0,
          unsupported_local_changes: 0,
          incomplete_hydration: 0,
        })
      })

      updatePublicRowsTitle({ sqlitePath, title: 'Pending status bucket' })
      const pendingChangeId = openReadOnly(sqlitePath, (db) => {
        expect(syncStatus(db)).toMatchObject({
          state: 'pending',
          pending_local_changes: 1,
        })
        return String(
          row(
            db,
            `SELECT change_id
             FROM changes
             WHERE kind = 'cell_patch'
             ORDER BY created_at DESC
             LIMIT 1`,
          )?.change_id,
        )
      })

      markReplicaChangeStatus({
        replicaPath: sqlitePath,
        changeId: pendingChangeId,
        status: 'unsupported',
        unsupportedReason: 'test unsupported write class',
      })
      openReadOnly(sqlitePath, (db) => {
        expect(syncStatus(db)).toMatchObject({
          state: 'unsupported',
          pending_local_changes: 0,
          unsupported_local_changes: 1,
        })
      })

      // Mark the unsupported change applied so it stops counting as unsupported
      // (these CDC tables are the data file's projection inbox).
      const dataDb = new DatabaseSync(sqlitePath)
      try {
        dataDb
          .prepare(
            `UPDATE _nds_replica_local_changes
             SET status = 'applied', unsupported_reason = NULL
             WHERE change_id = ?`,
          )
          .run(pendingChangeId)
        dataDb
          .prepare(
            `UPDATE _nds_replica_cell_changes
             SET status = 'applied', unsupported_reason = NULL
             WHERE change_id = ?`,
          )
          .run(pendingChangeId)
      } finally {
        dataDb.close()
      }

      // DD-B (ADR 0011): the control-plane tables that feed sync_status moved to
      // state.sqlite, and the view reads only the materialized projection table.
      // So these buckets must be exercised by mutating the control plane and
      // re-projecting, not by writing the data file and reading it live.
      const statePath = statePathForWorkspace(workspace)
      const identity = openReadOnly(statePath, (stateDb) =>
        row(stateDb, `SELECT root_id, data_source_id FROM _nds_data_source LIMIT 1`),
      )
      expect(identity).toMatchObject({
        root_id: expect.any(String),
        data_source_id: expect.any(String),
      })
      const rootId = decode({ schema: SyncRootId, value: String(identity?.root_id) })
      const dataSourceId = String(identity?.data_source_id)

      const reproject = (): void =>
        projectReplicaFromSyncStore({ syncStorePath: statePath, replicaPath: sqlitePath, rootId })

      const mutateState = (f: (db: DatabaseSync) => void): void => {
        const stateDb = new DatabaseSync(statePath)
        try {
          f(stateDb)
        } finally {
          stateDb.close()
        }
        reproject()
      }

      mutateState((stateDb) =>
        stateDb
          .prepare(
            `INSERT INTO _nds_query_scan_checkpoint (
               root_id, data_source_id, query_contract_hash, next_cursor, complete,
               capped_at_limit, contract_changed, high_watermark, event_id, updated_at
             ) VALUES (?, ?, ?, NULL, 0, 0, 0, NULL, ?, ?)`,
          )
          .run(
            rootId,
            dataSourceId,
            hash('contract-incomplete-status'),
            'event-incomplete-status',
            fixedObservedAt,
          ),
      )
      openReadOnly(sqlitePath, (db) =>
        expect(syncStatus(db)).toMatchObject({
          state: 'incomplete',
          pending_local_changes: 0,
          incomplete_hydration: 1,
        }),
      )

      mutateState((stateDb) => {
        stateDb
          .prepare(
            `DELETE FROM _nds_query_scan_checkpoint
             WHERE root_id = ? AND query_contract_hash = ?`,
          )
          .run(rootId, hash('contract-incomplete-status'))
        stateDb
          .prepare(
            `INSERT INTO _nds_outbox (
               root_id, command_id, command_key, intent_event_id, surface, command_tag, state,
               base_hash, desired_hash, preflight_json, attempt_count, lease_token,
               settlement_event_id, retry_after_millis, retry_after_at, last_event_id, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'blocked', NULL, ?, '{}', 0, NULL, NULL, NULL, NULL, ?, ?)`,
          )
          .run(
            rootId,
            'cmd-degraded-status',
            'cmd-key-degraded-status',
            'intent-degraded-status',
            `property:${testIds.pageId}:${testIds.propertyA}`,
            'PatchPageProperties',
            hash('desired-degraded-status'),
            'event-degraded-status',
            fixedObservedAt,
          )
      })
      openReadOnly(sqlitePath, (db) =>
        expect(syncStatus(db)).toMatchObject({
          state: 'degraded',
          blocked_outbox: 1,
        }),
      )

      mutateState((stateDb) =>
        stateDb
          .prepare(`UPDATE _nds_outbox SET state = 'settled' WHERE command_id = ?`)
          .run('cmd-degraded-status'),
      )

      // Conflicts are a data-file projection table read live by the view, so the
      // bucket is exercised directly on the data file.
      const conflictDb = new DatabaseSync(sqlitePath)
      try {
        conflictDb
          .prepare(
            `INSERT INTO _nds_replica_conflicts (
               conflict_id, page_id, property_id, state, base_hash, local_hash, remote_hash,
               opened_event_id, resolution_event_id, updated_at
             ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, NULL, ?)`,
          )
          .run(
            'conflict-status',
            testIds.pageId,
            testIds.propertyA,
            hash('base-conflict-status'),
            hash('local-conflict-status'),
            hash('remote-conflict-status'),
            'event-conflict-status',
            fixedObservedAt,
          )
        expect(syncStatus(conflictDb)).toMatchObject({
          state: 'conflicted',
          conflicts_open: 1,
        })
      } finally {
        conflictDb.close()
      }
    },
    sqliteContractTimeoutMs,
  )

  it(
    'sync --watch drains a direct public rows UPDATE through fake Notion and settles it',
    async () => {
      const workspace = await tempWorkspace()
      // Local-write -> remote-settle requires a mode that permits local writes;
      // adopt as `shared` (a `remote` mirror would block the edit as drift).
      const { sqlitePath } = await establishWorkspace(workspace, { authorityMode: 'shared' })
      updatePublicRowsTitle({ sqlitePath, title: 'Updated by watch' })

      const baseGateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })
      const operationOrder: string[] = []
      const gateway = {
        ...baseGateway,
        gateway: {
          ...baseGateway.gateway,
          queryRows: (input: Parameters<typeof baseGateway.gateway.queryRows>[0]) => {
            operationOrder.push('query')
            return baseGateway.gateway.queryRows(input)
          },
          patchPageProperties: (
            command: Parameters<typeof baseGateway.gateway.patchPageProperties>[0],
          ) =>
            Effect.sync(() => {
              operationOrder.push('patch')
            }).pipe(Effect.zipRight(baseGateway.gateway.patchPageProperties(command))),
        },
      }
      await runWorkspaceCommand({
        argv: [
          'sync',
          '--watch',
          '--sqlite',
          sqlitePath,
          '--state',
          join(workspace, 'watch.json'),
          '--max-cycles',
          '1',
          '--no-materialize-bodies',
        ],
        gateway,
      })

      expect(gateway.ledger.successfulPatchPageProperties).toHaveLength(1)
      expect(operationOrder.indexOf('patch')).toBeLessThan(operationOrder.indexOf('query'))
      openReadOnly(sqlitePath, (db) => {
        expect(
          row(
            db,
            `SELECT COUNT(*) AS count
             FROM changes
             WHERE kind = 'cell_patch' AND page_id = ?`,
            testIds.pageId,
          ),
        ).toMatchObject({ count: 1 })
        expect(
          row(
            db,
            `SELECT kind, status, value_json
             FROM changes
             WHERE kind = 'cell_patch' AND page_id = ?`,
            testIds.pageId,
          ),
        ).toMatchObject({
          kind: 'cell_patch',
          status: 'applied',
          value_json: JSON.stringify({ _tag: 'title', plainText: 'Updated by watch' }),
        })
      })
    },
    sqliteContractTimeoutMs,
  )

  it(
    'sync --watch uses the latest clean remote observation as the base for public rows UPDATE',
    async () => {
      const workspace = await tempWorkspace()
      // Local-write flow: adopt as `shared` so the edit is not blocked as drift.
      const { sqlitePath } = await establishWorkspace(workspace, { authorityMode: 'shared' })
      await runWorkspaceCommand({
        argv: ['sync', '--sqlite', sqlitePath, '--no-materialize-bodies'],
        gateway: makeFakeGatewayHarness({ propertyPages: [propertyPage('Remote drift')] }),
      })
      updatePublicRowsTitle({ sqlitePath, title: 'Local after remote drift' })

      const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Remote drift')] })
      const watch = await runWorkspaceCommand({
        argv: [
          'sync',
          '--watch',
          '--sqlite',
          sqlitePath,
          '--state',
          join(workspace, 'watch-after-drift.json'),
          '--max-cycles',
          '1',
          '--no-materialize-bodies',
        ],
        gateway,
      })

      expect(watch.result.status.state).toBe('clean')
      expect(gateway.ledger.successfulPatchPageProperties).toHaveLength(1)
      openReadOnly(sqlitePath, (db) => {
        expect(
          row(
            db,
            `SELECT kind, status, unsupported_reason
             FROM changes
             WHERE kind = 'cell_patch' AND page_id = ?
             ORDER BY created_at DESC
             LIMIT 1`,
            testIds.pageId,
          ),
        ).toMatchObject({
          kind: 'cell_patch',
          status: 'applied',
          unsupported_reason: null,
        })
        expect(row(db, `SELECT conflicts_open FROM sync_status LIMIT 1`)).toMatchObject({
          conflicts_open: 0,
        })
      })
    },
    sqliteContractTimeoutMs,
  )

  it(
    'sync --watch drains a direct public rows archive through fake Notion and settles it',
    async () => {
      const workspace = await tempWorkspace()
      const { sqlitePath } = await establishWorkspace(workspace)
      const db = new DatabaseSync(sqlitePath)
      try {
        db.prepare(`UPDATE pages SET _in_trash = 1 WHERE _page_id = ?`).run(testIds.pageId)
      } finally {
        db.close()
      }

      const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })
      await runWorkspaceCommand({
        argv: [
          'sync',
          '--watch',
          '--sqlite',
          sqlitePath,
          '--state',
          join(workspace, 'watch.json'),
          '--max-cycles',
          '1',
          '--no-materialize-bodies',
        ],
        gateway,
      })

      expect(gateway.ledger.successfulTrashPages).toHaveLength(1)
      openReadOnly(sqlitePath, (readDb) => {
        expect(
          rows(
            readDb,
            `SELECT kind, status
             FROM changes
             WHERE kind = 'row_archive' AND page_id = ?
             ORDER BY created_at, change_id`,
            testIds.pageId,
          ),
        ).toEqual([expect.objectContaining({ kind: 'row_archive', status: 'applied' })])
        expect(
          row(readDb, `SELECT _in_trash FROM pages WHERE _page_id = ?`, testIds.pageId),
        ).toMatchObject({ _in_trash: 1 })
      })
    },
    sqliteContractTimeoutMs,
  )

  it(
    'rows enforces current Notion select and status options before queuing CDC',
    async () => {
      const workspace = await tempWorkspace()
      const { sqlitePath } = await establishWorkspace(workspace, {
        schemaProperties: [
          rowsTitleSchemaProperty,
          rowsStatusSchemaProperty,
          rowsSelectSchemaProperty,
        ],
      })

      const db = new DatabaseSync(sqlitePath)
      try {
        expect(() =>
          db
            .prepare(`UPDATE pages SET "Status" = ? WHERE _page_id = ?`)
            .run('Definitely not real', testIds.pageId),
        ).toThrow(/malformed|unsupported/i)
        expect(() =>
          db.prepare(`UPDATE pages SET "Priority" = ? WHERE _page_id = ?`).run('', testIds.pageId),
        ).toThrow(/malformed|unsupported/i)
        expect(() =>
          db
            .prepare(`INSERT INTO pages ("Task name", "Status") VALUES (?, ?)`)
            .run('Bad status create', 'Definitely not real'),
        ).toThrow(/malformed|unsupported/i)

        db.prepare(`UPDATE pages SET "Status" = ?, "Priority" = ? WHERE _page_id = ?`).run(
          'Next up',
          'High',
          testIds.pageId,
        )
        db.prepare(`INSERT INTO pages ("Task name", "Status", "Priority") VALUES (?, ?, ?)`).run(
          'Good option create',
          'Done',
          'Low',
        )

        expect(
          rows(
            db,
            `SELECT kind, property_id, value_json
             FROM changes
             WHERE status = 'pending'
             ORDER BY created_at, change_id`,
          ),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'cell_patch',
              property_id: 'status-prop',
              value_json: JSON.stringify({
                _tag: 'status',
                option: { _tag: 'CanonicalOptionValue', name: 'Next up' },
              }),
            }),
            expect.objectContaining({
              kind: 'cell_patch',
              property_id: 'priority-prop',
              value_json: JSON.stringify({
                _tag: 'select',
                option: { _tag: 'CanonicalOptionValue', name: 'High' },
              }),
            }),
            expect.objectContaining({
              kind: 'row_create',
            }),
          ]),
        )
      } finally {
        db.close()
      }
    },
    sqliteContractTimeoutMs,
  )

  it(
    'doctor and sync fail closed on binding, internal-state, trigger, and view tampering before remote writes',
    async () => {
      // Workspace-rooted tamper cases resolve their store through the v1
      // manifest, so each tampers the manifest-resolved control-plane store in
      // its own fresh workspace (an in-place tamper) and runs against that
      // workspace. The binding lives in the control-plane store post-split (ADR
      // 0011), so these tamper the state file. This exercises the real integrity
      // path: a corrupt/missing binding makes discovery refuse before any
      // remote write.
      const workspaceRootedTamperCases: ReadonlyArray<{
        readonly name: string
        readonly sql: (db: DatabaseSync) => void
        readonly argv: (workspaceRoot: string) => ReadonlyArray<string>
      }> = [
        {
          name: 'missing workspace binding',
          sql: (db) => db.prepare(`DELETE FROM _nds_workspace_binding`).run(),
          argv: (workspaceRoot) => ['sync', workspaceRoot],
        },
        {
          name: 'invalid binding',
          sql: (db) =>
            db
              .prepare(`UPDATE _nds_workspace_binding SET workspace_root = ?`)
              .run('/some/other/workspace'),
          argv: (workspaceRoot) => ['status', workspaceRoot],
        },
      ]

      await Promise.all(
        workspaceRootedTamperCases.map(async (tamperCase) => {
          const caseWorkspace = await tempWorkspace()
          await establishWorkspace(caseWorkspace)
          const db = new DatabaseSync(statePathForWorkspace(caseWorkspace))
          try {
            tamperCase.sql(db)
          } finally {
            db.close()
          }
          const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })
          await expectCommandFailsClosed({ argv: tamperCase.argv(caseWorkspace), gateway })
        }),
      )

      // Tamper cases corrupt objects that now live in one of the two split
      // files (ADR 0011): control-plane tables in the state store, public views
      // and CDC triggers in the data file. Each runs in its own fresh workspace
      // and tampers the manifest-resolved file in place; `--sqlite <data file>`
      // resolves the sibling control-plane store, so each tampering trips the
      // fail-closed validation before any remote write.
      const tamperCases: ReadonlyArray<{
        readonly name: string
        readonly tamperPath: (paths: { sqlitePath: string; statePath: string }) => string
        readonly sql: (db: DatabaseSync) => void
        readonly argv: (path: string) => ReadonlyArray<string>
      }> = [
        {
          name: 'dropped control-plane state',
          tamperPath: ({ statePath }) => statePath,
          sql: (db) => {
            const privateTable = row(
              db,
              `SELECT name FROM sqlite_master
               WHERE type = 'table' AND name LIKE '_nds_%' AND name <> '_nds_workspace_binding'
               ORDER BY name LIMIT 1`,
            )
            expect(privateTable?.name).toEqual(expect.any(String))
            db.prepare(`DROP TABLE ${String(privateTable?.name)}`).run()
          },
          argv: (path) => ['doctor', '--sqlite', path],
        },
        {
          name: 'dropped pages trigger',
          tamperPath: ({ sqlitePath: dataPath }) => dataPath,
          sql: (db) => {
            const trigger = row(
              db,
              `SELECT name FROM sqlite_master
               WHERE type = 'trigger' AND name LIKE '_nds_pages_%'
               ORDER BY name LIMIT 1`,
            )
            expect(trigger?.name).toEqual(expect.any(String))
            db.prepare(`DROP TRIGGER ${String(trigger?.name)}`).run()
          },
          argv: (path) => ['sync', '--sqlite', path, '--dry-run'],
        },
        {
          name: 'dropped public pages view',
          tamperPath: ({ sqlitePath: dataPath }) => dataPath,
          sql: (db) => db.prepare(`DROP VIEW pages`).run(),
          argv: (path) => ['doctor', '--sqlite', path],
        },
      ]

      await Promise.all(
        tamperCases.map(async (tamperCase) => {
          const caseWorkspace = await tempWorkspace()
          const { sqlitePath: caseSqlitePath } = await establishWorkspace(caseWorkspace)
          const db = new DatabaseSync(
            tamperCase.tamperPath({
              sqlitePath: caseSqlitePath,
              statePath: statePathForWorkspace(caseWorkspace),
            }),
          )
          try {
            tamperCase.sql(db)
          } finally {
            db.close()
          }

          const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })
          await expectCommandFailsClosed({ argv: tamperCase.argv(caseSqlitePath), gateway })
        }),
      )
    },
    sqliteContractTimeoutMs,
  )

  it(
    'a data-file copy stays standalone-queryable and reports moved-workspace status, but is not operable without the control plane',
    async () => {
      const workspace = await tempWorkspace()
      const movedWorkspace = await tempWorkspace()
      const { sqlitePath } = await establishWorkspace(workspace)
      // A backup of just the public data file: the control plane (ADR 0011)
      // lives in `.notion/v1/state.sqlite` and is NOT copied along.
      const copyPath = join(movedWorkspace, `${testIds.databaseId}.sqlite`)
      await copyFile(sqlitePath, copyPath)

      openReadOnly(copyPath, (db) => {
        // The data file is standalone-queryable with no ATTACH: its public views
        // (including move-detection via the materialized workspace_root + the
        // pragma_database_list self-join) work without the control plane.
        assertStorageTaxonomy(db)
        expect(row(db, `SELECT workspace_status FROM sync_status`)).toMatchObject({
          workspace_status: 'moved',
        })
        // The control-plane binding is not in the data file (DD-A).
        expect(() => row(db, `SELECT database_id FROM _nds_workspace_binding`)).toThrow(
          /no such table/i,
        )
      })

      // The data file alone is not operable: a workspace command cannot resolve
      // the control plane from the moved location and fails closed.
      const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })
      await expectCommandFailsClosed({ argv: ['status', '--sqlite', copyPath], gateway })
      expect(await exists(sidecarStorePath(movedWorkspace))).toBe(false)
      expect(await exists(sidecarConfigPath(movedWorkspace))).toBe(false)
    },
    sqliteContractTimeoutMs,
  )

  it(
    'sync --sqlite fails closed on a mixed or unknown workspace namespace before reading local edits',
    async () => {
      const expectSyncSqliteFailsClosed = ({
        sqlitePath,
        expectedGuard,
      }: {
        readonly sqlitePath: string
        readonly expectedGuard: 'MixedWorkspaceNamespace' | 'UnknownWorkspaceNamespace'
      }): void => {
        const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })
        let caught: unknown
        try {
          // `sync` is a write-intent command: the namespace guard must fire in
          // parseCliContext before the store is opened or intents are read.
          parseCliContext({
            argv: ['sync', '--sqlite', sqlitePath],
            resolvedCommand: parseCliCommand(['sync', '--sqlite', sqlitePath]),
          })
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(WorkspaceNamespaceError)
        expect((caught as WorkspaceNamespaceError).guard).toBe(expectedGuard)
        expectNoRemoteWrites(gateway)
      }

      // Mixed namespace: a v2 sibling directory coexists with the v1 manifest.
      const mixedWorkspace = await tempWorkspace()
      const { sqlitePath: mixedSqlitePath } = await establishWorkspace(mixedWorkspace)
      await mkdir(join(mixedWorkspace, 'data', 'v2'), { recursive: true })
      expectSyncSqliteFailsClosed({
        sqlitePath: mixedSqlitePath,
        expectedGuard: 'MixedWorkspaceNamespace',
      })

      // Unknown namespace: the manifest declares a non-v1 version (no sibling,
      // so detection reaches the decode branch rather than the mixed branch).
      const unknownWorkspace = await tempWorkspace()
      const { sqlitePath: unknownSqlitePath } = await establishWorkspace(unknownWorkspace)
      await writeFile(
        manifestPath(unknownWorkspace),
        JSON.stringify({ namespace_version: 'v2', authority_mode: 'shared', data_sources: [] }),
        'utf8',
      )
      expectSyncSqliteFailsClosed({
        sqlitePath: unknownSqlitePath,
        expectedGuard: 'UnknownWorkspaceNamespace',
      })
    },
    sqliteContractTimeoutMs,
  )

  it(
    'isolates the hidden control plane: the public data file exposes only the product surface + projection cache, the control plane lives in state.sqlite, and both are standalone-queryable [NDS-L2-hidden-control-plane-isolation]',
    async () => {
      const workspace = await tempWorkspace()
      const { sqlitePath, statePath } = await establishWorkspace(workspace)

      // The public data file: product views + `_nds_replica_*` cache, and NO
      // control-plane tables (DD-A, ADR 0011). Standalone-queryable (no ATTACH).
      openReadOnly(sqlitePath, (db) => {
        const names = sqliteMasterObjects(db).map((object) => String(object.name))
        for (const view of [
          'pages',
          'changes',
          'conflicts',
          'sync_status',
          'schema',
          'schema_properties',
        ]) {
          expect(names).toContain(view)
        }
        expect(names.some((name) => name.startsWith('debug_'))).toBe(true)
        expect(names.some((name) => name.startsWith('_nds_replica_'))).toBe(true)
        for (const forbidden of [
          '_nds_outbox',
          '_nds_guard_block',
          '_nds_sync_event',
          '_nds_sync_root',
          '_nds_capability',
          '_nds_tombstone',
          '_nds_query_scan_checkpoint',
          '_nds_page_property_checkpoint',
          '_nds_workspace_binding',
        ]) {
          expect(names).not.toContain(forbidden)
        }
        // Reading the public surface needs no control-plane attach.
        expect(row(db, `SELECT count(*) AS count FROM pages`)).toMatchObject({
          count: expect.any(Number),
        })
        expect(row(db, `SELECT workspace_status FROM sync_status`)).toMatchObject({
          workspace_status: 'bound',
        })
      })

      // The control-plane store: control-plane tables present, NO public views.
      // Standalone-queryable (no ATTACH).
      openReadOnly(statePath, (db) => {
        const names = sqliteMasterObjects(db).map((object) => String(object.name))
        for (const table of [
          '_nds_sync_root',
          '_nds_sync_event',
          '_nds_workspace_binding',
          '_nds_outbox',
          '_nds_guard_block',
          '_nds_tombstone',
          '_nds_capability',
        ]) {
          expect(names).toContain(table)
        }
        for (const publicView of ['pages', 'changes', 'conflicts', 'sync_status']) {
          expect(names).not.toContain(publicView)
        }
        expect(row(db, `SELECT count(*) AS count FROM _nds_sync_event`)).toMatchObject({
          count: expect.any(Number),
        })
      })
    },
    sqliteContractTimeoutMs,
  )

  it(
    'crosses the file boundary: a CDC edit in the data file drains into the state event log, settles, and survives deleting + re-projecting the data file [NDS-L2-hidden-control-plane-isolation]',
    async () => {
      const workspace = await tempWorkspace()
      // CDC edit -> remote settle: adopt as `shared` (a `remote` mirror blocks it).
      const { sqlitePath, statePath } = await establishWorkspace(workspace, {
        authorityMode: 'shared',
      })

      // A user edit lands in the data file's transient CDC inbox.
      updatePublicRowsTitle({ sqlitePath, title: 'Edited across the boundary' })
      expect(readPendingReplicaChanges(sqlitePath)).toHaveLength(1)

      const eventsBefore = openReadOnly(statePath, (db) =>
        Number(row(db, `SELECT count(*) AS count FROM _nds_sync_event`)?.count),
      )

      // sync drains the data-file CDC, appends the intent to the state event log,
      // executes it against fake Notion, settles, and re-projects.
      const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })
      await runWorkspaceCommand({
        argv: [
          'sync',
          '--watch',
          '--sqlite',
          sqlitePath,
          '--state',
          join(workspace, 'watch.json'),
          '--max-cycles',
          '1',
          '--no-materialize-bodies',
        ],
        gateway,
      })

      // The drain crossed the boundary: a remote write happened, the state event
      // log grew, and the data-file CDC inbox is cleared (no pending rows).
      expect(gateway.ledger.successfulPatchPageProperties).toHaveLength(1)
      const eventsAfter = openReadOnly(statePath, (db) =>
        Number(row(db, `SELECT count(*) AS count FROM _nds_sync_event`)?.count),
      )
      expect(eventsAfter).toBeGreaterThan(eventsBefore)
      expect(
        readPendingReplicaChanges(sqlitePath).filter((change) => change.status === 'pending'),
      ).toHaveLength(0)

      // The data file is a rebuildable cache: deleting it and re-projecting from
      // the control plane restores the public surface (correctness lives in the
      // event log, not the data file). ADR 0011.
      const projectedPagesBefore = openReadOnly(sqlitePath, (db) =>
        Number(row(db, `SELECT count(*) AS count FROM pages`)?.count),
      )
      const rootId = openReadOnly(statePath, (db) =>
        decode({
          schema: SyncRootId,
          value: String(row(db, `SELECT root_id FROM _nds_data_source LIMIT 1`)?.root_id),
        }),
      )
      await rm(sqlitePath, { force: true })
      expect(await exists(sqlitePath)).toBe(false)
      projectReplicaFromSyncStore({ syncStorePath: statePath, replicaPath: sqlitePath, rootId })

      openReadOnly(sqlitePath, (db) => {
        // Correctness lived in the event log, not the deleted data file: the
        // rebuilt projection has the full public surface and the same pages.
        assertStorageTaxonomy(db)
        expect(Number(row(db, `SELECT count(*) AS count FROM pages`)?.count)).toBe(
          projectedPagesBefore,
        )
        // The settled edit is no longer pending after the rebuild (its intent was
        // appended to the event log and executed before the data file was deleted).
        expect(
          readPendingReplicaChanges(sqlitePath).filter((change) => change.status === 'pending'),
        ).toHaveLength(0)
      })
    },
    sqliteContractTimeoutMs,
  )

  it(
    'projection is pure: re-projecting the data file before settling neither consumes nor duplicates the un-settled CDC inbox [NDS-L2-hidden-control-plane-isolation]',
    async () => {
      const workspace = await tempWorkspace()
      const { sqlitePath, statePath } = await establishWorkspace(workspace)

      updatePublicRowsTitle({ sqlitePath, title: 'Idempotent drain' })
      const pending = readPendingReplicaChanges(sqlitePath)
      expect(pending).toHaveLength(1)

      const rootId = openReadOnly(statePath, (db) =>
        decode({
          schema: SyncRootId,
          value: String(row(db, `SELECT root_id FROM _nds_data_source LIMIT 1`)?.root_id),
        }),
      )

      // Re-projecting the data file (a pure read-model rebuild — the projector
      // opens the control-plane store read-only) must NOT consume or duplicate
      // the un-settled CDC inbox: the same edit stays pending, and re-reading it
      // yields the same single change id (no duplication). ADR 0011.
      projectReplicaFromSyncStore({ syncStorePath: statePath, replicaPath: sqlitePath, rootId })
      projectReplicaFromSyncStore({ syncStorePath: statePath, replicaPath: sqlitePath, rootId })

      const pendingAgain = readPendingReplicaChanges(sqlitePath)
      expect(pendingAgain).toHaveLength(1)
      expect(pendingAgain[0]?.changeId).toBe(pending[0]?.changeId)
    },
    sqliteContractTimeoutMs,
  )

  it(
    'does not double-apply across the boundary: a second sync after the CDC edit settled produces no further remote write [NDS-L2-hidden-control-plane-isolation]',
    async () => {
      const workspace = await tempWorkspace()
      // CDC edit -> remote settle: adopt as `shared` (a `remote` mirror blocks it).
      const { sqlitePath } = await establishWorkspace(workspace, { authorityMode: 'shared' })

      updatePublicRowsTitle({ sqlitePath, title: 'Applied once across the boundary' })
      expect(readPendingReplicaChanges(sqlitePath)).toHaveLength(1)

      // First sync: drains the data-file CDC, appends the intent to the state
      // event log (idempotency-keyed by `replica:<change_id>`), executes it, and
      // settles — exactly one remote write, CDC inbox cleared.
      const firstGateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })
      await runWorkspaceCommand({
        argv: [
          'sync',
          '--watch',
          '--sqlite',
          sqlitePath,
          '--state',
          join(workspace, 'watch.json'),
          '--max-cycles',
          '1',
          '--no-materialize-bodies',
        ],
        gateway: firstGateway,
      })
      expect(firstGateway.ledger.successfulPatchPageProperties).toHaveLength(1)
      expect(
        readPendingReplicaChanges(sqlitePath).filter((change) => change.status === 'pending'),
      ).toHaveLength(0)

      // Second sync against a FRESH gateway: the settled CDC must not re-drain.
      // Zero remote writes is the direct proof that crossing the file boundary
      // does not double-apply the user's edit. ADR 0011.
      const secondGateway = makeFakeGatewayHarness({
        propertyPages: [propertyPage('Initial task')],
      })
      await runWorkspaceCommand({
        argv: [
          'sync',
          '--watch',
          '--sqlite',
          sqlitePath,
          '--state',
          join(workspace, 'watch.json'),
          '--max-cycles',
          '1',
          '--no-materialize-bodies',
        ],
        gateway: secondGateway,
      })
      expect(secondGateway.ledger.successfulPatchPageProperties).toHaveLength(0)
      expect(
        readPendingReplicaChanges(sqlitePath).filter((change) => change.status === 'pending'),
      ).toHaveLength(0)
    },
    sqliteContractTimeoutMs,
  )
})
