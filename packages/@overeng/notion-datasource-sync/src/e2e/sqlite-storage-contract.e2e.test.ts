import { access, copyFile, mkdtemp, rm } from 'node:fs/promises'
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
import type { NotionGatewayClient } from '../gateway/notion.ts'
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
  join(workspace, `${testIds.databaseId}.sqlite`)

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
  'rows',
  'schema',
  'schema_properties',
  'changes',
  'conflicts',
  'sync_status',
])

const assertStorageTaxonomy = (db: DatabaseSync): void => {
  const objects = sqliteMasterObjects(db)
  const names = objects.map((object) => String(object.name))

  expect(names).toEqual(expect.arrayContaining([...publicSafeNames]))
  expect(names).toContain('_nds_workspace_binding')
  expect(names.some((name) => name.startsWith('debug_'))).toBe(true)

  const unsafePublic = names.filter((name) => {
    if (publicSafeNames.has(name) === true) return false
    if (name.startsWith('debug_') === true) return false
    if (name.startsWith('_nds_') === true) return false
    return true
  })
  expect(unsafePublic).toEqual([])

  const legacyNames = names.filter(
    (name) => name.startsWith('notion_') || name.endsWith('_projection') || name === 'sync_event',
  )
  expect(legacyNames).toEqual([])
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
    db.prepare(`INSERT INTO rows ("Task name", _client_request_key) VALUES (?, ?)`).run(
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
    db.prepare(`UPDATE rows SET "Task name" = ? WHERE _page_id = ?`).run(title, testIds.pageId)
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
  }: {
    readonly schemaProperties?: readonly (typeof rowsTitleSchemaProperty)[]
  } = {},
) => {
  const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })
  const calls = {
    retrieveDatabase: 0,
  }
  const gatewayClient = makeDatabaseResolverClient(calls)
  const schemaPropertiesJson = JSON.stringify(schemaProperties)
  const argv = [
    'sync',
    '--from-notion',
    databaseUrl,
    workspace,
    '--schema-properties-json',
    schemaPropertiesJson,
    '--no-materialize-bodies',
  ] as const
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
    return { gateway, result, calls, sqlitePath: sqlitePathForWorkspace(workspace) }
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
    'fresh sync --from-notion creates one required database-id SQLite file without store or config sidecars',
    async () => {
      const workspace = await tempWorkspace()
      const { gateway, sqlitePath, result } = await establishWorkspace(workspace)

      expect(result).toMatchObject({
        command: 'sync-from-notion',
        result: { pushed: false },
      })
      expect(await exists(sqlitePath)).toBe(true)
      expect(await exists(sidecarStorePath(workspace))).toBe(false)
      expect(await exists(sidecarConfigPath(workspace))).toBe(false)
      expectNoRemoteWrites(gateway)

      openReadOnly(sqlitePath, (db) => {
        assertStorageTaxonomy(db)
        expect(
          row(db, `SELECT database_id, data_source_id, workspace_root FROM _nds_workspace_binding`),
        ).toMatchObject({
          database_id: testIds.databaseId,
          data_source_id: testIds.dataSourceId,
          workspace_root: workspace,
        })
        expect(row(db, `SELECT property_name, property_type FROM schema_properties`)).toEqual({
          property_name: 'Task name',
          property_type: 'title',
        })

        const columns = tableColumns(db, 'rows')
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
            'sync',
            '--from-notion',
            databaseUrl,
            workspace,
            '--query-contract-json',
            queryContractJson,
          ],
          resolvedCommand: parseCliCommand(['sync', '--from-notion', databaseUrl, workspace]),
        }),
      ).toThrow('--query-contract-json is not supported')
      expect(await exists(sqlitePathForWorkspace(workspace))).toBe(false)

      expect(() =>
        parseCliContext({
          argv: ['sync', '--from-notion', databaseUrl, workspace, '--sqlite', explicitPath],
          resolvedCommand: parseCliCommand(['sync', '--from-notion', databaseUrl, workspace]),
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
        db.prepare(`UPDATE rows SET "Task name" = ? WHERE _page_id = ?`).run(
          'Updated through rows',
          testIds.pageId,
        )
        db.prepare(`INSERT INTO rows ("Task name", _client_request_key) VALUES (?, ?)`).run(
          'Created through rows',
          'contract-create-1',
        )
        db.prepare(`UPDATE rows SET _in_trash = 1 WHERE _page_id = ?`).run(testIds.pageId)
        db.prepare(`UPDATE rows SET _in_trash = 0 WHERE _page_id = ?`).run(testIds.pageId)

        expect(
          rows(db, `SELECT kind, status FROM changes ORDER BY created_at, change_id`).map(
            (change) => change.kind,
          ),
        ).toEqual(
          expect.arrayContaining(['cell_patch', 'row_create', 'row_archive', 'row_restore']),
        )

        expect(() => db.prepare(`DELETE FROM rows WHERE _page_id = ?`).run(testIds.pageId)).toThrow(
          /unsupported|unsafe|archive/i,
        )
        expect(() =>
          db
            .prepare(`UPDATE rows SET _page_id = 'other-page' WHERE _page_id = ?`)
            .run(testIds.pageId),
        ).toThrow(/read-only|system|identity/i)
        expect(() => db.prepare(`UPDATE schema SET name = 'Unsafe'`).run()).toThrow(
          /read-only|schema/i,
        )
        expect(() => db.prepare(`INSERT INTO _nds_workspace_binding DEFAULT VALUES`).run()).toThrow(
          /read-only|internal|private|unsafe/i,
        )
      } finally {
        db.close()
      }

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
             FROM rows
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
    'sync --watch drains a direct public rows UPDATE through fake Notion and settles it',
    async () => {
      const workspace = await tempWorkspace()
      const { sqlitePath } = await establishWorkspace(workspace)
      updatePublicRowsTitle({ sqlitePath, title: 'Updated by watch' })

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

      expect(gateway.ledger.successfulPatchPageProperties).toHaveLength(1)
      openReadOnly(sqlitePath, (db) => {
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
            .prepare(`UPDATE rows SET "Status" = ? WHERE _page_id = ?`)
            .run('Definitely not real', testIds.pageId),
        ).toThrow(/malformed|unsupported/i)
        expect(() =>
          db.prepare(`UPDATE rows SET "Priority" = ? WHERE _page_id = ?`).run('', testIds.pageId),
        ).toThrow(/malformed|unsupported/i)
        expect(() =>
          db
            .prepare(`INSERT INTO rows ("Task name", "Status") VALUES (?, ?)`)
            .run('Bad status create', 'Definitely not real'),
        ).toThrow(/malformed|unsupported/i)

        db.prepare(`UPDATE rows SET "Status" = ?, "Priority" = ? WHERE _page_id = ?`).run(
          'Next up',
          'High',
          testIds.pageId,
        )
        db.prepare(`INSERT INTO rows ("Task name", "Status", "Priority") VALUES (?, ?, ?)`).run(
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
      const workspace = await tempWorkspace()
      const { sqlitePath } = await establishWorkspace(workspace)

      const tamperCases: ReadonlyArray<{
        readonly name: string
        readonly sql: (db: DatabaseSync) => void
        readonly argv: (path: string) => ReadonlyArray<string>
      }> = [
        {
          name: 'missing workspace binding',
          sql: (db) => db.prepare(`DELETE FROM _nds_workspace_binding`).run(),
          argv: () => ['sync', workspace],
        },
        {
          name: 'invalid binding',
          sql: (db) =>
            db
              .prepare(`UPDATE _nds_workspace_binding SET workspace_root = ?`)
              .run(join(workspace, 'moved')),
          argv: () => ['status', workspace],
        },
        {
          name: 'dropped private state',
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
          name: 'dropped rows trigger',
          sql: (db) => {
            const trigger = row(
              db,
              `SELECT name FROM sqlite_master
               WHERE type = 'trigger' AND sql LIKE '%rows%'
               ORDER BY name LIMIT 1`,
            )
            expect(trigger?.name).toEqual(expect.any(String))
            db.prepare(`DROP TRIGGER ${String(trigger?.name)}`).run()
          },
          argv: (path) => ['sync', '--sqlite', path, '--dry-run'],
        },
        {
          name: 'dropped public rows view',
          sql: (db) => db.prepare(`DROP VIEW rows`).run(),
          argv: (path) => ['doctor', '--sqlite', path],
        },
      ]

      await Promise.all(
        tamperCases.map(async (tamperCase) => {
          const copyPath = join(workspace, `${tamperCase.name.replaceAll(' ', '-')}.sqlite`)
          await copyFile(sqlitePath, copyPath)
          const db = new DatabaseSync(copyPath)
          try {
            tamperCase.sql(db)
          } finally {
            db.close()
          }

          const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })
          await expectCommandFailsClosed({ argv: tamperCase.argv(copyPath), gateway })
        }),
      )
    },
    sqliteContractTimeoutMs,
  )

  it(
    'SQLite backup copies open without sidecars and report binding plus moved-workspace status',
    async () => {
      const workspace = await tempWorkspace()
      const movedWorkspace = await tempWorkspace()
      const { sqlitePath } = await establishWorkspace(workspace)
      const copyPath = join(movedWorkspace, `${testIds.databaseId}.sqlite`)
      await copyFile(sqlitePath, copyPath)

      openReadOnly(copyPath, (db) => {
        assertStorageTaxonomy(db)
        expect(
          row(db, `SELECT database_id, data_source_id FROM _nds_workspace_binding`),
        ).toMatchObject({
          database_id: testIds.databaseId,
          data_source_id: testIds.dataSourceId,
        })
        expect(row(db, `SELECT workspace_status FROM sync_status`)).toMatchObject({
          workspace_status: 'moved',
        })
      })

      await expect(
        runWorkspaceCommand({ argv: ['status', '--sqlite', copyPath] }),
      ).resolves.toMatchObject({
        result: { command: 'status', result: { binding: expect.any(Object) } },
      })
      expect(await exists(sidecarStorePath(movedWorkspace))).toBe(false)
      expect(await exists(sidecarConfigPath(movedWorkspace))).toBe(false)
    },
    sqliteContractTimeoutMs,
  )
})
