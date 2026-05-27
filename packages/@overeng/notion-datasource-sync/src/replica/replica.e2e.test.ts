import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { PagePropertyItemPage } from '../core/commands.ts'
import { AbsolutePath } from '../core/domain.ts'
import { LocalWorkspacePort, NotionDataSourceGateway, PageBodySyncPort } from '../core/ports.ts'
import { initOneShotSync, pullOneShotSync, syncOneShot } from '../sync/sync.ts'
import {
  decode,
  defaultQueryContract,
  hash,
  makeFakeClock,
  makeFakeGatewayHarness,
  makeHarnessPorts,
  makeStoreFixture,
  pageSnapshot,
  testIds,
} from '../testing/harness.ts'
import {
  defaultReplicaPath,
  projectReplicaFromSyncStore,
  readPendingReplicaChanges,
  replicaChangesToPlannerIntents,
} from './replica.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tempWorkspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'notion-ds-sync-replica-'))
  tempDirs.push(dir)
  return decode({ schema: AbsolutePath, value: dir })
}

const runWithPorts = <TValue, TError>(
  effect: Effect.Effect<
    TValue,
    TError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  >,
  input: {
    readonly gateway: ReturnType<typeof makeFakeGatewayHarness>['gateway']
  },
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(NotionDataSourceGateway, input.gateway),
      Effect.provideService(PageBodySyncPort, makeHarnessPorts().body),
      Effect.provideService(LocalWorkspacePort, makeHarnessPorts().workspace),
    ),
  )

const propertyPage = (plainText: string, propertyId = testIds.propertyA) =>
  decode({
    schema: PagePropertyItemPage,
    value: {
      _tag: 'PagePropertyItemPage',
      apiVersion: '2026-03-11',
      requestId: testIds.requestId,
      pageId: testIds.pageId,
      propertyId,
      items: [
        {
          _tag: 'PagePropertyItem',
          pageId: testIds.pageId,
          propertyId,
          itemHash: hash(`item-${plainText}`),
          valueHash: hash(`value-${plainText}`),
          valueJson: JSON.stringify({ _tag: 'title', plainText }),
        },
      ],
      nextCursor: null,
      hasMore: false,
    },
  })

const schemaProperties = [
  {
    propertyId: testIds.propertyA,
    name: 'Task name',
    type: 'title',
    configHash: hash('config-a'),
    writeClass: 'writable' as const,
  },
]

const statusFor = (replicaPath: string, changeId: string) => {
  const db = new DatabaseSync(replicaPath, { readOnly: true })
  try {
    return db
      .prepare(`SELECT status, unsupported_reason FROM notion_local_changes WHERE change_id = ?`)
      .get(changeId)
  } finally {
    db.close()
  }
}

const cellChangeFor = (replicaPath: string, changeId: string) => {
  const db = new DatabaseSync(replicaPath, { readOnly: true })
  try {
    return db.prepare(`SELECT * FROM notion_cell_changes WHERE change_id = ?`).get(changeId)
  } finally {
    db.close()
  }
}

const rowChangeFor = (replicaPath: string, changeId: string) => {
  const db = new DatabaseSync(replicaPath, { readOnly: true })
  try {
    return db.prepare(`SELECT * FROM notion_row_changes WHERE change_id = ?`).get(changeId)
  } finally {
    db.close()
  }
}

