import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { PagePropertyItemPage } from '../core/commands.ts'
import {
  AbsolutePath,
  PropertyId,
  type Hash as HashType,
  type PropertyId as PropertyIdType,
} from '../core/domain.ts'
import {
  LocalWorkspacePort,
  NotionDataSourceGateway,
  PageBodySyncPort,
  type NotionDataSourceGatewayShape,
} from '../core/ports.ts'
import { initOneShotSync, pullOneShotSync, syncOneShot } from '../sync/sync.ts'
import {
  decode,
  defaultQueryContract,
  hash,
  makeFakeClock,
  makeFakeGatewayHarness,
  makeHarnessPorts,
  makeStoreFixture,
  testIds,
  type FakeGatewayInput,
} from '../testing/harness.ts'
import {
  defaultReplicaPath,
  projectReplicaFromSyncStore,
  readPendingReplicaChanges,
  replicaChangesToPlannerIntents,
  settleReplicaChangesAfterSync,
} from './replica.ts'

type SqlRow = Record<string, unknown>

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tempWorkspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'notion-ds-sync-canonical-rows-'))
  tempDirs.push(dir)
  return decode({ schema: AbsolutePath, value: dir })
}

const propertyId = (value: string) => decode({ schema: PropertyId, value })

const runWithPorts = <TValue, TError>(
  effect: Effect.Effect<
    TValue,
    TError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  >,
  input: {
    readonly gateway: NotionDataSourceGatewayShape
  },
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(NotionDataSourceGateway, input.gateway),
      Effect.provideService(PageBodySyncPort, makeHarnessPorts().body),
      Effect.provideService(LocalWorkspacePort, makeHarnessPorts().workspace),
    ),
  )

const propertyPage = ({
  propertyId,
  value,
  pageId = testIds.pageId,
}: {
  readonly propertyId: string
  readonly value: unknown
  readonly pageId?: string
}) =>
  decode({
    schema: PagePropertyItemPage,
    value: {
      _tag: 'PagePropertyItemPage',
      apiVersion: '2026-03-11',
      requestId: testIds.requestId,
      pageId,
      propertyId,
      items: [
        {
          _tag: 'PagePropertyItem',
          pageId,
          propertyId,
          itemHash: hash(`item-${pageId}-${propertyId}`),
          valueHash: hash(`value-${pageId}-${propertyId}`),
          valueJson: JSON.stringify(value),
        },
      ],
      nextCursor: null,
      hasMore: false,
    },
  })

const scalarPropertyIds = {
  title: propertyId('prop-title'),
  richText: propertyId('prop-rich-text'),
  number: propertyId('prop-number'),
  checkbox: propertyId('prop-checkbox'),
  date: propertyId('prop-date'),
  select: propertyId('prop-select'),
  status: propertyId('prop-status'),
  email: propertyId('prop-email'),
  url: propertyId('prop-url'),
  phone: propertyId('prop-phone'),
} as const

type CanonicalSchemaPropertyFixture = {
  readonly propertyId: PropertyIdType
  readonly name: string
  readonly type: string
  readonly configHash: HashType
  readonly writeClass: 'writable' | 'computed' | 'unsupported'
}

const scalarSchemaProperties = [
  {
    propertyId: scalarPropertyIds.title,
    name: 'Name',
    type: 'title',
    configHash: hash('config-title'),
    writeClass: 'writable' as const,
  },
  {
    propertyId: scalarPropertyIds.richText,
    name: 'Notes',
    type: 'rich_text',
    configHash: hash('config-rich-text'),
    writeClass: 'writable' as const,
  },
  {
    propertyId: scalarPropertyIds.number,
    name: 'Count',
    type: 'number',
    configHash: hash('config-number'),
    writeClass: 'writable' as const,
  },
  {
    propertyId: scalarPropertyIds.checkbox,
    name: 'Done',
    type: 'checkbox',
    configHash: hash('config-checkbox'),
    writeClass: 'writable' as const,
  },
  {
    propertyId: scalarPropertyIds.date,
    name: 'Due',
    type: 'date',
    configHash: hash('config-date'),
    writeClass: 'writable' as const,
  },
  {
    propertyId: scalarPropertyIds.select,
    name: 'Status',
    type: 'select',
    configHash: hash('config-select'),
    writeClass: 'writable' as const,
  },
  {
    propertyId: scalarPropertyIds.status,
    name: 'Phase',
    type: 'status',
    configHash: hash('config-status'),
    writeClass: 'writable' as const,
  },
  {
    propertyId: scalarPropertyIds.email,
    name: 'Email',
    type: 'email',
    configHash: hash('config-email'),
    writeClass: 'writable' as const,
  },
  {
    propertyId: scalarPropertyIds.url,
    name: 'URL',
    type: 'url',
    configHash: hash('config-url'),
    writeClass: 'writable' as const,
  },
  {
    propertyId: scalarPropertyIds.phone,
    name: 'Phone',
    type: 'phone_number',
    configHash: hash('config-phone'),
    writeClass: 'writable' as const,
  },
]

