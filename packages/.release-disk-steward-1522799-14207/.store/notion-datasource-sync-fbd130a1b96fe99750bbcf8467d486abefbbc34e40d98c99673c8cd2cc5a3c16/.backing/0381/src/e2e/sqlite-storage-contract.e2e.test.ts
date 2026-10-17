import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect, Option, Schema } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  parseCliCommand,
  parseCliContext,
  resolveCliCommandNotionRefs,
  runCliCommandWithRuntime,
} from '../cli/main.ts'
import { PagePropertyItemPage } from '../core/commands.ts'
import {
  AbsolutePath,
  DatabaseId,
  DataSourceId,
  PropertyId,
  PropertyName,
  type AbsolutePath as AbsolutePathType,
  type DataSourceSnapshot,
} from '../core/domain.ts'
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
import { openNotionSyncStore } from '../store/store.ts'
import {
  decode,
  fixedObservedAt,
  hash,
  makeFakeGatewayHarness,
  pageSnapshot,
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

// Control-plane store (decision 0020): the binding, event log, and all `_nds_*`
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
// public data file post control-plane split (DD-A, decision 0020). The public data
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
  // DD-A (decision 0020): the control-plane binding moved to state.sqlite; it must
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
// public views; standalone-queryable with no ATTACH (DD-A, decision 0020).
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

      // The control-plane store splits out of the data file (decision 0020): the
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
    'tracks a second data source into the same workspace, keeping one binding row per source in the shared state store',
    async () => {
      const workspace = await tempWorkspace()

      // First source: the default harness data source ("Rows" / database-1).
      await establishWorkspace(workspace)

      // Second source: a distinct data source / database tracked into the SAME
      // workspace. The VRS multi-source workspace shares one
      // `.notion/v1/state.sqlite` across every tracked source, so this must be
      // allowed — the establish guard only refuses a control-plane store bound to
      // a DIFFERENT workspace root, not the addition of a new source.
      const secondDatabaseId = decode({ schema: DatabaseId, value: 'database-2' })
      const secondDataSourceId = decode({ schema: DataSourceId, value: 'data-source-2' })
      const secondDatabaseUrl =
        'https://www.notion.so/example/89abcdef0123456789abcdef01234567?v=feedfacefeedfacefeedfacefeedface'
      const secondSnapshot: DataSourceSnapshot = {
        _tag: 'DataSourceSnapshot',
        dataSourceId: secondDataSourceId,
        parentDatabaseId: secondDatabaseId,
        requestId: testIds.requestId,
        observedAt: decode({ schema: Schema.DateTimeUtcFromString, value: fixedObservedAt }),
        schemaHash: hash('schema-2'),
        schemaProperties: [
          {
            _tag: 'DataSourcePropertySnapshot',
            propertyId: testIds.propertyA,
            name: decode({ schema: PropertyName, value: 'Title' }),
            type: 'title',
            configHash: hash('property-2-config'),
            writeClass: 'writable',
            ordinal: 0,
            configJson: JSON.stringify({ type: 'title' }),
          },
        ],
        metadataHash: hash('metadata-2'),
        metadataJson: JSON.stringify({
          _tag: 'CanonicalDataSourceMetadata',
          titlePlainText: 'Second source',
          descriptionPlainText: 'Second tracked data source',
          icon: { _tag: 'none' },
        }),
        metadataTitlePlainText: 'Second source',
        metadataDescriptionPlainText: 'Second tracked data source',
      }
      const secondGateway = makeFakeGatewayHarness({ dataSource: secondSnapshot })
      const secondResolver: NotionGatewayClient = {
        retrieveDataSource: () => Effect.succeed({ id: secondDataSourceId, properties: {} }),
        queryDataSource: () =>
          Effect.succeed({ results: [], nextCursor: Option.none(), hasMore: false }),
        retrievePage: () =>
          Effect.succeed({
            id: testIds.pageId,
            parent: { type: 'data_source_id', data_source_id: secondDataSourceId },
            properties: {},
            last_edited_time: fixedObservedAt,
            in_trash: false,
          }),
        retrievePageProperty: () =>
          Effect.succeed({ results: [], nextCursor: Option.none(), hasMore: false }),
        retrieveDatabase: () =>
          Effect.succeed({
            id: secondDatabaseId,
            title: [],
            description: [],
            icon: null,
            data_sources: [{ id: secondDataSourceId, name: 'Second' }],
          }),
        updatePage: () =>
          Effect.succeed({
            id: testIds.pageId,
            parent: { type: 'data_source_id', data_source_id: secondDataSourceId },
            properties: {},
            last_edited_time: fixedObservedAt,
            in_trash: false,
          }),
        createPage: () =>
          Effect.succeed({
            id: 'created-page',
            parent: { type: 'data_source_id', data_source_id: secondDataSourceId },
            properties: {},
            last_edited_time: fixedObservedAt,
            in_trash: false,
          }),
        updateDataSource: () => Effect.succeed({ id: secondDataSourceId, properties: {} }),
        updateDatabase: () =>
          Effect.succeed({ id: secondDatabaseId, title: [], description: [], icon: null }),
      }
      const secondArgv = [
        'track',
        secondDatabaseUrl,
        workspace,
        '--mode',
        'remote',
        '--no-materialize-bodies',
      ] as readonly string[]
      const secondCommand = await Effect.runPromise(
        resolveCliCommandNotionRefs({
          command: parseCliCommand(secondArgv),
          options: { gatewayClient: secondResolver },
        }),
      )
      const secondContext = parseCliContext({ argv: secondArgv, resolvedCommand: secondCommand })
      try {
        // The establish guard must NOT throw here — it would have, pre-fix, with
        // "Control-plane store is already bound to data source ...".
        await Effect.runPromise(
          runCliCommandWithRuntime({
            command: secondCommand,
            context: secondContext,
            options: { gateway: secondGateway.gateway, gatewayClient: secondResolver },
          }),
        )
      } finally {
        secondContext.store.close()
      }

      // The manifest tracks both sources; the shared state store holds one
      // binding row per source (keyed by the derived `data-source:<id>` root id).
      const manifestResult = loadWorkspaceManifest(workspace)
      expect(manifestResult._tag).toBe('tracked')
      if (manifestResult._tag === 'tracked') {
        expect(manifestResult.manifest.data_sources.map((source) => source.data_source_id)).toEqual(
          expect.arrayContaining([testIds.dataSourceId, secondDataSourceId]),
        )
      }
      openReadOnly(statePathForWorkspace(workspace), (db) => {
        const bindings = rows(
          db,
          `SELECT root_id, data_source_id, workspace_root
           FROM _nds_workspace_binding
           ORDER BY data_source_id`,
        )
        expect(bindings).toEqual([
          {
            root_id: `data-source:${testIds.dataSourceId}`,
            data_source_id: testIds.dataSourceId,
            workspace_root: workspace,
          },
          {
            root_id: `data-source:${secondDataSourceId}`,
            data_source_id: secondDataSourceId,
            workspace_root: workspace,
          },
        ])
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
        // DD-A (decision 0020): the control-plane binding is not in the data file at
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
      // shared (push-capable): this drains+settles an outbound row_create, which a
      // `remote`-mirror workspace forbids under SM5.4 (CLI-R07 / the loop-level
      // mirror gate). The default `remote` mode would gate this push off.
      const { sqlitePath } = await establishWorkspace(workspace, { authorityMode: 'shared' })
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

      // DD-B (decision 0020): the control-plane tables that feed sync_status moved to
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
            }).pipe(Effect.andThen(baseGateway.gateway.patchPageProperties(command))),
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
      // shared (push-capable): this drains+settles an outbound row_archive, which a
      // `remote`-mirror workspace forbids under SM5.4 (CLI-R07 / the loop-level
      // mirror gate). The default `remote` mode would gate this push off.
      const { sqlitePath } = await establishWorkspace(workspace, { authorityMode: 'shared' })
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
        // F8 (#775 M2a'): the archive settle converges `_nds_row.in_trash = 1` from
        // the SETTLED LOCAL intent (not from disappearance classification, which is
        // gated off on the watch INCREMENTAL scan), so `pages._in_trash` stays 1 even
        // though the faithful fake drops the trashed row from `data_source.query`.
        expect(
          row(readDb, `SELECT _in_trash FROM pages WHERE _page_id = ?`, testIds.pageId),
        ).toMatchObject({ _in_trash: 1 })
      })
    },
    sqliteContractTimeoutMs,
  )

  // F8 (decisions 0022/0023): the FULL archive -> restore round trip. A local archive
  // pushes a remote trash; the trashed row then VANISHES from `data_source.query`
  // (the fake now models real Notion — `queryRows` excludes trashed rows). On the
  // next full-scan re-observe the row is absent, gets directly reclassified as
  // `remote_trash`, and the F8 store handler keeps `_nds_row.in_trash = 1` so the
  // reprojection preserves the trashed state (without F8 it would reproject to 0,
  // since `RowObserved` last wrote 0 and a trash settle never touches `_nds_row`).
  // That keeps the row RESTORABLE: a local `_in_trash 1->0` edit can then emit a
  // `row_restore` CDC change and push a remote restore. Each `sync` invocation is a
  // fresh full scan (null high-watermark), which is what makes the disappearance
  // classifier run — the watch daemon's incremental high-watermark would skip it.
  it(
    'archives then restores a row round-trip: remote trash drops from query, F8 keeps it restorable',
    async () => {
      const workspace = await tempWorkspace()
      const { sqlitePath } = await establishWorkspace(workspace, { authorityMode: 'shared' })
      const statePath = statePathForWorkspace(workspace)
      // ONE shared fake gateway across every sync: the fake holds page trash state
      // in a closure, so the remote trash from the archive push persists into the
      // re-observe and the restore.
      const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })
      const syncOnce = () =>
        runWorkspaceCommand({
          argv: ['sync', '--sqlite', sqlitePath, '--no-materialize-bodies'],
          gateway,
        })

      // 1. Local archive: `_in_trash 0->1` queues a `row_archive` CDC change.
      const archiveDb = new DatabaseSync(sqlitePath)
      try {
        archiveDb.prepare(`UPDATE pages SET _in_trash = 1 WHERE _page_id = ?`).run(testIds.pageId)
      } finally {
        archiveDb.close()
      }

      // 2. First sync: plans + executes the archive push (the fake's pull happens
      // BEFORE the push within this cycle, so the row is still visible here).
      await syncOnce()
      expect(gateway.ledger.successfulTrashPages).toHaveLength(1)

      // 3. Second sync: a fresh full scan. The trashed row is now EXCLUDED from
      // `queryRows`, so the disappearance classifier retrieves it directly, sees
      // `inTrash`, records a `remote_trash` tombstone, and F8 keeps the row at
      // `_in_trash = 1` through the reprojection.
      await syncOnce()

      // The load-bearing oracle: the remote-trash tombstone actually landed (proves
      // the disappearance->classify path ran, not that `_in_trash` is coincidentally 1).
      openReadOnly(statePath, (stateDb) => {
        expect(
          row(
            stateDb,
            `SELECT classification, reason FROM _nds_tombstone WHERE page_id = ?`,
            testIds.pageId,
          ),
        ).toMatchObject({ classification: 'remote_trash', reason: 'remote_trash' })
      })
      // The row stays present AND trashed (restorable), not dropped or reset to 0.
      openReadOnly(sqlitePath, (readDb) => {
        expect(
          row(readDb, `SELECT _in_trash FROM pages WHERE _page_id = ?`, testIds.pageId),
        ).toMatchObject({ _in_trash: 1 })
      })

      // 4. Local restore: the now-restorable row takes a `_in_trash 1->0` edit,
      // queuing a `row_restore` CDC change.
      const restoreDb = new DatabaseSync(sqlitePath)
      try {
        restoreDb.prepare(`UPDATE pages SET _in_trash = 0 WHERE _page_id = ?`).run(testIds.pageId)
      } finally {
        restoreDb.close()
      }

      // 5. Third sync: the restore is planned (the genuine remote-trash row is NOT
      // moved-out, so the symmetric restore guard lets it through) and executed,
      // pushing a remote restore. This is the F8 contract endpoint: the row was
      // RESTORABLE (an expressible `_in_trash 1->0` transition) and the restore
      // reaches Notion.
      await syncOnce()

      expect(gateway.ledger.successfulRestorePages).toHaveLength(1)
      openReadOnly(sqlitePath, (readDb) => {
        expect(
          rows(
            readDb,
            `SELECT kind, status
             FROM changes
             WHERE kind IN ('row_archive', 'row_restore') AND page_id = ?
             ORDER BY created_at, change_id`,
            testIds.pageId,
          ),
        ).toEqual([
          expect.objectContaining({ kind: 'row_archive', status: 'applied' }),
          expect.objectContaining({ kind: 'row_restore', status: 'applied' }),
        ])
      })
      // F8 (#775 M2a'): the settled restore converges `_nds_row.in_trash = 0` from
      // the SETTLED LOCAL intent. This fixes the post-restore staleness bug — a
      // byte-identical `RowObserved` is deduped, so without the settle-driven
      // convergence `_in_trash` would stay 1 forever.
      openReadOnly(sqlitePath, (readDb) => {
        expect(
          row(readDb, `SELECT _in_trash FROM pages WHERE _page_id = ?`, testIds.pageId),
        ).toMatchObject({ _in_trash: 0 })
      })
      // The settle also CLEARS the stale `remote_trash` tombstone, so reprojection
      // and status no longer treat the now-active row as trashed.
      openReadOnly(statePath, (stateDb) => {
        expect(
          row(
            stateDb,
            `SELECT classification, reason FROM _nds_tombstone WHERE page_id = ?`,
            testIds.pageId,
          ),
        ).toBeUndefined()
      })
    },
    sqliteContractTimeoutMs,
  )

  // F8 (#775 M2a'): the LOCAL archive -> restore round trip on the WATCH path. The
  // watch incremental scan never records a `remote_trash` tombstone (disappearance
  // classification is gated off on incremental scans), so `in_trash` is converged
  // purely from the SETTLED LOCAL intent — archive settle -> `_in_trash = 1`,
  // restore settle -> `_in_trash = 0`. This is the watch-path gap that previously
  // had no coverage: before M2a' a local archive on `sync --watch` left `_in_trash`
  // at 0 (a stable divergence — local active while remote trashed).
  it(
    'archives then restores a row round-trip on watch: settled local intent converges _in_trash',
    async () => {
      const workspace = await tempWorkspace()
      const { sqlitePath } = await establishWorkspace(workspace, { authorityMode: 'shared' })
      // `watch.json` is the watch daemon's incremental cursor (the `--state` flag);
      // the control-plane store (tombstones, event log) lives at `statePathForWorkspace`.
      const watchStatePath = join(workspace, 'watch.json')
      const controlPlanePath = statePathForWorkspace(workspace)
      // ONE shared fake gateway across both watch invocations: it holds page trash
      // state in a closure, so the remote trash from the archive push persists into
      // the restore run.
      const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })
      const watchOnce = () =>
        runWorkspaceCommand({
          argv: [
            'sync',
            '--watch',
            '--sqlite',
            sqlitePath,
            '--state',
            watchStatePath,
            '--max-cycles',
            '1',
            '--no-materialize-bodies',
          ],
          gateway,
        })

      // 1. Local archive on watch: `_in_trash 0->1` queues a `row_archive`, the watch
      // cycle drains+settles it, and the settled intent converges `_in_trash = 1`.
      const archiveDb = new DatabaseSync(sqlitePath)
      try {
        archiveDb.prepare(`UPDATE pages SET _in_trash = 1 WHERE _page_id = ?`).run(testIds.pageId)
      } finally {
        archiveDb.close()
      }
      await watchOnce()
      expect(gateway.ledger.successfulTrashPages).toHaveLength(1)
      openReadOnly(sqlitePath, (readDb) => {
        expect(
          row(readDb, `SELECT _in_trash FROM pages WHERE _page_id = ?`, testIds.pageId),
        ).toMatchObject({ _in_trash: 1 })
      })
      // No `remote_trash` tombstone is recorded on the incremental watch scan — the
      // convergence is driven entirely by the settled intent, not classification.
      openReadOnly(controlPlanePath, (stateDb) => {
        expect(
          row(
            stateDb,
            `SELECT classification, reason FROM _nds_tombstone WHERE page_id = ?`,
            testIds.pageId,
          ),
        ).toBeUndefined()
      })

      // 2. Local restore on watch: `_in_trash 1->0` queues a `row_restore`, the next
      // watch cycle drains+settles it, and the settled intent converges `_in_trash = 0`.
      const restoreDb = new DatabaseSync(sqlitePath)
      try {
        restoreDb.prepare(`UPDATE pages SET _in_trash = 0 WHERE _page_id = ?`).run(testIds.pageId)
      } finally {
        restoreDb.close()
      }
      await watchOnce()
      expect(gateway.ledger.successfulRestorePages).toHaveLength(1)
      openReadOnly(sqlitePath, (readDb) => {
        expect(
          row(readDb, `SELECT _in_trash FROM pages WHERE _page_id = ?`, testIds.pageId),
        ).toMatchObject({ _in_trash: 0 })
      })
    },
    sqliteContractTimeoutMs,
  )

  // SM5.4 (CLI-R07): the mirror guarantee is uniform across one-shot AND watch.
  // A `remote`-mode workspace must never push local lifecycle/create intents — the
  // pull-only gate now lives inside `syncOneShot`, so even the ONE-SHOT `sync`
  // (not `--watch`) path is gated. This closes the hole the planner's per-property
  // `RemoteAuthoritativeDrift` block never covered: `planLifecycle`/`planRowCreate`
  // carry no remote-mode guard, so before this gate a one-shot remote `sync` would
  // enqueue + execute a pending archive (`_in_trash=1`) and a row_create to Notion.
  it(
    'one-shot sync on a remote-mode workspace pushes no local lifecycle/create writes to Notion',
    async () => {
      const workspace = await tempWorkspace()
      // Default `remote` (mirror) adoption — the mode under test.
      const { sqlitePath } = await establishWorkspace(workspace)
      // Stage BOTH a pending archive (lifecycle) AND a pending row_create — the two
      // intent kinds the planner's property-write block does not cover.
      const db = new DatabaseSync(sqlitePath)
      try {
        db.prepare(`UPDATE pages SET _in_trash = 1 WHERE _page_id = ?`).run(testIds.pageId)
      } finally {
        db.close()
      }
      insertPublicRowsCreate({
        sqlitePath,
        title: 'Created on a remote-mode workspace',
        clientRequestKey: 'remote-one-shot-create',
      })

      const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })
      // ONE-SHOT `sync` (NOT `--watch`): exercises the `syncOneShot` mirror gate.
      await runWorkspaceCommand({
        argv: ['sync', '--sqlite', sqlitePath, '--no-materialize-bodies'],
        gateway,
      })

      // The hard oracle: the gateway is NEVER asked to mutate — no lifecycle or
      // create write leaks to Notion under remote authority.
      expect(gateway.writeCalls()).toBe(0)
      expect(gateway.ledger.successfulTrashPages).toHaveLength(0)
      expectNoRemoteWrites(gateway)

      // The local edits are not lost: they survive as PENDING CDC changes in the
      // public data file (the status/drift surface), never settled to `applied` by a
      // push that never ran. This is the "follow remote, surface local as status"
      // guarantee for the one-shot path.
      openReadOnly(sqlitePath, (readDb) => {
        expect(
          rows(
            readDb,
            `SELECT kind, status FROM changes WHERE page_id = ? OR kind = 'row_create' ORDER BY created_at`,
            testIds.pageId,
          ),
        ).toEqual([
          { kind: 'row_archive', status: 'pending' },
          { kind: 'row_create', status: 'pending' },
        ])
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
      // files (decision 0020): control-plane tables in the state store, public views
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
      // A backup of just the public data file: the control plane (decision 0020)
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
      // control-plane tables (DD-A, decision 0020). Standalone-queryable (no ATTACH).
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
      // event log, not the data file). decision 0020.
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
      // yields the same single change id (no duplication). decision 0020.
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
      // does not double-apply the user's edit. decision 0020.
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

  // Decision 0018: lifecycle divergence (remote restore after a SETTLED local
  // archive) is a first-class CONFLICT, not a silent last-writer-wins flip
  // (XC-R02). These exercise the full CDC path through the public `pages` table.
  //
  // The "someone independently restored the page in Notion" half is modeled by a
  // FRESH gateway whose page defaults to active (`inTrash: false`): after the
  // first gateway settles the archive (the trashed row drops out of its query),
  // a second sync against the fresh gateway observes the row ACTIVE — exactly the
  // post-settlement remote restore the ADR motivates.
  describe('lifecycle divergence is a conflict (decision 0026)', () => {
    /** Drive a local archive to settlement, then return the sqlite/state paths. */
    const settleLocalArchive = async (workspace: AbsolutePathType) => {
      const { sqlitePath, statePath } = await establishWorkspace(workspace, {
        authorityMode: 'shared',
      })
      const archiveDb = new DatabaseSync(sqlitePath)
      try {
        archiveDb.prepare(`UPDATE pages SET _in_trash = 1 WHERE _page_id = ?`).run(testIds.pageId)
      } finally {
        archiveDb.close()
      }
      // Archive gateway: settles the trash push (the row then drops from query).
      const archiveGateway = makeFakeGatewayHarness({
        propertyPages: [propertyPage('Initial task')],
      })
      await runWorkspaceCommand({
        argv: ['sync', '--sqlite', sqlitePath, '--no-materialize-bodies'],
        gateway: archiveGateway,
      })
      expect(archiveGateway.ledger.successfulTrashPages).toHaveLength(1)
      return { sqlitePath, statePath }
    }

    /** Read the single open conflict row from the control-plane store. */
    const openConflict = (statePath: string): SqlRow | undefined =>
      openReadOnly(statePath, (stateDb) =>
        row(
          stateDb,
          `SELECT conflict_id, page_id, state FROM _nds_conflict WHERE state = 'open' AND page_id = ?`,
          testIds.pageId,
        ),
      )

    it(
      'raises ONE open lifecycle conflict on remote restore after settled archive; _in_trash stays 1, no silent flip',
      async () => {
        const workspace = await tempWorkspace()
        const { sqlitePath, statePath } = await settleLocalArchive(workspace)

        // Remote restore (fresh gateway, page active) → RowObserved(R=0) while the
        // settled local target L=1. Detection raises a lifecycle conflict BEFORE
        // the RowObserved applies, and the projection freezes `_in_trash` at 1.
        // A DISTINCT row propertiesHash gives the restore RowObserved a novel
        // event_id that is NOT deduped against the earlier active observation, so it
        // actually APPLIES in this sync — exercising the in_trash freeze (detection
        // appends the ConflictRaised first in the loop, at a LOWER sequence). With a
        // byte-identical observation the RowObserved would dedupe and the freeze
        // would never fire (the row would stay 1 only via the F8 settle handler).
        const restoreGateway = makeFakeGatewayHarness({
          pages: [pageSnapshot({ propertiesHash: hash('properties-after-remote-restore') })],
          propertyPages: [propertyPage('Restored remotely')],
        })
        await runWorkspaceCommand({
          argv: ['sync', '--sqlite', sqlitePath, '--no-materialize-bodies'],
          gateway: restoreGateway,
        })

        // Exactly one open lifecycle conflict; no silent in_trash flip.
        openReadOnly(statePath, (stateDb) => {
          expect(
            rows(
              stateDb,
              `SELECT page_id FROM _nds_conflict WHERE state = 'open' AND page_id = ?`,
              testIds.pageId,
            ),
          ).toHaveLength(1)
          // The opened event carries conflictKind 'lifecycle' and remoteInTrash.
          expect(
            row(
              stateDb,
              `SELECT guard FROM _nds_guard_block WHERE guard = 'PendingIntentShadowViolation'`,
            ),
          ).toMatchObject({ guard: 'PendingIntentShadowViolation' })

          // Determinism invariant: the ConflictRaised sits at a LOWER sequence than
          // the restore RowObserved it gates, so on full-log replay the freeze is
          // already in effect when the RowObserved applies. (A novel propertiesHash
          // ensures the restore RowObserved is not deduped against the active one.)
          const conflictSeq = row(
            stateDb,
            `SELECT sequence FROM _nds_sync_event WHERE event_type = 'ConflictRaised' ORDER BY sequence DESC LIMIT 1`,
          )?.sequence
          const restoreRowSeq = row(
            stateDb,
            `SELECT MAX(sequence) AS sequence FROM _nds_sync_event WHERE event_type = 'RowObserved'`,
          )?.sequence
          expect(Number(conflictSeq)).toBeLessThan(Number(restoreRowSeq))
          // The freeze is COLUMN-SCOPED: the row's non-lifecycle columns DID converge
          // to the new remote observation (observed_event_id advanced to the novel
          // restore RowObserved), proving the RowObserved applied and was not deduped
          // — yet in_trash was preserved.
          expect(
            row(stateDb, `SELECT in_trash FROM _nds_row WHERE page_id = ?`, testIds.pageId),
          ).toMatchObject({ in_trash: 1 })
          expect(
            row(stateDb, `SELECT observed_event_id FROM _nds_row WHERE page_id = ?`, testIds.pageId)
              ?.observed_event_id,
          ).toBe(
            row(
              stateDb,
              `SELECT event_id FROM _nds_sync_event WHERE event_type = 'RowObserved' ORDER BY sequence DESC LIMIT 1`,
            )?.event_id,
          )
        })
        openReadOnly(sqlitePath, (readDb) => {
          // Public in_trash is frozen at the settled local target (1), no silent flip.
          expect(
            row(readDb, `SELECT _in_trash FROM pages WHERE _page_id = ?`, testIds.pageId),
          ).toMatchObject({ _in_trash: 1 })
        })
      },
      sqliteContractTimeoutMs,
    )

    it(
      'keep-remote resolves the lifecycle conflict, flips _in_trash to 0, and clears the remote_trash tombstone',
      async () => {
        const workspace = await tempWorkspace()
        const { sqlitePath, statePath } = await settleLocalArchive(workspace)

        // A DISTINCT row propertiesHash gives the restore RowObserved a novel
        // event_id that is NOT deduped against the earlier active observation, so it
        // actually APPLIES in this sync — exercising the in_trash freeze (detection
        // appends the ConflictRaised first in the loop, at a LOWER sequence). With a
        // byte-identical observation the RowObserved would dedupe and the freeze
        // would never fire (the row would stay 1 only via the F8 settle handler).
        const restoreGateway = makeFakeGatewayHarness({
          pages: [pageSnapshot({ propertiesHash: hash('properties-after-remote-restore') })],
          propertyPages: [propertyPage('Restored remotely')],
        })
        await runWorkspaceCommand({
          argv: ['sync', '--sqlite', sqlitePath, '--no-materialize-bodies'],
          gateway: restoreGateway,
        })
        const conflict = openConflict(statePath)
        expect(conflict).toBeDefined()
        const conflictId = String(conflict?.conflict_id)

        // keep-remote: adopt the remote active target.
        await runWorkspaceCommand({
          argv: [
            'conflicts',
            'resolve',
            '--sqlite',
            sqlitePath,
            '--conflict-id',
            conflictId,
            '--strategy',
            'keep-remote',
          ],
        })

        // Conflict resolved; public _in_trash now follows remote (0).
        openReadOnly(statePath, (stateDb) => {
          expect(
            row(stateDb, `SELECT state FROM _nds_conflict WHERE conflict_id = ?`, conflictId),
          ).toMatchObject({ state: 'resolved' })
        })
        openReadOnly(sqlitePath, (readDb) => {
          expect(
            row(readDb, `SELECT _in_trash FROM pages WHERE _page_id = ?`, testIds.pageId),
          ).toMatchObject({ _in_trash: 0 })
        })
      },
      sqliteContractTimeoutMs,
    )

    it(
      'keep-local resolves the lifecycle conflict, re-enqueues a Trash push, and keeps _in_trash at 1',
      async () => {
        const workspace = await tempWorkspace()
        const { sqlitePath, statePath } = await settleLocalArchive(workspace)

        // A DISTINCT row propertiesHash gives the restore RowObserved a novel
        // event_id that is NOT deduped against the earlier active observation, so it
        // actually APPLIES in this sync — exercising the in_trash freeze (detection
        // appends the ConflictRaised first in the loop, at a LOWER sequence). With a
        // byte-identical observation the RowObserved would dedupe and the freeze
        // would never fire (the row would stay 1 only via the F8 settle handler).
        const restoreGateway = makeFakeGatewayHarness({
          pages: [pageSnapshot({ propertiesHash: hash('properties-after-remote-restore') })],
          propertyPages: [propertyPage('Restored remotely')],
        })
        await runWorkspaceCommand({
          argv: ['sync', '--sqlite', sqlitePath, '--no-materialize-bodies'],
          gateway: restoreGateway,
        })
        const conflictId = String(openConflict(statePath)?.conflict_id)

        // keep-local: re-assert the local archive (L=1) via a fresh TrashPage push.
        // The CLI keep-local choice carries a property `value` (`--value-json`)
        // shared with property conflicts; the lifecycle resolver ignores it and
        // derives the target from `L = !remoteInTrash`, so a placeholder is passed.
        await runWorkspaceCommand({
          argv: [
            'conflicts',
            'resolve',
            '--sqlite',
            sqlitePath,
            '--conflict-id',
            conflictId,
            '--strategy',
            'keep-local',
            '--value-json',
            JSON.stringify({ _tag: 'title', plainText: 'ignored' }),
          ],
        })

        // The re-asserted trash command lands in the outbox, and the conflict moves
        // to `resolving` (#775 M2a'-2): keep-local does NOT fully resolve — the
        // conflict stays freeze-active until the re-assert genuinely settles, so
        // the freeze still holds `_in_trash` at the local target.
        openReadOnly(statePath, (stateDb) => {
          expect(
            row(stateDb, `SELECT state FROM _nds_conflict WHERE conflict_id = ?`, conflictId),
          ).toMatchObject({ state: 'resolving' })
          expect(
            rows(
              stateDb,
              `SELECT command_tag FROM _nds_outbox WHERE command_tag = 'TrashPage' AND surface = ?`,
              `page:${testIds.pageId}`,
            ).length,
          ).toBeGreaterThanOrEqual(1)
        })
        openReadOnly(sqlitePath, (readDb) => {
          expect(
            row(readDb, `SELECT _in_trash FROM pages WHERE _page_id = ?`, testIds.pageId),
          ).toMatchObject({ _in_trash: 1 })
        })
      },
      sqliteContractTimeoutMs,
    )

    it(
      'BENIGN: no settled lifecycle intent + RowObserved raises NO conflict and in_trash follows remote (false-positive guard)',
      async () => {
        const workspace = await tempWorkspace()
        // No local archive/restore: the only lifecycle source is the remote
        // observation. `readSettledLifecycleTarget` returns undefined → benign.
        const { sqlitePath, statePath } = await establishWorkspace(workspace, {
          authorityMode: 'shared',
        })
        const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })
        await runWorkspaceCommand({
          argv: ['sync', '--sqlite', sqlitePath, '--no-materialize-bodies'],
          gateway,
        })

        // NO conflict, NO shadow guard: a benign remote observation must never
        // manufacture a false-positive lifecycle conflict.
        openReadOnly(statePath, (stateDb) => {
          expect(
            rows(
              stateDb,
              `SELECT conflict_id FROM _nds_conflict WHERE page_id = ?`,
              testIds.pageId,
            ),
          ).toEqual([])
          expect(
            rows(
              stateDb,
              `SELECT guard FROM _nds_guard_block WHERE guard = 'PendingIntentShadowViolation'`,
            ),
          ).toEqual([])
        })
        // in_trash follows the remote active state.
        openReadOnly(sqlitePath, (readDb) => {
          expect(
            row(readDb, `SELECT _in_trash FROM pages WHERE _page_id = ?`, testIds.pageId),
          ).toMatchObject({ _in_trash: 0 })
        })
      },
      sqliteContractTimeoutMs,
    )

    it(
      'REPLAY determinism: rebuilding projections twice yields identical _nds_conflict and _nds_row.in_trash',
      async () => {
        const workspace = await tempWorkspace()
        const { sqlitePath, statePath } = await settleLocalArchive(workspace)
        // A DISTINCT row propertiesHash gives the restore RowObserved a novel
        // event_id that is NOT deduped against the earlier active observation, so it
        // actually APPLIES in this sync — exercising the in_trash freeze (detection
        // appends the ConflictRaised first in the loop, at a LOWER sequence). With a
        // byte-identical observation the RowObserved would dedupe and the freeze
        // would never fire (the row would stay 1 only via the F8 settle handler).
        const restoreGateway = makeFakeGatewayHarness({
          pages: [pageSnapshot({ propertiesHash: hash('properties-after-remote-restore') })],
          propertyPages: [propertyPage('Restored remotely')],
        })
        await runWorkspaceCommand({
          argv: ['sync', '--sqlite', sqlitePath, '--no-materialize-bodies'],
          gateway: restoreGateway,
        })

        // Snapshot the conflict + in_trash projection.
        const snapshotState = () =>
          openReadOnly(statePath, (stateDb) => ({
            conflicts: rows(
              stateDb,
              `SELECT conflict_id, page_id, state FROM _nds_conflict ORDER BY conflict_id`,
            ),
            inTrash: row(
              stateDb,
              `SELECT in_trash FROM _nds_row WHERE page_id = ?`,
              testIds.pageId,
            ),
          }))

        const before = snapshotState()
        expect(before.conflicts).toHaveLength(1)
        expect(before.inTrash).toMatchObject({ in_trash: 1 })

        const rootId = decode({
          schema: SyncRootId,
          value: String(
            openReadOnly(statePath, (stateDb) =>
              row(stateDb, `SELECT root_id FROM _nds_data_source LIMIT 1`),
            )?.root_id,
          ),
        })

        // Rebuild projections from the persisted event log twice; the ConflictRaised
        // sits at a LOWER sequence than the RowObserved, so the freeze is replayed
        // deterministically without any L recomputation in the apply path.
        const rebuild = () => {
          const store = openNotionSyncStore({ path: statePath, busyTimeoutMs: 2_500 })
          try {
            store.rebuildProjections(rootId)
          } finally {
            store.close()
          }
        }
        rebuild()
        const afterFirst = snapshotState()
        rebuild()
        const afterSecond = snapshotState()

        expect(afterFirst).toEqual(before)
        expect(afterSecond).toEqual(before)
      },
      sqliteContractTimeoutMs,
    )

    /** Read the single `resolving` conflict row from the control-plane store. */
    const resolvingConflict = (statePath: string): SqlRow | undefined =>
      openReadOnly(statePath, (stateDb) =>
        row(
          stateDb,
          `SELECT conflict_id, page_id, state FROM _nds_conflict WHERE state = 'resolving' AND page_id = ?`,
          testIds.pageId,
        ),
      )

    /**
     * Drive a lifecycle conflict to a `keep-local` resolution and return the
     * sqlite/state paths plus the conflict id. The re-assert TrashPage lands in
     * the outbox; the conflict is now `resolving` (#775 M2a'-2).
     */
    const settleArchiveThenKeepLocal = async (workspace: AbsolutePathType) => {
      const { sqlitePath, statePath } = await settleLocalArchive(workspace)
      // Remote restore (page active, novel propertiesHash so the RowObserved is
      // not deduped) → lifecycle conflict.
      const restoreGateway = makeFakeGatewayHarness({
        pages: [pageSnapshot({ propertiesHash: hash('properties-after-remote-restore') })],
        propertyPages: [propertyPage('Restored remotely')],
      })
      await runWorkspaceCommand({
        argv: ['sync', '--sqlite', sqlitePath, '--no-materialize-bodies'],
        gateway: restoreGateway,
      })
      const conflictId = String(openConflict(statePath)?.conflict_id)
      // keep-local: re-assert L=1 via a fresh TrashPage push and move the conflict
      // to `resolving` (NOT `resolved`).
      await runWorkspaceCommand({
        argv: [
          'conflicts',
          'resolve',
          '--sqlite',
          sqlitePath,
          '--conflict-id',
          conflictId,
          '--strategy',
          'keep-local',
          '--value-json',
          JSON.stringify({ _tag: 'title', plainText: 'ignored' }),
        ],
      })
      return { sqlitePath, statePath, conflictId }
    }

    // THE KILL-TEST (#775 M2a'-2): keep-local moves the conflict to `resolving` and
    // re-asserts L=1, but the remote ACTIVELY DIVERGED (it restored the page), so
    // the re-assert TrashPage BLOCKS (its lifecycle base hash never matches the
    // remote propertiesHash → StaleSurfaceBase, no settle). A SECOND sync re-detects
    // the SAME R=0 vs L=1 divergence and emits a byte-identical `ConflictRaised`
    // (lifecycle hashes are `pageLifecycleHash`, independent of `propertiesHash`),
    // which dedups against the `resolving` row — conflict COUNT stays 1. Before the
    // fix the conflict was `resolved`, so the freeze gate saw no open conflict and
    // `_in_trash` silently flipped to the remote value (XC-R02). With the fix the
    // `resolving` conflict keeps the freeze active and `_in_trash` STAYS at L=1.
    it(
      'KILL-TEST: keep-local re-assert BLOCKS, second sync re-detects same divergence, dedups against resolving conflict, NO silent flip',
      async () => {
        const workspace = await tempWorkspace()
        const { sqlitePath, statePath, conflictId } = await settleArchiveThenKeepLocal(workspace)
        // keep-local moved the conflict to `resolving` (NOT `resolved`) — the seam
        // that keeps the freeze active. (With the bug this is `resolved`, the freeze
        // gate finds no conflict, and the second sync below silently flips in_trash.)
        expect(resolvingConflict(statePath)?.conflict_id).toBe(conflictId)

        // Second sync: remote still ACTIVE (R=0) with a NOVEL propertiesHash, so the
        // RowObserved applies (not deduped) and would flip in_trash without the
        // freeze. The re-assert TrashPage is drained but BLOCKS (StaleSurfaceBase),
        // so no RemoteWriteSettled fires and the conflict stays `resolving`.
        const stillActiveGateway = makeFakeGatewayHarness({
          pages: [pageSnapshot({ propertiesHash: hash('properties-second-sync-novel') })],
          propertyPages: [propertyPage('Still restored remotely')],
        })
        await runWorkspaceCommand({
          argv: ['sync', '--sqlite', sqlitePath, '--no-materialize-bodies'],
          gateway: stillActiveGateway,
        })

        openReadOnly(statePath, (stateDb) => {
          // Dedup proof: the re-detected ConflictRaised collided with the existing
          // row — still exactly ONE conflict on this page, still `resolving`.
          expect(
            rows(stateDb, `SELECT state FROM _nds_conflict WHERE page_id = ?`, testIds.pageId),
          ).toEqual([expect.objectContaining({ state: 'resolving' })])
          expect(
            row(stateDb, `SELECT state FROM _nds_conflict WHERE conflict_id = ?`, conflictId),
          ).toMatchObject({ state: 'resolving' })
          // The re-assert never settled: the keep-local re-assert TrashPage (a
          // distinct `cmd:resolve-lifecycle-*` command, NOT the earlier settled
          // archive) is `blocked` (StaleSurfaceBase: its lifecycle base hash never
          // matches the active remote propertiesHash), so no RemoteWriteSettled fires.
          expect(
            row(
              stateDb,
              `SELECT state FROM _nds_outbox WHERE command_id LIKE 'cmd:resolve-lifecycle%' AND surface = ?`,
              `page:${testIds.pageId}`,
            ),
          ).toMatchObject({ state: 'blocked' })
          // The freeze still holds the control-plane in_trash at the local target.
          expect(
            row(stateDb, `SELECT in_trash FROM _nds_row WHERE page_id = ?`, testIds.pageId),
          ).toMatchObject({ in_trash: 1 })
        })
        // The load-bearing oracle: public _in_trash STAYS 1 — no silent flip to the
        // remote value, even though the remote actively diverged twice.
        openReadOnly(sqlitePath, (readDb) => {
          expect(
            row(readDb, `SELECT _in_trash FROM pages WHERE _page_id = ?`, testIds.pageId),
          ).toMatchObject({ _in_trash: 1 })
        })
      },
      sqliteContractTimeoutMs,
    )

    // keep-local where the re-assert SETTLES: the remote re-converged to the local
    // target (the page is trashed again when the re-assert executes), so the
    // TrashPage settles as a verified-no-op, F8 reconverges in_trash, and the
    // `resolving` conflict transitions to `resolved` (#775 M2a'-2 settle seam).
    it(
      'keep-local re-assert SETTLES (remote re-trashed): conflict transitions resolving -> resolved, _in_trash == L',
      async () => {
        const workspace = await tempWorkspace()
        const { sqlitePath, statePath, conflictId } = await settleArchiveThenKeepLocal(workspace)
        // keep-local left the conflict `resolving` (freeze active) before the settle.
        expect(resolvingConflict(statePath)?.conflict_id).toBe(conflictId)

        // Second sync against a gateway whose page is ALREADY trashed: the
        // executor's direct retrievePage sees inTrash:true, so the re-assert
        // TrashPage's verification hash equals its desired hash → verified-no-op
        // settle → RemoteWriteSettled → F8 transitions the conflict to `resolved`.
        const reTrashedGateway = makeFakeGatewayHarness({
          pages: [pageSnapshot({ inTrash: true, propertiesHash: hash('properties-re-trashed') })],
          propertyPages: [propertyPage('Re-trashed remotely')],
        })
        await runWorkspaceCommand({
          argv: ['sync', '--sqlite', sqlitePath, '--no-materialize-bodies'],
          gateway: reTrashedGateway,
        })

        openReadOnly(statePath, (stateDb) => {
          expect(
            row(stateDb, `SELECT state FROM _nds_conflict WHERE conflict_id = ?`, conflictId),
          ).toMatchObject({ state: 'resolved' })
          expect(
            row(stateDb, `SELECT in_trash FROM _nds_row WHERE page_id = ?`, testIds.pageId),
          ).toMatchObject({ in_trash: 1 })
        })
        openReadOnly(sqlitePath, (readDb) => {
          expect(
            row(readDb, `SELECT _in_trash FROM pages WHERE _page_id = ?`, testIds.pageId),
          ).toMatchObject({ _in_trash: 1 })
        })
      },
      sqliteContractTimeoutMs,
    )

    // REPLAY determinism for the frozen `resolving` state: with the re-assert
    // blocked (no settle event), rebuilding from the event log twice yields the
    // SAME `resolving` conflict and frozen in_trash. This proves seam 3 is
    // event-ordered — the absence of a RemoteWriteSettled(TrashPage) is what keeps
    // the conflict `resolving` on replay.
    it(
      'REPLAY determinism: a blocked keep-local re-assert keeps the conflict resolving + in_trash frozen across double rebuild',
      async () => {
        const workspace = await tempWorkspace()
        const { sqlitePath, statePath } = await settleArchiveThenKeepLocal(workspace)
        const stillActiveGateway = makeFakeGatewayHarness({
          pages: [pageSnapshot({ propertiesHash: hash('properties-second-sync-novel') })],
          propertyPages: [propertyPage('Still restored remotely')],
        })
        await runWorkspaceCommand({
          argv: ['sync', '--sqlite', sqlitePath, '--no-materialize-bodies'],
          gateway: stillActiveGateway,
        })

        const snapshotState = () =>
          openReadOnly(statePath, (stateDb) => ({
            conflicts: rows(
              stateDb,
              `SELECT conflict_id, page_id, state FROM _nds_conflict ORDER BY conflict_id`,
            ),
            inTrash: row(
              stateDb,
              `SELECT in_trash FROM _nds_row WHERE page_id = ?`,
              testIds.pageId,
            ),
          }))

        const before = snapshotState()
        expect(before.conflicts).toEqual([expect.objectContaining({ state: 'resolving' })])
        expect(before.inTrash).toMatchObject({ in_trash: 1 })

        const rootId = decode({
          schema: SyncRootId,
          value: String(
            openReadOnly(statePath, (stateDb) =>
              row(stateDb, `SELECT root_id FROM _nds_data_source LIMIT 1`),
            )?.root_id,
          ),
        })
        const rebuild = () => {
          const store = openNotionSyncStore({ path: statePath, busyTimeoutMs: 2_500 })
          try {
            store.rebuildProjections(rootId)
          } finally {
            store.close()
          }
        }
        rebuild()
        const afterFirst = snapshotState()
        rebuild()
        const afterSecond = snapshotState()

        expect(afterFirst).toEqual(before)
        expect(afterSecond).toEqual(before)
      },
      sqliteContractTimeoutMs,
    )
  })

  // Decision 0018, the SYMMETRIC (tombstone) direction of XC-R02: a remote TRASH
  // (`R = 1`) arriving AFTER a SETTLED local RESTORE (`L = 0`) is a first-class
  // CONFLICT, not a silent flip. The remote trash does not arrive via `RowObserved`
  // (a trashed page drops out of `data_source.query`) — it arrives via the
  // disappearance->classify->`TombstoneRecorded(remote_trash)` path. Without the
  // symmetric detector + freeze the tombstone's `in_trash = 1` write would silently
  // override the settled local restore.
  describe('lifecycle divergence is a conflict — tombstone direction (decision 0026)', () => {
    /**
     * Drive a local archive THEN a local restore to settlement ON THE WATCH PATH,
     * so the SETTLED local lifecycle target is RESTORE (`L = 0`) and NO prior
     * `remote_trash` tombstone EVENT is ever recorded: the watch incremental scan
     * converges `in_trash` purely from the settled intent, never from disappearance
     * classification (the ADR's watch-path property). This keeps the event log free
     * of an earlier `TombstoneRecorded(remote_trash)` whose idempotency key would
     * otherwise dedupe the genuinely-NEW remote trash under test. Returns the
     * sqlite/state paths with `L = 0` settled and the page active remotely.
     */
    const settleLocalRestore = async (workspace: AbsolutePathType) => {
      const { sqlitePath, statePath } = await establishWorkspace(workspace, {
        authorityMode: 'shared',
      })
      const watchStatePath = join(workspace, 'watch.json')
      // ONE shared gateway across both watch cycles: trash state persists in its
      // closure, so the archive push's remote trash carries into the restore cycle.
      const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })
      const watchOnce = () =>
        runWorkspaceCommand({
          argv: [
            'sync',
            '--watch',
            '--sqlite',
            sqlitePath,
            '--state',
            watchStatePath,
            '--max-cycles',
            '1',
            '--no-materialize-bodies',
          ],
          gateway,
        })

      // 1. Local archive on watch -> settle TrashPage; settled intent converges
      // in_trash = 1 (no tombstone on the incremental scan).
      const archiveDb = new DatabaseSync(sqlitePath)
      try {
        archiveDb.prepare(`UPDATE pages SET _in_trash = 1 WHERE _page_id = ?`).run(testIds.pageId)
      } finally {
        archiveDb.close()
      }
      await watchOnce()
      expect(gateway.ledger.successfulTrashPages).toHaveLength(1)
      // 2. Local restore on watch -> settle RestorePage; settled intent converges
      // in_trash = 0 AND establishes L = 0. Still no remote_trash tombstone event.
      const restoreDb = new DatabaseSync(sqlitePath)
      try {
        restoreDb.prepare(`UPDATE pages SET _in_trash = 0 WHERE _page_id = ?`).run(testIds.pageId)
      } finally {
        restoreDb.close()
      }
      await watchOnce()
      expect(gateway.ledger.successfulRestorePages).toHaveLength(1)
      return { sqlitePath, statePath }
    }

    /** Read the single open conflict row from the control-plane store. */
    const openConflict = (statePath: string): SqlRow | undefined =>
      openReadOnly(statePath, (stateDb) =>
        row(
          stateDb,
          `SELECT conflict_id, page_id, state FROM _nds_conflict WHERE state = 'open' AND page_id = ?`,
          testIds.pageId,
        ),
      )

    // (a) The freeze test: a remote trash after a settled local restore raises ONE
    // open lifecycle conflict and does NOT silently flip `_in_trash` from 0 to 1.
    it(
      'raises ONE open lifecycle conflict on remote trash after settled restore; _in_trash stays 0, no silent flip',
      async () => {
        const workspace = await tempWorkspace()
        const { sqlitePath, statePath } = await settleLocalRestore(workspace)

        // Independent remote TRASH, modeled by a FRESH gateway whose page is trashed
        // (`inTrash: true`): the page is excluded from `data_source.query`, so the
        // disappearance classifier directly retrieves it, sees inTrash, and records a
        // `remote_trash` tombstone (`R = 1`). With the settled local target `L = 0`,
        // detection raises a lifecycle conflict BEFORE the tombstone applies and the
        // projection freezes `_in_trash` at 0.
        const trashGateway = makeFakeGatewayHarness({
          pages: [
            pageSnapshot({ inTrash: true, propertiesHash: hash('properties-remote-trashed') }),
          ],
          propertyPages: [propertyPage('Trashed remotely')],
        })
        await runWorkspaceCommand({
          argv: ['sync', '--sqlite', sqlitePath, '--no-materialize-bodies'],
          gateway: trashGateway,
        })

        openReadOnly(statePath, (stateDb) => {
          // Exactly one open lifecycle conflict + the shadow guard diagnostic.
          expect(
            rows(
              stateDb,
              `SELECT page_id FROM _nds_conflict WHERE state = 'open' AND page_id = ?`,
              testIds.pageId,
            ),
          ).toHaveLength(1)
          expect(
            row(
              stateDb,
              `SELECT guard FROM _nds_guard_block WHERE guard = 'PendingIntentShadowViolation'`,
            ),
          ).toMatchObject({ guard: 'PendingIntentShadowViolation' })
          // Determinism invariant: the ConflictRaised sits at a LOWER sequence than
          // the tombstone it gates, so on full-log replay the freeze is already in
          // effect when the tombstone applies.
          const conflictSeq = row(
            stateDb,
            `SELECT MAX(sequence) AS sequence FROM _nds_sync_event WHERE event_type = 'ConflictRaised'`,
          )?.sequence
          const tombstoneSeq = row(
            stateDb,
            `SELECT MAX(sequence) AS sequence FROM _nds_sync_event WHERE event_type = 'TombstoneRecorded'`,
          )?.sequence
          expect(Number(conflictSeq)).toBeLessThan(Number(tombstoneSeq))
          // The remote_trash tombstone DID land (proves the classify path ran), yet
          // the freeze held in_trash at the local target.
          expect(
            row(stateDb, `SELECT reason FROM _nds_tombstone WHERE page_id = ?`, testIds.pageId),
          ).toMatchObject({ reason: 'remote_trash' })
          expect(
            row(stateDb, `SELECT in_trash FROM _nds_row WHERE page_id = ?`, testIds.pageId),
          ).toMatchObject({ in_trash: 0 })
        })
        // Public in_trash is frozen at the settled local target (0), no silent flip.
        openReadOnly(sqlitePath, (readDb) => {
          expect(
            row(readDb, `SELECT _in_trash FROM pages WHERE _page_id = ?`, testIds.pageId),
          ).toMatchObject({ _in_trash: 0 })
        })
      },
      sqliteContractTimeoutMs,
    )

    // (b) keep-remote: accept the remote trash (R=1) -> _in_trash flips to 1.
    it(
      'keep-remote resolves the tombstone-origin lifecycle conflict and flips _in_trash to 1',
      async () => {
        const workspace = await tempWorkspace()
        const { sqlitePath, statePath } = await settleLocalRestore(workspace)
        const trashGateway = makeFakeGatewayHarness({
          pages: [
            pageSnapshot({ inTrash: true, propertiesHash: hash('properties-remote-trashed') }),
          ],
          propertyPages: [propertyPage('Trashed remotely')],
        })
        await runWorkspaceCommand({
          argv: ['sync', '--sqlite', sqlitePath, '--no-materialize-bodies'],
          gateway: trashGateway,
        })
        const conflictId = String(openConflict(statePath)?.conflict_id)

        // keep-remote: adopt the remote trash target. The tombstone stands.
        await runWorkspaceCommand({
          argv: [
            'conflicts',
            'resolve',
            '--sqlite',
            sqlitePath,
            '--conflict-id',
            conflictId,
            '--strategy',
            'keep-remote',
          ],
        })

        openReadOnly(statePath, (stateDb) => {
          expect(
            row(stateDb, `SELECT state FROM _nds_conflict WHERE conflict_id = ?`, conflictId),
          ).toMatchObject({ state: 'resolved' })
          // The remote_trash tombstone stands (remote target is trash, not active).
          expect(
            row(stateDb, `SELECT reason FROM _nds_tombstone WHERE page_id = ?`, testIds.pageId),
          ).toMatchObject({ reason: 'remote_trash' })
        })
        openReadOnly(sqlitePath, (readDb) => {
          expect(
            row(readDb, `SELECT _in_trash FROM pages WHERE _page_id = ?`, testIds.pageId),
          ).toMatchObject({ _in_trash: 1 })
        })
      },
      sqliteContractTimeoutMs,
    )

    // (c) keep-local: re-assert the local restore (L=0) -> RestorePage re-enqueued,
    // conflict `resolving`, _in_trash stays 0 (freeze held by the resolving state).
    it(
      'keep-local resolves the tombstone-origin conflict, re-enqueues a Restore push, and keeps _in_trash at 0',
      async () => {
        const workspace = await tempWorkspace()
        const { sqlitePath, statePath } = await settleLocalRestore(workspace)
        const trashGateway = makeFakeGatewayHarness({
          pages: [
            pageSnapshot({ inTrash: true, propertiesHash: hash('properties-remote-trashed') }),
          ],
          propertyPages: [propertyPage('Trashed remotely')],
        })
        await runWorkspaceCommand({
          argv: ['sync', '--sqlite', sqlitePath, '--no-materialize-bodies'],
          gateway: trashGateway,
        })
        const conflictId = String(openConflict(statePath)?.conflict_id)

        // keep-local: re-assert the local restore (L=0) via a fresh RestorePage push.
        await runWorkspaceCommand({
          argv: [
            'conflicts',
            'resolve',
            '--sqlite',
            sqlitePath,
            '--conflict-id',
            conflictId,
            '--strategy',
            'keep-local',
            '--value-json',
            JSON.stringify({ _tag: 'title', plainText: 'ignored' }),
          ],
        })

        openReadOnly(statePath, (stateDb) => {
          // keep-local does NOT fully resolve — the conflict stays `resolving` until
          // the re-assert settles, keeping the freeze active.
          expect(
            row(stateDb, `SELECT state FROM _nds_conflict WHERE conflict_id = ?`, conflictId),
          ).toMatchObject({ state: 'resolving' })
          expect(
            rows(
              stateDb,
              `SELECT command_tag FROM _nds_outbox WHERE command_tag = 'RestorePage' AND command_id LIKE 'cmd:resolve-lifecycle%' AND surface = ?`,
              `page:${testIds.pageId}`,
            ).length,
          ).toBeGreaterThanOrEqual(1)
        })
        openReadOnly(sqlitePath, (readDb) => {
          expect(
            row(readDb, `SELECT _in_trash FROM pages WHERE _page_id = ?`, testIds.pageId),
          ).toMatchObject({ _in_trash: 0 })
        })
      },
      sqliteContractTimeoutMs,
    )

    // (d) BENIGN false-positive guard: a remote trash with NO settled lifecycle
    // intent (`L = undefined`) raises NO conflict and the tombstone applies normally
    // (in_trash = 1).
    it(
      'BENIGN: remote trash with no settled lifecycle target applies normally (in_trash=1), NO conflict',
      async () => {
        const workspace = await tempWorkspace()
        const { sqlitePath } = await establishWorkspace(workspace, { authorityMode: 'shared' })
        const statePath = statePathForWorkspace(workspace)
        // ONE shared gateway: a local archive settles a TrashPage, the trashed row
        // drops from query, and the re-observe records a `remote_trash` tombstone.
        // The only settled lifecycle intent is TRASH (L=1), which MATCHES the remote
        // trash (R=1) — benign, no conflict. (No restore is ever settled, so the
        // tombstone direction has no divergent L.)
        const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })
        const syncOnce = () =>
          runWorkspaceCommand({
            argv: ['sync', '--sqlite', sqlitePath, '--no-materialize-bodies'],
            gateway,
          })
        const archiveDb = new DatabaseSync(sqlitePath)
        try {
          archiveDb.prepare(`UPDATE pages SET _in_trash = 1 WHERE _page_id = ?`).run(testIds.pageId)
        } finally {
          archiveDb.close()
        }
        await syncOnce()
        expect(gateway.ledger.successfulTrashPages).toHaveLength(1)
        await syncOnce()

        openReadOnly(statePath, (stateDb) => {
          // No false-positive conflict, no shadow guard: L=1 matches R=1.
          expect(
            rows(
              stateDb,
              `SELECT conflict_id FROM _nds_conflict WHERE page_id = ?`,
              testIds.pageId,
            ),
          ).toEqual([])
          expect(
            rows(
              stateDb,
              `SELECT guard FROM _nds_guard_block WHERE guard = 'PendingIntentShadowViolation'`,
            ),
          ).toEqual([])
          // The tombstone applied normally — its in_trash=1 write was NOT frozen.
          expect(
            row(stateDb, `SELECT reason FROM _nds_tombstone WHERE page_id = ?`, testIds.pageId),
          ).toMatchObject({ reason: 'remote_trash' })
          expect(
            row(stateDb, `SELECT in_trash FROM _nds_row WHERE page_id = ?`, testIds.pageId),
          ).toMatchObject({ in_trash: 1 })
        })
        openReadOnly(sqlitePath, (readDb) => {
          expect(
            row(readDb, `SELECT _in_trash FROM pages WHERE _page_id = ?`, testIds.pageId),
          ).toMatchObject({ _in_trash: 1 })
        })
      },
      sqliteContractTimeoutMs,
    )

    // (e) REPLAY determinism: the ConflictRaised sits at a LOWER sequence than the
    // tombstone, so rebuilding projections twice yields the SAME open conflict and
    // frozen in_trash (the tombstone's in_trash=1 write stays gated on replay).
    it(
      'REPLAY determinism: rebuilding projections twice yields identical _nds_conflict and frozen _nds_row.in_trash',
      async () => {
        const workspace = await tempWorkspace()
        const { sqlitePath, statePath } = await settleLocalRestore(workspace)
        const trashGateway = makeFakeGatewayHarness({
          pages: [
            pageSnapshot({ inTrash: true, propertiesHash: hash('properties-remote-trashed') }),
          ],
          propertyPages: [propertyPage('Trashed remotely')],
        })
        await runWorkspaceCommand({
          argv: ['sync', '--sqlite', sqlitePath, '--no-materialize-bodies'],
          gateway: trashGateway,
        })

        const snapshotState = () =>
          openReadOnly(statePath, (stateDb) => ({
            conflicts: rows(
              stateDb,
              `SELECT conflict_id, page_id, state FROM _nds_conflict ORDER BY conflict_id`,
            ),
            inTrash: row(
              stateDb,
              `SELECT in_trash FROM _nds_row WHERE page_id = ?`,
              testIds.pageId,
            ),
          }))

        const before = snapshotState()
        expect(before.conflicts).toHaveLength(1)
        expect(before.inTrash).toMatchObject({ in_trash: 0 })

        const rootId = decode({
          schema: SyncRootId,
          value: String(
            openReadOnly(statePath, (stateDb) =>
              row(stateDb, `SELECT root_id FROM _nds_data_source LIMIT 1`),
            )?.root_id,
          ),
        })
        const rebuild = () => {
          const store = openNotionSyncStore({ path: statePath, busyTimeoutMs: 2_500 })
          try {
            store.rebuildProjections(rootId)
          } finally {
            store.close()
          }
        }
        rebuild()
        const afterFirst = snapshotState()
        rebuild()
        const afterSecond = snapshotState()

        expect(afterFirst).toEqual(before)
        expect(afterSecond).toEqual(before)
      },
      sqliteContractTimeoutMs,
    )
  })
})
