import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  parseCliCommand,
  parseCliContext,
  resolveCliCommandNotionRefs,
  runCliCommandWithRuntime,
} from '../cli/main.ts'
import {
  formatNotionDatasourceSyncDemoAccessFailure,
  notionDatasourceSyncDemoManifest,
  resolveNotionDatasourceSyncDemoDataSources,
  type NotionDatasourceSyncDemoDataSource,
} from '../demo/live-demo.ts'

const liveToken = process.env.NOTION_API_TOKEN ?? process.env.NOTION_TOKEN
const liveDemoEnabled = process.env.NOTION_DATASOURCE_SYNC_LIVE === '1' && liveToken !== undefined
const liveExistingBodyRef =
  process.env.NOTION_DATASOURCE_SYNC_EXISTING_DATABASE_URL ??
  process.env.NOTION_DATASOURCE_SYNC_EXISTING_DATA_SOURCE_ID
const notionVersion = '2026-03-11'
const expectedDemoPageId =
  process.env.NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID ?? notionDatasourceSyncDemoManifest.pageId

const normalizeNotionId = (id: string): string => id.replaceAll('-', '').toLowerCase()

const readCount = (database: DatabaseSync, sql: string): number => {
  const row = database.prepare(sql).get() as { readonly count: number } | undefined
  if (row === undefined || typeof row.count !== 'number') {
    throw new Error(`SQLite count query did not return a numeric count: ${sql}`)
  }
  return row.count
}