const scalarPropertyPages = [
  propertyPage({ propertyId: scalarPropertyIds.title, value: { _tag: 'title', plainText: 'Task' } }),
  propertyPage({
    propertyId: scalarPropertyIds.richText,
    value: { _tag: 'rich_text', plainText: 'Initial notes' },
  }),
  propertyPage({ propertyId: scalarPropertyIds.number, value: { _tag: 'number', value: 1 } }),
  propertyPage({
    propertyId: scalarPropertyIds.checkbox,
    value: { _tag: 'checkbox', checked: false },
  }),
  propertyPage({
    propertyId: scalarPropertyIds.date,
    value: { _tag: 'date', start: '2026-05-25', end: null },
  }),
  propertyPage({
    propertyId: scalarPropertyIds.select,
    value: { _tag: 'select', option: { name: 'Todo' } },
  }),
  propertyPage({
    propertyId: scalarPropertyIds.status,
    value: { _tag: 'status', option: { name: 'Backlog' } },
  }),
  propertyPage({
    propertyId: scalarPropertyIds.email,
    value: { _tag: 'email', value: 'before@example.com' },
  }),
  propertyPage({
    propertyId: scalarPropertyIds.url,
    value: { _tag: 'url', value: 'https://example.com/before' },
  }),
  propertyPage({
    propertyId: scalarPropertyIds.phone,
    value: { _tag: 'phone_number', value: '+15550000000' },
  }),
]

const withProjectedReplica = async ({
  schemaProperties,
  propertyPages,
  gateway = makeFakeGatewayHarness({ propertyPages }),
}: {
  readonly schemaProperties: ReadonlyArray<CanonicalSchemaPropertyFixture>
  readonly propertyPages: NonNullable<FakeGatewayInput['propertyPages']>
  readonly gateway?: ReturnType<typeof makeFakeGatewayHarness>
}) => {
  const clock = makeFakeClock()
  const workspaceRoot = tempWorkspace()
  const replicaPath = defaultReplicaPath(workspaceRoot)
  const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })

  initOneShotSync({
    store: storeFixture.store,
    rootId: testIds.rootId,
    dataSourceId: testIds.dataSourceId,
    workspaceRoot,
    now: clock.now,
  })
  await runWithPorts(
    pullOneShotSync({
      store: storeFixture.store,
      rootId: testIds.rootId,
      dataSourceId: testIds.dataSourceId,
      workspaceRoot,
      queryContract: defaultQueryContract(),
      schemaProperties,
      now: clock.now,
    }),
    { gateway: gateway.gateway },
  )
  projectReplicaFromSyncStore({
    syncStorePath: storeFixture.path,
    replicaPath,
    rootId: testIds.rootId,
  })

  return { clock, workspaceRoot, replicaPath, storeFixture, gateway }
}

const tableColumns = (db: DatabaseSync, table: string): readonly string[] =>
  (db.prepare(`PRAGMA table_xinfo(${JSON.stringify(table)})`).all() as SqlRow[]).map((row) =>
    String(row.name),
  )