describe('user-facing SQLite replica', () => {
  it('projects observed schema rows cells bodies and generated views into notion.sqlite', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Initial task')] })

    try {
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

      const db = new DatabaseSync(replicaPath, { readOnly: true })
      try {
        expect(db.prepare(`SELECT count(*) AS count FROM notion_data_sources`).get()).toMatchObject(
          { count: 1 },
        )
        expect(db.prepare(`SELECT property_name, property_type FROM notion_properties`).get())
          .toMatchInlineSnapshot(`
            {
              "property_name": "Task name",
              "property_type": "title",
            }
          `)
        expect(db.prepare(`SELECT value_text FROM notion_cells`).get()).toMatchObject({
          value_text: 'Initial task',
        })
        expect(db.prepare(`SELECT "Task name" FROM notion_view_data_source_1`).get()).toMatchObject(
          { 'Task name': 'Initial task' },
        )
      } finally {
        db.close()
      }
    } finally {
      storeFixture.cleanup()
    }
  })

  it('captures direct cell edits in typed CDC tables and translates them into planner intents', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Before')] })

    try {
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

      const db = new DatabaseSync(replicaPath)
      try {
        db.prepare(
          `UPDATE notion_cells SET value_json = ? WHERE page_id = ? AND property_id = ?`,
        ).run(
          JSON.stringify({ _tag: 'title', plainText: 'Direct edit' }),
          testIds.pageId,
          testIds.propertyA,
        )
        db.prepare(
          `UPDATE notion_cells SET value_json = ? WHERE page_id = ? AND property_id = ?`,
        ).run(
          JSON.stringify({ _tag: 'title', plainText: 'Direct edit latest' }),
          testIds.pageId,
          testIds.propertyA,
        )
        expect(
          db
            .prepare(`SELECT value_text FROM notion_cells WHERE page_id = ? AND property_id = ?`)
            .get(testIds.pageId, testIds.propertyA),
        ).toMatchObject({ value_text: 'Direct edit latest' })
        expect(
          db
            .prepare(`SELECT "Task name" FROM notion_view_data_source_1 WHERE page_id = ?`)
            .get(testIds.pageId),
        ).toMatchObject({ 'Task name': 'Direct edit latest' })
        expect(db.prepare(`SELECT count(*) AS count FROM notion_cell_changes`).get()).toEqual({
          count: 1,
        })
        const typedCellChange = db
          .prepare(
            `SELECT change_id, data_source_id, page_id, property_id, value_json, base_hash, status
             FROM notion_cell_changes`,
          )
          .get() as { readonly change_id: string }
        expect(typedCellChange).toMatchObject({
          data_source_id: testIds.dataSourceId,
          page_id: testIds.pageId,
          property_id: testIds.propertyA,
          value_json: JSON.stringify({ _tag: 'title', plainText: 'Direct edit latest' }),
          status: 'pending',
        })
        expect(
          db
            .prepare(
              `SELECT kind, data_source_id, page_id, property_id, value_json, base_hash, status
               FROM notion_local_changes WHERE change_id = ?`,
            )
            .get(typedCellChange.change_id),
        ).toMatchObject({
          kind: 'cell_patch',
          data_source_id: testIds.dataSourceId,
          page_id: testIds.pageId,
          property_id: testIds.propertyA,
          value_json: JSON.stringify({ _tag: 'title', plainText: 'Direct edit latest' }),
          status: 'pending',
        })
        db.prepare(
          `INSERT INTO notion_cell_changes (
             change_id, data_source_id, page_id, property_id, value_json
           ) VALUES (?, ?, ?, ?, ?)`,
        ).run(
          'change-1',
          testIds.dataSourceId,
          testIds.pageId,
          testIds.propertyA,
          JSON.stringify({ _tag: 'title', plainText: 'After' }),
        )
        db.prepare(
          `INSERT INTO notion_row_changes (
             change_id, kind, data_source_id, value_json
           ) VALUES (?, 'row_create', ?, ?)`,
        ).run('change-create', testIds.dataSourceId, JSON.stringify({ title: 'Unsupported' }))
      } finally {
        db.close()
      }

      const changes = readPendingReplicaChanges(replicaPath)
      const intents = replicaChangesToPlannerIntents({ changes, replicaPath })
      expect(intents).toHaveLength(2)
      expect(intents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            _tag: 'property-edit',
            pageId: testIds.pageId,
            propertyId: testIds.propertyA,
          }),
        ]),
      )
      expect(intents[0]).toMatchObject({
        _tag: 'property-edit',
        pageId: testIds.pageId,
        propertyId: testIds.propertyA,
      })
      expect(statusFor(replicaPath, changes[0]?.changeId ?? '')).toMatchObject({
        status: 'pending',
      })
      expect(cellChangeFor(replicaPath, changes[0]?.changeId ?? '')).toMatchObject({
        status: 'pending',
      })

      const after = new DatabaseSync(replicaPath, { readOnly: true })
      try {
        expect(statusFor(replicaPath, 'change-create')).toMatchObject({
          status: 'unsupported',
          unsupported_reason:
            'Row creation needs a create-page gateway command before it can sync safely.',
        })
        expect(rowChangeFor(replicaPath, 'change-create')).toMatchObject({
          status: 'unsupported',
          unsupported_reason:
            'Row creation needs a create-page gateway command before it can sync safely.',
        })
      } finally {
        after.close()
      }
    } finally {
      storeFixture.cleanup()
    }
  })

  it('rejects direct current-state updates to non-writable cells before visible mutation', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({
      propertyPages: [
        propertyPage('Editable task', testIds.propertyA),
        propertyPage('Computed value', testIds.propertyB),
      ],
    })
    const mixedSchemaProperties = [
      ...schemaProperties,
      {
        propertyId: testIds.propertyB,
        name: 'Computed score',
        type: 'formula',
        configHash: hash('config-b'),
        writeClass: 'computed' as const,
      },
    ]

    try {
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
          schemaProperties: mixedSchemaProperties,
          now: clock.now,
        }),
        { gateway: gateway.gateway },
      )
      projectReplicaFromSyncStore({
        syncStorePath: storeFixture.path,
        replicaPath,
        rootId: testIds.rootId,
      })

      const db = new DatabaseSync(replicaPath)
      try {
        const before = db
          .prepare(
            `SELECT value_json, value_text FROM notion_cells WHERE page_id = ? AND property_id = ?`,
          )
          .get(testIds.pageId, testIds.propertyB)

        expect(() =>
          db
            .prepare(`UPDATE notion_cells SET value_json = ? WHERE page_id = ? AND property_id = ?`)
            .run(
              JSON.stringify({ _tag: 'title', plainText: 'Should not land' }),
              testIds.pageId,
              testIds.propertyB,
            ),
        ).toThrow(/writable only for writable Notion properties/u)

        expect(
          db
            .prepare(
              `SELECT value_json, value_text FROM notion_cells WHERE page_id = ? AND property_id = ?`,
            )
            .get(testIds.pageId, testIds.propertyB),
        ).toEqual(before)
        expect(
          db
            .prepare(`SELECT "Computed score" FROM notion_view_data_source_1 WHERE page_id = ?`)
            .get(testIds.pageId),
        ).toMatchObject({ 'Computed score': 'Computed value' })
        expect(
          db.prepare(`SELECT count(*) AS count FROM notion_local_changes`).get(),
        ).toMatchObject({
          count: 0,
        })
        expect(db.prepare(`SELECT count(*) AS count FROM notion_cell_changes`).get()).toMatchObject(
          { count: 0 },
        )
      } finally {
        db.close()
      }
    } finally {
      storeFixture.cleanup()
    }
  })

  it('rejects invalid direct current-state cell updates before visible mutation or CDC append', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Before invalid SQL')] })

    try {
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

      const db = new DatabaseSync(replicaPath)
      try {
        const before = db
          .prepare(
            `SELECT value_json, value_text FROM notion_cells WHERE page_id = ? AND property_id = ?`,
          )
          .get(testIds.pageId, testIds.propertyA)

        expect(() =>
          db
            .prepare(`UPDATE notion_cells SET value_json = ? WHERE page_id = ? AND property_id = ?`)
            .run('{not json', testIds.pageId, testIds.propertyA),
        ).toThrow(/canonical Notion property value JSON/u)
        expect(() =>
          db
            .prepare(`UPDATE notion_cells SET value_json = ? WHERE page_id = ? AND property_id = ?`)
            .run(
              JSON.stringify({ _tag: 'title', wrongShape: 'Should not land' }),
              testIds.pageId,
              testIds.propertyA,
            ),
        ).toThrow(/canonical Notion property value JSON/u)

        expect(
          db
            .prepare(
              `SELECT value_json, value_text FROM notion_cells WHERE page_id = ? AND property_id = ?`,
            )
            .get(testIds.pageId, testIds.propertyA),
        ).toEqual(before)
        expect(
          db
            .prepare(`SELECT "Task name" FROM notion_view_data_source_1 WHERE page_id = ?`)
            .get(testIds.pageId),
        ).toMatchObject({ 'Task name': 'Before invalid SQL' })
        expect(db.prepare(`SELECT count(*) AS count FROM notion_cell_changes`).get()).toEqual({
          count: 0,
        })
        expect(db.prepare(`SELECT count(*) AS count FROM notion_local_changes`).get()).toEqual({
          count: 0,
        })
      } finally {
        db.close()
      }
    } finally {
      storeFixture.cleanup()
    }
  })

  it('plans direct local SQLite edits in dry-run without remote writes and applies them through guarded sync', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Before sync')] })

    try {
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

      const db = new DatabaseSync(replicaPath)
      try {
        db.prepare(
          `UPDATE notion_cells SET value_json = ? WHERE page_id = ? AND property_id = ?`,
        ).run(
          JSON.stringify({ _tag: 'title', plainText: 'Queued through SQL' }),
          testIds.pageId,
          testIds.propertyA,
        )
      } finally {
        db.close()
      }

      const dryRunIntents = replicaChangesToPlannerIntents({
        changes: readPendingReplicaChanges(replicaPath),
        replicaPath,
        dryRun: true,
      })
      expect(dryRunIntents).toHaveLength(1)
      const pendingAfterDryRun = readPendingReplicaChanges(replicaPath)
      expect(pendingAfterDryRun).toHaveLength(1)
      expect(statusFor(replicaPath, pendingAfterDryRun[0]?.changeId ?? '')).toMatchObject({
        status: 'pending',
      })
      expect(cellChangeFor(replicaPath, pendingAfterDryRun[0]?.changeId ?? '')).toMatchObject({
        status: 'pending',
      })

      const lifecycleDb = new DatabaseSync(replicaPath)
      try {
        lifecycleDb
          .prepare(`UPDATE notion_cell_changes SET status = 'queued' WHERE change_id = ?`)
          .run(pendingAfterDryRun[0]?.changeId ?? '')
      } finally {
        lifecycleDb.close()
      }
      const queuedChanges = readPendingReplicaChanges(replicaPath)
      expect(queuedChanges).toHaveLength(1)
      expect(queuedChanges[0]).toMatchObject({ status: 'queued' })
      expect(statusFor(replicaPath, queuedChanges[0]?.changeId ?? '')).toMatchObject({
        status: 'queued',
      })

      const intents = replicaChangesToPlannerIntents({
        changes: readPendingReplicaChanges(replicaPath),
        replicaPath,
      })
      expect(intents).toHaveLength(1)
      expect(statusFor(replicaPath, queuedChanges[0]?.changeId ?? '')).toMatchObject({
        status: 'queued',
      })

      const dryRun = await runWithPorts(
        syncOneShot({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          localIntents: intents,
          dryRun: true,
          now: clock.now,
        }),
        { gateway: gateway.gateway },
      )
      expect(dryRun.push.plan.enqueuedCommands).toBe(0)
      expect(gateway.ledger.attemptedPatchPageProperties).toHaveLength(0)

      const applied = await runWithPorts(
        syncOneShot({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          localIntents: intents,
          maxExecutorSteps: 4,
          now: clock.now,
        }),
        { gateway: gateway.gateway },
      )
      expect(applied.push.plan.enqueuedCommands).toBe(1)
      expect(gateway.ledger.successfulPatchPageProperties).toHaveLength(1)
      expect(gateway.ledger.successfulPatchPageProperties[0]?.propertyPatch).toMatchObject({
        [testIds.propertyA]: { _tag: 'title', plainText: 'Queued through SQL' },
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('promotes typed body metadata schema and restore CDC rows into guarded planner intents', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({
      pages: [pageSnapshot({ inTrash: true })],
      propertyPages: [propertyPage('Typed CDC row')],
    })

    try {
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

      const db = new DatabaseSync(replicaPath)
      try {
        const body = db
          .prepare(`SELECT path, current_hash FROM notion_bodies WHERE page_id = ?`)
          .get(testIds.pageId) as { readonly path: string; readonly current_hash: string }
        const dataSource = db
          .prepare(
            `SELECT schema_hash, metadata_hash FROM notion_data_sources WHERE data_source_id = ?`,
          )
          .get(testIds.dataSourceId) as {
          readonly schema_hash: string
          readonly metadata_hash: string
        }

        db.prepare(`UPDATE notion_rows SET in_trash = 0 WHERE page_id = ?`).run(testIds.pageId)
        db.prepare(
          `INSERT INTO notion_body_changes (
             change_id, page_id, body_path, local_body_hash, local_body_content, base_hash
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          'body-row',
          testIds.pageId,
          body.path,
          hash('body-next'),
          '# Typed body change',
          body.current_hash,
        )
        db.prepare(
          `INSERT INTO notion_metadata_changes (
             change_id, data_source_id, resource_type, title_plain_text, base_hash
           ) VALUES (?, ?, 'data_source', ?, ?)`,
        ).run('metadata-row', testIds.dataSourceId, 'Typed CDC title', dataSource.metadata_hash)
        db.prepare(
          `INSERT INTO notion_schema_changes (
             change_id, data_source_id, operation_json, base_hash
           ) VALUES (?, ?, ?, ?)`,
        ).run(
          'schema-row',
          testIds.dataSourceId,
          JSON.stringify({
            _tag: 'AddProperty',
            name: 'Typed notes',
            definition: { _tag: 'rich_text' },
          }),
          dataSource.schema_hash,
        )
      } finally {
        db.close()
      }

      const intents = replicaChangesToPlannerIntents({
        changes: readPendingReplicaChanges(replicaPath),
        replicaPath,
      })
      expect(intents.map((intent) => intent._tag).toSorted()).toEqual([
        'body-edit',
        'data-source-metadata-edit',
        'local-delete',
        'schema-migration',
      ])
      expect(statusFor(replicaPath, 'body-row')).toMatchObject({ status: 'pending' })
      expect(statusFor(replicaPath, 'metadata-row')).toMatchObject({ status: 'pending' })
      expect(statusFor(replicaPath, 'schema-row')).toMatchObject({ status: 'pending' })

      const dryRun = await runWithPorts(
        syncOneShot({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          localIntents: intents,
          dryRun: true,
          now: clock.now,
        }),
        { gateway: gateway.gateway },
      )
      expect(dryRun.push.plan.enqueuedCommands).toBe(0)
      expect(gateway.ledger.successfulRestorePages).toHaveLength(0)
      expect(gateway.ledger.successfulPatchDataSourceMetadata).toHaveLength(0)
      expect(gateway.ledger.successfulPatchDataSourceSchemas).toHaveLength(0)

      const applied = await runWithPorts(
        syncOneShot({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          localIntents: intents,
          maxExecutorSteps: 8,
          now: clock.now,
        }),
        { gateway: gateway.gateway },
      )
      expect(applied.push.plan.enqueuedCommands).toBe(4)
      expect(gateway.ledger.successfulRestorePages).toHaveLength(1)
      expect(gateway.ledger.successfulPatchDataSourceMetadata).toHaveLength(1)
      expect(gateway.ledger.successfulPatchDataSourceSchemas).toHaveLength(1)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('keeps unsafe public CDC surfaces fail-closed with explicit statuses', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Unsafe CDC row')] })

    try {
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

      const db = new DatabaseSync(replicaPath)
      try {
        const dataSource = db
          .prepare(`SELECT metadata_hash FROM notion_data_sources WHERE data_source_id = ?`)
          .get(testIds.dataSourceId) as { readonly metadata_hash: string }
        db.prepare(
          `INSERT INTO notion_metadata_changes (
             change_id, data_source_id, resource_type, description_plain_text, base_hash
           ) VALUES (?, ?, 'data_source', ?, ?)`,
        ).run(
          'metadata-description',
          testIds.dataSourceId,
          'Unsupported data-source description',
          dataSource.metadata_hash,
        )
        db.prepare(
          `INSERT INTO notion_conflict_resolutions (
             resolution_id, conflict_id, action, value_json
           ) VALUES (?, ?, 'manual_value', ?)`,
        ).run(
          'manual-conflict',
          'conflict-1',
          JSON.stringify({ _tag: 'title', plainText: 'Manual' }),
        )
      } finally {
        db.close()
      }

      const intents = replicaChangesToPlannerIntents({
        changes: readPendingReplicaChanges(replicaPath),
        replicaPath,
      })
      expect(intents).toHaveLength(0)
      expect(statusFor(replicaPath, 'metadata-description')).toMatchObject({
        status: 'unsupported',
        unsupported_reason:
          'Notion data-source description writes are not exposed by the data-source update API; use database metadata only after the owning database surface is modeled.',
      })
      expect(statusFor(replicaPath, 'manual-conflict')).toMatchObject({
        status: 'unsupported',
        unsupported_reason:
          'choose_local/manual/retry conflict resolution needs store-backed conflict command execution, not projection patching.',
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('rejects invalid local value payloads and conflicts stale restore status', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({
      propertyPages: [propertyPage('Before invalid edits')],
    })

    try {
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

      const db = new DatabaseSync(replicaPath)
      try {
        db.prepare(
          `INSERT INTO notion_cell_changes (
             change_id, data_source_id, page_id, property_id, value_json
           ) VALUES (?, ?, ?, ?, ?)`,
        ).run('invalid-json', testIds.dataSourceId, testIds.pageId, testIds.propertyA, '{not json')
        db.prepare(
          `INSERT INTO notion_cell_changes (
             change_id, data_source_id, page_id, property_id, value_json, base_hash
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          'stale-base',
          testIds.dataSourceId,
          testIds.pageId,
          testIds.propertyA,
          JSON.stringify({ _tag: 'title', plainText: 'Stale' }),
          hash('stale-base'),
        )
        db.prepare(
          `INSERT INTO notion_row_changes (
             change_id, kind, data_source_id, page_id, base_hash
           ) VALUES (?, 'row_restore', ?, ?, ?)`,
        ).run('restore-unsupported', testIds.dataSourceId, testIds.pageId, hash('restore-base'))
      } finally {
        db.close()
      }

      const intents = replicaChangesToPlannerIntents({
        changes: readPendingReplicaChanges(replicaPath),
        replicaPath,
      })

      expect(intents).toHaveLength(0)
      expect(statusFor(replicaPath, 'invalid-json')).toMatchObject({
        status: 'rejected',
        unsupported_reason: 'value_json is not valid canonical Notion property value JSON.',
      })
      expect(cellChangeFor(replicaPath, 'invalid-json')).toMatchObject({
        status: 'rejected',
        unsupported_reason: 'value_json is not valid canonical Notion property value JSON.',
      })
      expect(statusFor(replicaPath, 'stale-base')).toMatchObject({
        status: 'conflict',
        unsupported_reason: 'Local cell patch has a stale base_hash.',
      })
      expect(cellChangeFor(replicaPath, 'stale-base')).toMatchObject({
        status: 'conflict',
        unsupported_reason: 'Local cell patch has a stale base_hash.',
      })
      expect(statusFor(replicaPath, 'restore-unsupported')).toMatchObject({
        status: 'conflict',
        unsupported_reason: 'Local row lifecycle change has a stale base_hash.',
      })
      expect(rowChangeFor(replicaPath, 'restore-unsupported')).toMatchObject({
        status: 'conflict',
        unsupported_reason: 'Local row lifecycle change has a stale base_hash.',
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('captures direct row lifecycle edits in typed CDC tables', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Lifecycle row')] })

    try {
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

      const db = new DatabaseSync(replicaPath)
      try {
        db.prepare(`UPDATE notion_rows SET in_trash = 1 WHERE page_id = ?`).run(testIds.pageId)
        db.prepare(`UPDATE notion_rows SET in_trash = 0 WHERE page_id = ?`).run(testIds.pageId)
        expect(
          db
            .prepare(
              `SELECT kind, status, unsupported_reason, page_id FROM notion_row_changes ORDER BY created_at`,
            )
            .all(),
        ).toEqual([
          expect.objectContaining({
            kind: 'row_archive',
            status: 'rejected',
            unsupported_reason: 'Superseded by later direct row lifecycle edit.',
            page_id: testIds.pageId,
          }),
        ])
        expect(
          db
            .prepare(
              `SELECT kind, status, unsupported_reason, page_id FROM notion_local_changes ORDER BY created_at`,
            )
            .all(),
        ).toEqual([
          expect.objectContaining({
            kind: 'row_archive',
            status: 'rejected',
            unsupported_reason: 'Superseded by later direct row lifecycle edit.',
            page_id: testIds.pageId,
          }),
        ])
      } finally {
        db.close()
      }

      const intents = replicaChangesToPlannerIntents({
        changes: readPendingReplicaChanges(replicaPath),
        replicaPath,
      })
      expect(intents).toHaveLength(0)

      const rowChanges = new DatabaseSync(replicaPath, { readOnly: true })
      try {
        const statuses = rowChanges
          .prepare(`SELECT kind, status, unsupported_reason FROM notion_row_changes ORDER BY kind`)
          .all()
        expect(statuses).toEqual([
          expect.objectContaining({
            kind: 'row_archive',
            status: 'rejected',
            unsupported_reason: 'Superseded by later direct row lifecycle edit.',
          }),
        ])
      } finally {
        rowChanges.close()
      }
    } finally {
      storeFixture.cleanup()
    }
  })

  it('generates collision-safe escaped view columns for reserved and duplicate property names', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({
      propertyPages: [
        propertyPage('Reserved column', testIds.propertyA),
        propertyPage('Duplicate column', testIds.propertyB),
      ],
    })
    const collidingSchemaProperties = [
      {
        propertyId: testIds.propertyA,
        name: 'select',
        type: 'title',
        configHash: hash('config-a'),
        writeClass: 'writable' as const,
      },
      {
        propertyId: testIds.propertyB,
        name: 'select',
        type: 'title',
        configHash: hash('config-b'),
        writeClass: 'writable' as const,
      },
    ]

    try {
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
          schemaProperties: collidingSchemaProperties,
          now: clock.now,
        }),
        { gateway: gateway.gateway },
      )
      projectReplicaFromSyncStore({
        syncStorePath: storeFixture.path,
        replicaPath,
        rootId: testIds.rootId,
      })

      const db = new DatabaseSync(replicaPath, { readOnly: true })
      try {
        expect(
          db
            .prepare(
              `SELECT "select", "select_prop-b" FROM notion_view_data_source_1 WHERE page_id = ?`,
            )
            .get(testIds.pageId),
        ).toMatchObject({
          select: 'Reserved column',
          'select_prop-b': 'Duplicate column',
        })
      } finally {
        db.close()
      }
    } finally {
      storeFixture.cleanup()
    }
  })

  it('rebuilds the replica from the internal sync store after deleting notion.sqlite', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Rebuild me')] })

    try {
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
      rmSync(replicaPath, { force: true })
      projectReplicaFromSyncStore({
        syncStorePath: storeFixture.path,
        replicaPath,
        rootId: testIds.rootId,
      })

      const db = new DatabaseSync(replicaPath, { readOnly: true })
      try {
        expect(db.prepare(`SELECT value_text FROM notion_cells`).get()).toMatchObject({
          value_text: 'Rebuild me',
        })
      } finally {
        db.close()
      }
    } finally {
      storeFixture.cleanup()
    }
  })
})