const notionFetch = async <T>({
  path,
  operation,
  targetAlias,
  init = {},
}: {
  readonly path: string
  readonly operation: string
  readonly targetAlias: string
  readonly init?: RequestInit
}): Promise<T> => {
  if (liveToken === undefined) {
    throw new Error('live Notion demo test requires NOTION_API_TOKEN or NOTION_TOKEN')
  }

  const response = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${liveToken}`,
      'Notion-Version': notionVersion,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })
  if (response.ok === false) {
    const body = await response.text()
    throw new Error(
      formatNotionDatasourceSyncDemoAccessFailure({
        operation,
        targetAlias,
        status: response.status,
        body,
      }),
    )
  }
  return (await response.json()) as T
}

type NotionChildrenResponse = {
  readonly results: ReadonlyArray<{
    readonly id: string
    readonly type: string
    readonly child_database?: { readonly title: string }
  }>
  readonly has_more: boolean
  readonly next_cursor: string | null
}

type NotionDataSourceResponse = {
  readonly id: string
  readonly title?: ReadonlyArray<{ readonly plain_text?: string }>
  readonly properties: Record<string, unknown>
}

type NotionDatabaseResponse = {
  readonly id: string
  readonly data_sources?: ReadonlyArray<{ readonly id: string }>
}

type NotionQueryResponse = {
  readonly results: ReadonlyArray<unknown>
  readonly has_more: boolean
  readonly next_cursor: string | null
}

const listDemoPageDatabaseBlocks = async (pageId: string) => {
  const blocks: Array<NotionChildrenResponse['results'][number]> = []
  let cursor: string | null = null
  do {
    const query = new URLSearchParams({ page_size: '100' })
    if (cursor !== null) query.set('start_cursor', cursor)
    // oxlint-disable-next-line no-await-in-loop -- Notion pagination is cursor-serial.
    const page = await notionFetch<NotionChildrenResponse>({
      path: `/blocks/${pageId}/children?${query.toString()}`,
      operation: 'list-demo-page-databases',
      targetAlias: 'demo-page',
    })
    blocks.push(...page.results.filter((block) => block.type === 'child_database'))
    cursor = page.has_more === true ? page.next_cursor : null
  } while (cursor !== null)
  return blocks
}

const retrieveDatabaseDataSourceId = async ({
  databaseId,
  targetAlias,
}: {
  readonly databaseId: string
  readonly targetAlias: string
}): Promise<string> => {
  const database = await notionFetch<NotionDatabaseResponse>({
    path: `/databases/${databaseId}`,
    operation: 'retrieve-database',
    targetAlias,
  })
  const dataSourceId = database.data_sources?.[0]?.id
  if (dataSourceId === undefined) {
    throw new Error(
      formatNotionDatasourceSyncDemoAccessFailure({
        operation: 'retrieve-database',
        targetAlias,
        code: 'missing_child_data_source',
      }),
    )
  }
  return dataSourceId
}

const resolveLiveDemoDataSources = async (): Promise<
  ReadonlyArray<NotionDatasourceSyncDemoDataSource>
> => {
  const childDatabases = await listDemoPageDatabaseBlocks(expectedDemoPageId)
  const expectedTitles: ReadonlySet<string> = new Set(
    notionDatasourceSyncDemoManifest.dataSources.map((dataSource) => dataSource.title),
  )
  const childDatabasesWithDataSources = await Promise.all(
    childDatabases
      .filter((database) => expectedTitles.has(database.child_database?.title ?? '') === true)
      .map(async (database) => ({
        databaseId: database.id,
        title: database.child_database?.title ?? '',
        dataSourceId: await retrieveDatabaseDataSourceId({
          databaseId: database.id,
          targetAlias: `database:${database.child_database?.title ?? 'unknown'}`,
        }),
      })),
  )
  return resolveNotionDatasourceSyncDemoDataSources({
    manifest: notionDatasourceSyncDemoManifest,
    childDatabases: childDatabasesWithDataSources,
  })
}

const countRemoteRows = async (dataSource: NotionDatasourceSyncDemoDataSource): Promise<number> => {
  let count = 0
  let cursor: string | null = null
  do {
    const body: { readonly page_size: 100; readonly start_cursor?: string } = {
      page_size: 100,
      ...(cursor === null ? {} : { start_cursor: cursor }),
    }
    // oxlint-disable-next-line no-await-in-loop -- Notion pagination is cursor-serial.
    const page: NotionQueryResponse = await notionFetch<NotionQueryResponse>({
      path: `/data_sources/${dataSource.dataSourceId}/query`,
      operation: 'query-data-source',
      targetAlias: `data-source:${dataSource.key}`,
      init: {
        method: 'POST',
        body: JSON.stringify(body),
      },
    })
    count += page.results.length
    cursor = page.has_more === true ? page.next_cursor : null
  } while (cursor !== null)
  return count
}

const syncDemoDataSource = async ({
  dataSource,
  workspace,
}: {
  readonly dataSource: NotionDatasourceSyncDemoDataSource
  readonly workspace: string
}) => {
  if (liveToken === undefined) {
    throw new Error('live Notion demo sync requires NOTION_API_TOKEN or NOTION_TOKEN')
  }

  const argv = [
    'sync',
    '--from-notion',
    dataSource.databaseUrl,
    workspace,
    '--no-materialize-bodies',
  ]
  const parsed = parseCliCommand(argv)
  let context: ReturnType<typeof parseCliContext> | undefined

  try {
    const command = await Effect.runPromise(
      resolveCliCommandNotionRefs({
        command: parsed,
        options: { env: { NOTION_API_TOKEN: liveToken } },
      }),
    )
    context = parseCliContext({ argv, resolvedCommand: command })
    await Effect.runPromise(
      runCliCommandWithRuntime({
        command,
        context,
        options: { env: { NOTION_API_TOKEN: liveToken } },
      }),
    )
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Notion live demo access check failed:') === true
    ) {
      throw error
    }
    throw new Error(
      formatNotionDatasourceSyncDemoAccessFailure({
        operation: 'sync-data-source',
        targetAlias: `data-source:${dataSource.key}`,
        code: 'cli_argument_error',
      }),
      { cause: error },
    )
  } finally {
    context?.store.close()
  }
}

const inspectReplica = ({
  sqlitePath,
  dataSource,
}: {
  readonly sqlitePath: string
  readonly dataSource: NotionDatasourceSyncDemoDataSource
}) => {
  const database = new DatabaseSync(sqlitePath, { readOnly: true })
  try {
    const rowCount = readCount(database, 'SELECT count(*) AS count FROM rows')
    const propertyCount = readCount(database, 'SELECT count(*) AS count FROM schema_properties')
    const cellCount = readCount(database, 'SELECT count(*) AS count FROM _nds_property_shadow')
    const status = database.prepare('SELECT * FROM sync_status').get() as
      | {
          readonly rows: number
          readonly cells: number
          readonly conflicts_open: number
          readonly pending_local_changes: number
          readonly workspace_status: string
        }
      | undefined
    if (status === undefined) {
      throw new Error(`sync_status did not contain a row for ${dataSource.key}`)
    }
    return { rowCount, propertyCount, cellCount, status }
  } finally {
    database.close()
  }
}

const listNmdFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name)
      if (entry.isDirectory() === true) {
        return listNmdFiles(path)
      }
      return entry.isFile() === true && entry.name.endsWith('.nmd') === true ? [path] : []
    }),
  )
  return nested.flat()
}

const inspectBodyMaterialization = async (workspace: string, sqlitePath: string) => {
  const nmdFiles = await listNmdFiles(workspace)
  const contents = await Promise.all(nmdFiles.map((path) => readFile(path, 'utf8')))
  const database = new DatabaseSync(sqlitePath, { readOnly: true })
  try {
    const bodyPointers = readCount(database, 'SELECT count(*) AS count FROM _nds_body_pointer')
    const lossyBodyPointers = readCount(
      database,
      `SELECT count(*) AS count
       FROM _nds_body_pointer
       WHERE json_extract(safety_json, '$.truncated') = 1
          OR json_extract(safety_json, '$.unknownBlockCause') IS NOT NULL`,
    )
    return { bodyPointers, lossyBodyPointers, nmdFiles, contents }
  } finally {
    database.close()
  }
}

describe.skipIf(liveDemoEnabled === false)('credentialed live demo replica contract', () => {
  it('matches the current public demo page, child data sources, schemas, and row counts', async () => {
    expect(normalizeNotionId(expectedDemoPageId)).toHaveLength(32)

    const resolvedDataSources = await resolveLiveDemoDataSources()
    const childDatabases = await listDemoPageDatabaseBlocks(expectedDemoPageId)
    const childDatabaseById = new Map(
      childDatabases.map((block) => [normalizeNotionId(block.id), block]),
    )

    for (const dataSource of resolvedDataSources) {
      const childDatabase = childDatabaseById.get(normalizeNotionId(dataSource.databaseId))
      expect(childDatabase?.child_database?.title).toBe(dataSource.title)

      // oxlint-disable-next-line no-await-in-loop -- sequential requests keep the live demo verifier rate-limit friendly.
      const remote = await notionFetch<NotionDataSourceResponse>({
        path: `/data_sources/${dataSource.dataSourceId}`,
        operation: 'retrieve-data-source',
        targetAlias: `data-source:${dataSource.key}`,
      })
      const title = remote.title?.map((part) => part.plain_text ?? '').join('') ?? ''
      const propertyNames = Object.keys(remote.properties)
      // oxlint-disable-next-line no-await-in-loop -- sequential requests keep the live demo verifier rate-limit friendly.
      const rowCount = await countRemoteRows(dataSource)

      expect(normalizeNotionId(remote.id)).toBe(normalizeNotionId(dataSource.dataSourceId))
      expect(title).toBe(dataSource.title)
      expect(propertyNames).toHaveLength(dataSource.expectedPropertyNames.length)
      expect(propertyNames).toEqual(expect.arrayContaining([...dataSource.expectedPropertyNames]))
      expect(rowCount).toBe(dataSource.expectedRows)
    }
  }, 120_000)

  it('syncs the fast demo data sources into database-id-named SQLite replicas', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'notion-ds-sync-live-demo-'))
    try {
      const resolvedDataSources = await resolveLiveDemoDataSources()
      for (const dataSource of resolvedDataSources.filter((source) => source.fastReplica)) {
        // oxlint-disable-next-line no-await-in-loop -- sequential sync avoids hammering Notion with replica builds.
        await syncDemoDataSource({ dataSource, workspace })
        const sqlitePath = join(workspace, `${dataSource.databaseId}.sqlite`)
        const replica = inspectReplica({ sqlitePath, dataSource })

        expect(replica.rowCount).toBe(dataSource.expectedRows)
        expect(replica.propertyCount).toBe(dataSource.expectedPropertyNames.length)
        expect(replica.cellCount).toBe(
          dataSource.expectedRows * dataSource.expectedPropertyNames.length,
        )
        expect(replica.status).toMatchObject({
          rows: dataSource.expectedRows,
          cells: dataSource.expectedRows * dataSource.expectedPropertyNames.length,
          conflicts_open: 0,
          pending_local_changes: 0,
          workspace_status: 'bound',
        })
      }
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }, 360_000)

  it.skipIf(process.env.NOTION_DATASOURCE_SYNC_FULL_DEMO !== '1')(
    'syncs every demo data source including the 500-row activity replica',
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'notion-ds-sync-live-demo-full-'))
      try {
        const resolvedDataSources = await resolveLiveDemoDataSources()
        for (const dataSource of resolvedDataSources) {
          // oxlint-disable-next-line no-await-in-loop -- sequential sync avoids hammering Notion with replica builds.
          await syncDemoDataSource({ dataSource, workspace })
          const sqlitePath = join(workspace, `${dataSource.databaseId}.sqlite`)
          const replica = inspectReplica({ sqlitePath, dataSource })

          expect(replica.rowCount).toBe(dataSource.expectedRows)
          expect(replica.propertyCount).toBe(dataSource.expectedPropertyNames.length)
          expect(replica.status.pending_local_changes).toBe(0)
          expect(replica.status.conflicts_open).toBe(0)
        }
      } finally {
        await rm(workspace, { recursive: true, force: true })
      }
    },
    1_200_000,
  )
})

describe.skipIf(liveDemoEnabled === false || liveExistingBodyRef === undefined)(
  'credentialed existing Notion datasource body materialization',
  () => {
    it('materializes real NotionMD .nmd files through the default CLI runtime', async () => {
      if (liveToken === undefined || liveExistingBodyRef === undefined) {
        throw new Error('live existing body materialization test requires token and remote ref')
      }

      const workspace = await mkdtemp(join(tmpdir(), 'notion-ds-sync-live-existing-body-'))
      const argv = ['sync', '--from-notion', liveExistingBodyRef, workspace]
      const parsed = parseCliCommand(argv)
      const command = await Effect.runPromise(
        resolveCliCommandNotionRefs({
          command: parsed,
          options: { env: { NOTION_API_TOKEN: liveToken } },
        }),
      )
      const context = parseCliContext({ argv, resolvedCommand: command })
      try {
        await Effect.runPromise(
          runCliCommandWithRuntime({
            command,
            context,
            options: { env: { NOTION_API_TOKEN: liveToken } },
          }),
        )

        if (context.storePath === undefined || context.storePath === ':memory:') {
          throw new Error('live existing body materialization test expected a SQLite store path')
        }
        const materialization = await inspectBodyMaterialization(workspace, context.storePath)
        expect(materialization.bodyPointers).toBeGreaterThan(0)
        expect(materialization.nmdFiles).toHaveLength(materialization.bodyPointers)
        for (const content of materialization.contents) {
          expect(content).toContain('"notion_md"')
          expect(content).not.toContain('notion-datasource-sync body materialization placeholder')
        }
      } finally {
        context.store.close()
        await rm(workspace, { recursive: true, force: true })
      }
    }, 900_000)
  },
)