const tableNames = (db: DatabaseSync): readonly string[] =>
  (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name`)
      .all() as SqlRow[]
  ).map((row) => String(row.name))

const canonicalChangeRows = (db: DatabaseSync) =>
  db
    .prepare(
      `SELECT kind, property_id, value_json, status
       FROM notion_local_changes
       ORDER BY created_at, change_id`,
    )
    .all() as SqlRow[]

const pendingCdcCount = (db: DatabaseSync): number =>
  Number(
    (
      db
        .prepare(`SELECT count(*) AS count FROM notion_local_changes WHERE status = 'pending'`)
        .get() as SqlRow
    ).count,
  )

describe('canonical rows SQLite surface contract', () => {
  it('projects rows schema and schema_properties with deterministic column order', async () => {
    const projected = await withProjectedReplica({
      schemaProperties: scalarSchemaProperties,
      propertyPages: scalarPropertyPages,
    })

    try {
      const db = new DatabaseSync(projected.replicaPath, { readOnly: true })
      try {
        expect(tableNames(db)).toEqual(
          expect.arrayContaining(['rows', 'schema', 'schema_properties']),
        )
        expect(tableColumns(db, 'rows')).not.toContain('schema_json')
        expect(tableColumns(db, 'schema')).not.toContain('schema_json')
        expect(tableColumns(db, 'schema_properties')).not.toContain('schema_json')

        const columns = tableColumns(db, 'rows')
        const firstMetadataColumn = columns.findIndex((column) => column.startsWith('_'))
        expect(firstMetadataColumn).toBeGreaterThan(0)
        expect(columns.slice(0, firstMetadataColumn)).toEqual([
          'Name',
          'Notes',
          'Count',
          'Done',
          'Due',
          'Status',
          'Phase',
          'Email',
          'URL',
          'Phone',
        ])
        expect(columns.slice(firstMetadataColumn).every((column) => column.startsWith('_'))).toBe(
          true,
        )
        expect(columns.slice(firstMetadataColumn)).toEqual(
          expect.arrayContaining(['_page_id', '_data_source_id', '_in_trash']),
        )

        expect(
          db
            .prepare(
              `SELECT property_name, property_id, property_type
               FROM schema_properties
               ORDER BY ordinal`,
            )
            .all(),
        ).toEqual(
          scalarSchemaProperties.map((property) => ({
            property_name: property.name,
            property_id: property.propertyId,
            property_type: property.type,
          })),
        )
      } finally {
        db.close()
      }
    } finally {
      projected.storeFixture.cleanup()
    }
  })

  it('plans collision-safe columns for duplicate renamed reserved and keyword property names', async () => {
    const renamedProperty = propertyId('prop-renamed-stable')
    const collidingSchemaProperties = [
      {
        propertyId: propertyId('prop-select-lower'),
        name: 'select',
        type: 'title',
        configHash: hash('config-select-lower'),
        writeClass: 'writable' as const,
      },
      {
        propertyId: propertyId('prop-select-upper'),
        name: 'SELECT',
        type: 'rich_text',
        configHash: hash('config-select-upper'),
        writeClass: 'writable' as const,
      },
      {
        propertyId: propertyId('prop-duplicate-a'),
        name: 'Duplicate',
        type: 'number',
        configHash: hash('config-duplicate-a'),
        writeClass: 'writable' as const,
      },
      {
        propertyId: propertyId('prop-duplicate-b'),
        name: 'Duplicate',
        type: 'checkbox',
        configHash: hash('config-duplicate-b'),
        writeClass: 'writable' as const,
      },
      {
        propertyId: propertyId('prop-reserved-page'),
        name: '_page_id',
        type: 'url',
        configHash: hash('config-reserved-page'),
        writeClass: 'writable' as const,
      },
      {
        propertyId: renamedProperty,
        name: 'Old Name',
        type: 'title',
        configHash: hash('config-renamed-before'),
        writeClass: 'writable' as const,
      },
    ]
    const propertyPages = collidingSchemaProperties.map((property) =>
      propertyPage({
        propertyId: property.propertyId,
        value:
          property.type === 'number'
            ? { _tag: 'number', value: 7 }
            : property.type === 'checkbox'
              ? { _tag: 'checkbox', checked: true }
              : property.type === 'url'
                ? { _tag: 'url', value: 'https://example.com/reserved' }
                : { _tag: 'title', plainText: property.name },
      }),
    )
    const projected = await withProjectedReplica({
      schemaProperties: collidingSchemaProperties,
      propertyPages,
    })

    try {
      await runWithPorts(
        pullOneShotSync({
          store: projected.storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot: projected.workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties: collidingSchemaProperties.map((property) =>
            property.propertyId === renamedProperty
              ? { ...property, name: 'Renamed', configHash: hash('config-renamed-after') }
              : property,
          ),
          now: projected.clock.now,
        }),
        { gateway: projected.gateway.gateway },
      )
      projectReplicaFromSyncStore({
        syncStorePath: projected.storeFixture.path,
        replicaPath: projected.replicaPath,
        rootId: testIds.rootId,
      })

      const db = new DatabaseSync(projected.replicaPath, { readOnly: true })
      try {
        const columns = tableColumns(db, 'rows')
        expect(new Set(columns).size).toBe(columns.length)
        expect(columns).toEqual(
          expect.arrayContaining([
            'select_prop_select_lower',
            'SELECT_prop_select_upper',
            'Duplicate',
            'Duplicate_prop_duplicate_b',
            'property_prop_reserved_page',
            'Renamed',
            '_page_id',
          ]),
        )
        expect(
          db
            .prepare(
              `SELECT property_id, property_name
               FROM schema_properties
               WHERE property_id = ?`,
            )
            .get(renamedProperty),
        ).toEqual({ property_id: renamedProperty, property_name: 'Renamed' })
      } finally {
        db.close()
      }
    } finally {
      projected.storeFixture.cleanup()
    }
  })

  it('queues scalar update archive restore and create CDC through rows then settles via fake gateway', async () => {
    const projected = await withProjectedReplica({
      schemaProperties: scalarSchemaProperties,
      propertyPages: scalarPropertyPages,
    })

    try {
      const db = new DatabaseSync(projected.replicaPath)
      try {
        db.prepare(
          `UPDATE rows
           SET
             "Name" = ?,
             "Notes" = ?,
             "Count" = ?,
             "Done" = ?,
             "Due" = ?,
             "Status" = ?,
             "Phase" = ?,
             "Email" = ?,
             "URL" = ?,
             "Phone" = ?
           WHERE _page_id = ?`,
        ).run(
          'Updated title',
          'Updated rich text',
          42,
          1,
          '2026-05-28',
          'Doing',
          'In progress',
          'after@example.com',
          'https://example.com/after',
          '+15551112222',
          testIds.pageId,
        )
        expect(pendingCdcCount(db)).toBe(10)
        expect(canonicalChangeRows(db)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'cell_patch',
              property_id: scalarPropertyIds.title,
              value_json: JSON.stringify({ _tag: 'title', plainText: 'Updated title' }),
            }),
            expect.objectContaining({
              kind: 'cell_patch',
              property_id: scalarPropertyIds.checkbox,
              value_json: JSON.stringify({ _tag: 'checkbox', checked: true }),
            }),
            expect.objectContaining({
              kind: 'cell_patch',
              property_id: scalarPropertyIds.date,
              value_json: JSON.stringify({ _tag: 'date', start: '2026-05-28', end: null }),
            }),
          ]),
        )

        db.prepare(`UPDATE rows SET _in_trash = 1 WHERE _page_id = ?`).run(testIds.pageId)
        expect(canonicalChangeRows(db)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: 'row_archive' }),
          ]),
        )

        const source = db
          .prepare(`SELECT schema_hash FROM notion_data_sources WHERE data_source_id = ?`)
          .get(testIds.dataSourceId) as SqlRow
        db.prepare(`INSERT INTO rows ("Name", "Count", _client_request_key) VALUES (?, ?, ?)`).run(
          'Created through rows',
          5,
          'client-canonical-create',
        )
        expect(canonicalChangeRows(db)).toEqual(
          expect.arrayContaining([expect.objectContaining({ kind: 'row_create' })]),
        )
        expect(() =>
          db.prepare(`DELETE FROM rows WHERE _page_id = ?`).run(testIds.pageId),
        ).toThrow(/delete/i)
        expect(source.schema_hash).toEqual(expect.any(String))
      } finally {
        db.close()
      }

      const changes = readPendingReplicaChanges(projected.replicaPath)
      const intents = replicaChangesToPlannerIntents({
        changes,
        replicaPath: projected.replicaPath,
      })
      expect(intents.length).toBeGreaterThanOrEqual(10)

      const result = await runWithPorts(
        syncOneShot({
          store: projected.storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot: projected.workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties: scalarSchemaProperties,
          localIntents: intents,
          maxExecutorSteps: 32,
          now: projected.clock.now,
        }),
        { gateway: projected.gateway.gateway },
      )
      settleReplicaChangesAfterSync({
        changes,
        replicaPath: projected.replicaPath,
        store: projected.storeFixture.store,
        rootId: testIds.rootId,
        decisions: result.push.plan.decisions,
      })

      expect(projected.gateway.ledger.successfulPatchPageProperties.length).toBeGreaterThan(0)
      expect(projected.gateway.gateway).toBeDefined()
    } finally {
      projected.storeFixture.cleanup()
    }
  })

  it('queues restore CDC through rows for an archived row', async () => {
    const projected = await withProjectedReplica({
      schemaProperties: scalarSchemaProperties,
      propertyPages: scalarPropertyPages,
    })

    try {
      const db = new DatabaseSync(projected.replicaPath)
      try {
        db.prepare(`UPDATE notion_rows SET in_trash = 1 WHERE page_id = ?`).run(testIds.pageId)
        db.prepare(`UPDATE notion_row_changes SET status = 'applied' WHERE page_id = ?`).run(
          testIds.pageId,
        )
        db.prepare(`UPDATE notion_local_changes SET status = 'applied' WHERE page_id = ?`).run(
          testIds.pageId,
        )
        db.prepare(`UPDATE rows SET _in_trash = 0 WHERE _page_id = ?`).run(testIds.pageId)
        expect(canonicalChangeRows(db)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: 'row_restore', status: 'pending' }),
          ]),
        )
      } finally {
        db.close()
      }

      const changes = readPendingReplicaChanges(projected.replicaPath)
      const intents = replicaChangesToPlannerIntents({
        changes,
        replicaPath: projected.replicaPath,
      })
      expect(intents.map((intent) => intent._tag)).toContain('local-delete')

      const result = await runWithPorts(
        syncOneShot({
          store: projected.storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot: projected.workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties: scalarSchemaProperties,
          localIntents: intents,
          maxExecutorSteps: 8,
          now: projected.clock.now,
        }),
        { gateway: projected.gateway.gateway },
      )
      settleReplicaChangesAfterSync({
        changes,
        replicaPath: projected.replicaPath,
        store: projected.storeFixture.store,
        rootId: testIds.rootId,
        decisions: result.push.plan.decisions,
      })

      const verificationDb = new DatabaseSync(projected.replicaPath, { readOnly: true })
      try {
        expect(canonicalChangeRows(verificationDb)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: 'row_restore', status: 'applied' }),
          ]),
        )
      } finally {
        verificationDb.close()
      }
    } finally {
      projected.storeFixture.cleanup()
    }
  })

  it('fails closed for system schema computed malformed unsupported and atomic invalid rows writes', async () => {
    const computedProperty = propertyId('prop-computed')
    const peopleProperty = propertyId('prop-people')
    const relationProperty = propertyId('prop-relation')
    const schemaProperties = [
      ...scalarSchemaProperties,
      {
        propertyId: computedProperty,
        name: 'Computed score',
        type: 'formula',
        configHash: hash('config-computed'),
        writeClass: 'computed' as const,
      },
      {
        propertyId: peopleProperty,
        name: 'Owner',
        type: 'people',
        configHash: hash('config-people'),
        writeClass: 'writable' as const,
      },
      {
        propertyId: relationProperty,
        name: 'Related',
        type: 'relation',
        configHash: hash('config-relation'),
        writeClass: 'writable' as const,
      },
    ]
    const projected = await withProjectedReplica({
      schemaProperties,
      propertyPages: [
        ...scalarPropertyPages,
        propertyPage({
          propertyId: computedProperty,
          value: { _tag: 'formula', plainText: 'computed' },
        }),
        propertyPage({ propertyId: peopleProperty, value: { _tag: 'people', userIds: [] } }),
        propertyPage({ propertyId: relationProperty, value: { _tag: 'relation', pageIds: [] } }),
      ],
    })

    try {
      const db = new DatabaseSync(projected.replicaPath)
      try {
        const beforeRow = db.prepare(`SELECT * FROM rows WHERE _page_id = ?`).get(testIds.pageId)
        const beforeCdc = pendingCdcCount(db)

        expect(() =>
          db
            .prepare(`UPDATE rows SET _page_id = ? WHERE _page_id = ?`)
            .run('other-page', testIds.pageId),
        ).toThrow(/read-only|system|identity/i)
        expect(() => db.prepare(`UPDATE schema SET name = 'Unsafe'`).run()).toThrow(
          /read-only|schema/i,
        )
        expect(() =>
          db
            .prepare(`UPDATE schema_properties SET property_name = 'Unsafe' WHERE property_id = ?`)
            .run(scalarPropertyIds.title),
        ).toThrow(/read-only|schema/i)
        expect(() =>
          db
            .prepare(`UPDATE rows SET "Computed score" = ? WHERE _page_id = ?`)
            .run('not allowed', testIds.pageId),
        ).toThrow(/computed|read-only|unsupported|not supported/i)
        expect(() =>
          db
            .prepare(`UPDATE rows SET "Count" = ? WHERE _page_id = ?`)
            .run('not a number', testIds.pageId),
        ).toThrow(/number|malformed|canonical/i)
        expect(() =>
          db.prepare(`UPDATE rows SET "Done" = NULL WHERE _page_id = ?`).run(testIds.pageId),
        ).toThrow(/NULL|checkbox|unsafe/i)
        expect(() =>
          db
            .prepare(`UPDATE rows SET "Owner" = ? WHERE _page_id = ?`)
            .run('user-1', testIds.pageId),
        ).toThrow(/people|unsupported|not supported/i)
        expect(() =>
          db
            .prepare(`UPDATE rows SET "Related" = ? WHERE _page_id = ?`)
            .run('page-2', testIds.pageId),
        ).toThrow(/relation|unsupported|guarded|not supported/i)
        expect(() =>
          db
            .prepare(`UPDATE rows SET "Name" = ?, "Count" = ? WHERE _page_id = ?`)
            .run('should not partially land', 'bad count', testIds.pageId),
        ).toThrow(/number|malformed|canonical/i)

        expect(db.prepare(`SELECT * FROM rows WHERE _page_id = ?`).get(testIds.pageId)).toEqual(
          beforeRow,
        )
        expect(pendingCdcCount(db)).toBe(beforeCdc)
      } finally {
        db.close()
      }
    } finally {
      projected.storeFixture.cleanup()
    }
  })

  it('keeps real-user database adoption read-only and live-write queues scratch scoped', async () => {
    const projected = await withProjectedReplica({
      schemaProperties: scalarSchemaProperties,
      propertyPages: scalarPropertyPages,
    })

    try {
      const db = new DatabaseSync(projected.replicaPath)
      try {
        db.prepare(`UPDATE rows SET "Name" = ? WHERE _page_id = ?`).run(
          'Scratch-only scalar update',
          testIds.pageId,
        )
        const pendingRows = db
          .prepare(
            `SELECT change_id, data_source_id, page_id
             FROM notion_local_changes
             WHERE status = 'pending'`,
          )
          .all() as SqlRow[]
        expect(pendingRows.length).toBeGreaterThan(0)
        expect(
          pendingRows.every(
            (row) =>
              row.data_source_id === testIds.dataSourceId &&
              (row.page_id === null || row.page_id === testIds.pageId),
          ),
        ).toBe(true)
      } finally {
        db.close()
      }

      const changes = readPendingReplicaChanges(projected.replicaPath)
      const intents = replicaChangesToPlannerIntents({
        changes,
        replicaPath: projected.replicaPath,
        dryRun: true,
      })
      expect(intents).toHaveLength(changes.length)
      expect(projected.storeFixture.store.readOutbox(testIds.rootId)).toHaveLength(0)
      expect(projected.gateway.ledger.attemptedPatchPageProperties).toHaveLength(0)
    } finally {
      projected.storeFixture.cleanup()
    }
  })
})
