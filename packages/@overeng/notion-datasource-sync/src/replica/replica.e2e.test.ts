import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { propertySurfaceKey } from '../core/canonical.ts'
import { PagePropertyItemPage } from '../core/commands.ts'
import { AbsolutePath, DataSourceViewSnapshot, Hash } from '../core/domain.ts'
import { type SyncEvent as SyncEventType } from '../core/events.ts'
import {
  LocalWorkspacePort,
  NotionDataSourceGateway,
  PageBodySyncPort,
  type NotionDataSourceGatewayShape,
} from '../core/ports.ts'
import { makeConflictRaisedEvent } from '../sync/observation.ts'
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
  applyReplicaConflictResolutions,
  defaultReplicaPath,
  projectReplicaFromSyncStore,
  readPendingReplicaChanges,
  replicaChangesToPlannerIntents,
  settleReplicaChangesAfterSync,
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

const filesPropertyPage = () =>
  decode({
    schema: PagePropertyItemPage,
    value: {
      _tag: 'PagePropertyItemPage',
      apiVersion: '2026-03-11',
      requestId: testIds.requestId,
      pageId: testIds.pageId,
      propertyId: testIds.propertyB,
      items: [
        {
          _tag: 'PagePropertyItem',
          pageId: testIds.pageId,
          propertyId: testIds.propertyB,
          itemHash: hash('item-empty-files'),
          valueHash: hash('property-b-base'),
          valueJson: JSON.stringify({ _tag: 'files', files: [] }),
        },
      ],
      nextCursor: null,
      hasMore: false,
    },
  })

const relationPropertyPage = ({
  pageIds,
  complete = true,
}: {
  readonly pageIds: readonly string[]
  readonly complete?: boolean
}) =>
  decode({
    schema: PagePropertyItemPage,
    value: {
      _tag: 'PagePropertyItemPage',
      apiVersion: '2026-03-11',
      requestId: testIds.requestId,
      pageId: testIds.pageId,
      propertyId: testIds.propertyB,
      items: pageIds.map((pageId, index) => ({
        _tag: 'PagePropertyItem',
        pageId: testIds.pageId,
        propertyId: testIds.propertyB,
        itemHash: hash(`relation-item-${pageId}-${index}`),
        valueHash: hash(`relation-value-${pageId}-${index}`),
        valueJson: JSON.stringify({ id: pageId }),
      })),
      nextCursor: complete === true ? null : 'cursor-next',
      hasMore: complete !== true,
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

const schemaPropertiesWithRelation = [
  ...schemaProperties,
  {
    propertyId: testIds.propertyB,
    name: 'Related',
    type: 'relation',
    configHash: hash('config-relation'),
    writeClass: 'writable' as const,
  },
]

const viewSnapshot = () =>
  decode({
    schema: DataSourceViewSnapshot,
    value: {
      _tag: 'DataSourceViewSnapshot',
      viewId: 'view-alpha',
      databaseId: testIds.databaseId,
      dataSourceId: testIds.dataSourceId,
      requestId: testIds.requestId,
      observedAt: '2026-01-01T00:00:00.000Z',
      name: 'Work queue',
      viewType: 'table',
      viewHash: hash('view-alpha'),
      viewJson: JSON.stringify({
        id: 'view-alpha',
        databaseId: testIds.databaseId,
        dataSourceId: testIds.dataSourceId,
        name: 'Work queue',
        type: 'table',
        filter: null,
        sorts: [],
        configuration: {},
      }),
    },
  })

const schemaPropertiesWithFiles = [
  ...schemaProperties,
  {
    propertyId: testIds.propertyB,
    name: 'Attachments',
    type: 'files',
    configHash: hash('config-b'),
    writeClass: 'writable' as const,
  },
]

const conflictEvent = (): SyncEventType =>
  makeConflictRaisedEvent({
    rootId: testIds.rootId,
    pageId: testIds.pageId,
    propertyId: testIds.propertyA,
    surface: propertySurfaceKey({ pageId: testIds.pageId, propertyId: testIds.propertyA }),
    baseHash: hash('property-a-base'),
    localHash: hash('property-a-local'),
    remoteHash: hash('property-a-remote'),
    conflictKind: 'property',
    message: 'Local and remote changed the same property',
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  })

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

const rowCreateFor = (replicaPath: string, changeId: string) => {
  const db = new DatabaseSync(replicaPath, { readOnly: true })
  try {
    return db.prepare(`SELECT * FROM notion_row_creates WHERE change_id = ?`).get(changeId)
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
    const gateway = makeFakeGatewayHarness({
      propertyPages: [propertyPage('Initial task')],
      views: [viewSnapshot()],
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
        expect(
          db
            .prepare(
              `SELECT view_name, view_type, view_hash
               FROM notion_views
               WHERE data_source_id = ?`,
            )
            .get(testIds.dataSourceId),
        ).toMatchObject({
          view_name: 'Work queue',
          view_type: 'table',
          view_hash: hash('view-alpha'),
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
        expect(statusFor(replicaPath, 'change-create')).toMatchObject({ status: 'pending' })
        expect(rowChangeFor(replicaPath, 'change-create')).toMatchObject({
          status: 'pending',
        })
      } finally {
        after.close()
      }
    } finally {
      storeFixture.cleanup()
    }
  })

  it('promotes relation removals only from complete paginated base values', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const baseRelationPageIds = Array.from({ length: 30 }, (_, index) => `related-${index}`)
    const desiredRelationPageIds = baseRelationPageIds.slice(0, 29)
    const gateway = makeFakeGatewayHarness({
      propertyPages: [
        propertyPage('Relation row'),
        relationPropertyPage({ pageIds: baseRelationPageIds }),
      ],
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
          schemaProperties: schemaPropertiesWithRelation,
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
        expect(
          db
            .prepare(
              `SELECT availability, value_json
               FROM notion_cells
               WHERE page_id = ? AND property_id = ?`,
            )
            .get(testIds.pageId, testIds.propertyB),
        ).toMatchObject({
          availability: 'complete',
          value_json: JSON.stringify({ _tag: 'relation', pageIds: baseRelationPageIds }),
        })
        db.prepare(
          `UPDATE notion_cells SET value_json = ? WHERE page_id = ? AND property_id = ?`,
        ).run(
          JSON.stringify({ _tag: 'relation', pageIds: desiredRelationPageIds }),
          testIds.pageId,
          testIds.propertyB,
        )
      } finally {
        db.close()
      }

      const changes = readPendingReplicaChanges(replicaPath)
      const intents = replicaChangesToPlannerIntents({ changes, replicaPath })
      expect(intents).toEqual([
        expect.objectContaining({
          _tag: 'property-edit',
          pageId: testIds.pageId,
          propertyId: testIds.propertyB,
        }),
      ])

      const applied = await runWithPorts(
        syncOneShot({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties: schemaPropertiesWithRelation,
          localIntents: intents,
          maxExecutorSteps: 4,
          now: clock.now,
        }),
        { gateway: gateway.gateway },
      )
      settleReplicaChangesAfterSync({
        changes,
        replicaPath,
        store: storeFixture.store,
        rootId: testIds.rootId,
        decisions: applied.push.plan.decisions,
      })
      expect(gateway.ledger.successfulPatchPageProperties).toHaveLength(1)
      expect(gateway.ledger.successfulPatchPageProperties[0]?.propertyPatch).toEqual({
        [testIds.propertyB]: { _tag: 'relation', pageIds: desiredRelationPageIds },
      })
      expect(cellChangeFor(replicaPath, changes[0]?.changeId ?? '')).toMatchObject({
        status: 'applied',
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('keeps unsafe relation additions and incomplete bases fail-closed', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({
      propertyPages: [
        propertyPage('Relation row'),
        relationPropertyPage({ pageIds: ['related-1', 'related-2'], complete: false }),
      ],
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
          schemaProperties: schemaPropertiesWithRelation,
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
          `UPDATE notion_cells
           SET availability = 'paginated-incomplete'
           WHERE page_id = ? AND property_id = ?`,
        ).run(testIds.pageId, testIds.propertyB)
        expect(() =>
          db.prepare(
            `UPDATE notion_cells SET value_json = ? WHERE page_id = ? AND property_id = ?`,
          ).run(
            JSON.stringify({ _tag: 'relation', pageIds: ['related-1'] }),
            testIds.pageId,
            testIds.propertyB,
          ),
        ).toThrow(/complete observed base/u)
        db.prepare(
          `INSERT INTO notion_cell_changes (
             change_id, data_source_id, page_id, property_id, value_json
           ) VALUES (?, ?, ?, ?, ?)`,
        ).run(
          'relation-incomplete',
          testIds.dataSourceId,
          testIds.pageId,
          testIds.propertyB,
          JSON.stringify({ _tag: 'relation', pageIds: ['related-1'] }),
        )
      } finally {
        db.close()
      }

      let changes = readPendingReplicaChanges(replicaPath)
      expect(replicaChangesToPlannerIntents({ changes, replicaPath })).toHaveLength(0)
      expect(cellChangeFor(replicaPath, changes[0]?.changeId ?? '')).toMatchObject({
        status: 'unsupported',
        unsupported_reason:
          'Relation writes require a complete paginated base value before replacement-shaped writes are safe.',
      })

      const completeWorkspace = tempWorkspace()
      const completeReplicaPath = defaultReplicaPath(completeWorkspace)
      const completeStoreFixture = makeStoreFixture({ mode: 'file', now: clock.now })
      const completeGateway = makeFakeGatewayHarness({
        propertyPages: [
          propertyPage('Relation row'),
          relationPropertyPage({ pageIds: ['related-1', 'related-2'] }),
        ],
      })
      try {
        initOneShotSync({
          store: completeStoreFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot: completeWorkspace,
          now: clock.now,
        })
        await runWithPorts(
          pullOneShotSync({
            store: completeStoreFixture.store,
            rootId: testIds.rootId,
            dataSourceId: testIds.dataSourceId,
            workspaceRoot: completeWorkspace,
            queryContract: defaultQueryContract(),
            schemaProperties: schemaPropertiesWithRelation,
            now: clock.now,
          }),
          { gateway: completeGateway.gateway },
        )
        projectReplicaFromSyncStore({
          syncStorePath: completeStoreFixture.path,
          replicaPath: completeReplicaPath,
          rootId: testIds.rootId,
        })
        const completeDb = new DatabaseSync(completeReplicaPath)
        try {
          expect(() =>
            completeDb
              .prepare(
                `UPDATE notion_cells SET value_json = ? WHERE page_id = ? AND property_id = ?`,
              )
              .run(
                JSON.stringify({ _tag: 'relation', pageIds: ['related-1', 'new-related'] }),
                testIds.pageId,
                testIds.propertyB,
              ),
          ).toThrow(/may only remove/u)
          completeDb
            .prepare(
              `INSERT INTO notion_cell_changes (
                 change_id, data_source_id, page_id, property_id, value_json
               ) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              'relation-add',
              testIds.dataSourceId,
              testIds.pageId,
              testIds.propertyB,
              JSON.stringify({ _tag: 'relation', pageIds: ['related-1', 'new-related'] }),
            )
        } finally {
          completeDb.close()
        }
        changes = readPendingReplicaChanges(completeReplicaPath)
        expect(
          replicaChangesToPlannerIntents({ changes, replicaPath: completeReplicaPath }),
        ).toHaveLength(0)
        expect(cellChangeFor(completeReplicaPath, 'relation-add')).toMatchObject({
          status: 'unsupported',
          unsupported_reason:
            'Adding new relation targets remains fail-closed until target accessibility is modeled; safe relation writes may remove or reorder fully observed targets only.',
        })
        const capDb = new DatabaseSync(completeReplicaPath)
        try {
          capDb
            .prepare(
              `INSERT INTO notion_cell_changes (
                 change_id, data_source_id, page_id, property_id, value_json
               ) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              'relation-cap',
              testIds.dataSourceId,
              testIds.pageId,
              testIds.propertyB,
              JSON.stringify({
                _tag: 'relation',
                pageIds: Array.from({ length: 101 }, (_, index) => `related-${index}`),
              }),
            )
        } finally {
          capDb.close()
        }
        changes = readPendingReplicaChanges(completeReplicaPath)
        expect(replicaChangesToPlannerIntents({ changes, replicaPath: completeReplicaPath }))
          .toHaveLength(0)
        expect(cellChangeFor(completeReplicaPath, 'relation-cap')).toMatchObject({
          status: 'unsupported',
          unsupported_reason: 'Relation writes are capped at 100 related pages by the Notion API.',
        })
      } finally {
        completeStoreFixture.cleanup()
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

  it('creates rows through the explicit public row-create CDC table with idempotent settlement', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Existing row')] })

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
        expect(() =>
          db
            .prepare(
              `INSERT INTO notion_rows (
               data_source_id, page_id, properties_hash, in_trash, moved_out,
               local_delete_candidate, observed_event_id, updated_at
             ) VALUES (?, 'local-row', ?, 0, 0, 0, 'event', ?)`,
            )
            .run(testIds.dataSourceId, hash('local'), new Date().toISOString()),
        ).toThrow(/insert into notion_row_creates/)

        const source = db
          .prepare(`SELECT schema_hash FROM notion_data_sources WHERE data_source_id = ?`)
          .get(testIds.dataSourceId) as { schema_hash: string }
        db.prepare(
          `INSERT INTO notion_row_creates (
             change_id,
             data_source_id,
             local_row_id,
             client_request_key,
             initial_values_json,
             base_schema_hash
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          'create-1',
          testIds.dataSourceId,
          'local-create-1',
          'client-create-1',
          JSON.stringify({
            [testIds.propertyA]: { _tag: 'title', plainText: 'Created through SQLite' },
          }),
          source.schema_hash,
        )
        expect(
          db
            .prepare(
              `SELECT local_row_id, sync_status FROM notion_rows_effective WHERE local_row_id = ?`,
            )
            .get('local-create-1'),
        ).toMatchObject({ local_row_id: 'local-create-1', sync_status: 'pending' })
      } finally {
        db.close()
      }

      const dryRunChanges = readPendingReplicaChanges(replicaPath)
      const dryRunIntents = replicaChangesToPlannerIntents({
        changes: dryRunChanges,
        replicaPath,
        dryRun: true,
      })
      expect(dryRunIntents).toHaveLength(1)
      expect(dryRunIntents[0]).toMatchObject({ _tag: 'row-create' })
      expect(rowCreateFor(replicaPath, 'create-1')).toMatchObject({ status: 'pending' })
      expect(
        storeFixture.store
          .readOutbox(testIds.rootId)
          .filter((row) => row.commandTag === 'CreatePage'),
      ).toHaveLength(0)

      const changes = readPendingReplicaChanges(replicaPath)
      const intents = replicaChangesToPlannerIntents({ changes, replicaPath })
      const result = await runWithPorts(
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
      settleReplicaChangesAfterSync({
        changes,
        replicaPath,
        store: storeFixture.store,
        rootId: testIds.rootId,
        decisions: result.push.plan.decisions,
      })
      expect(result.push.plan.enqueuedCommands).toBe(1)
      expect(rowCreateFor(replicaPath, 'create-1')).toMatchObject({
        status: 'applied',
        remote_page_id: 'fake-created-client-create-1',
      })

      const rerunChanges = readPendingReplicaChanges(replicaPath)
      expect(rerunChanges).toHaveLength(0)
      const outbox = storeFixture.store
        .readOutbox(testIds.rootId)
        .filter((row) => row.commandTag === 'CreatePage')
      expect(outbox).toHaveLength(1)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('surfaces expired running row-create commands as reconciliation-required without retrying create', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Existing row')] })
    const createPageCalls: string[] = []
    const countingGateway: NotionDataSourceGatewayShape = {
      ...gateway.gateway,
      createPage: (command) =>
        Effect.sync(() => {
          createPageCalls.push(command.commandId)
        }).pipe(Effect.zipRight(gateway.gateway.createPage(command))),
    }

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
        { gateway: countingGateway },
      )
      projectReplicaFromSyncStore({
        syncStorePath: storeFixture.path,
        replicaPath,
        rootId: testIds.rootId,
      })

      const db = new DatabaseSync(replicaPath)
      try {
        const source = db
          .prepare(`SELECT schema_hash FROM notion_data_sources WHERE data_source_id = ?`)
          .get(testIds.dataSourceId) as { schema_hash: string }
        db.prepare(
          `INSERT INTO notion_row_creates (
             change_id,
             data_source_id,
             local_row_id,
             client_request_key,
             initial_values_json,
             base_schema_hash
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          'create-ambiguous',
          testIds.dataSourceId,
          'local-create-ambiguous',
          'client-create-ambiguous',
          JSON.stringify({
            [testIds.propertyA]: { _tag: 'title', plainText: 'Ambiguous create' },
          }),
          source.schema_hash,
        )
      } finally {
        db.close()
      }

      const changes = readPendingReplicaChanges(replicaPath)
      const intents = replicaChangesToPlannerIntents({ changes, replicaPath })
      const enqueueResult = await runWithPorts(
        syncOneShot({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          localIntents: intents,
          maxExecutorSteps: 0,
          now: clock.now,
        }),
        { gateway: countingGateway },
      )
      settleReplicaChangesAfterSync({
        changes,
        replicaPath,
        store: storeFixture.store,
        rootId: testIds.rootId,
        decisions: enqueueResult.push.plan.decisions,
      })
      expect(rowCreateFor(replicaPath, 'create-ambiguous')).toMatchObject({ status: 'planned' })

      const outbox = storeFixture.store
        .readOutbox(testIds.rootId)
        .find((row) => row.commandId === 'replica:create-ambiguous')
      expect(outbox).toBeDefined()
      if (outbox === undefined) throw new Error('expected row-create outbox row')

      const running = storeFixture.store.claimNextOutboxCommand({
        rootId: testIds.rootId,
        leaseToken: 'lease-create-1',
        leaseDurationMs: 60_000,
      })
      expect(running).toMatchObject({
        commandId: 'replica:create-ambiguous',
        attemptState: 'running',
      })
      expect(createPageCalls).toHaveLength(0)

      clock.advanceMillis(1)
      const rerunChanges = readPendingReplicaChanges(replicaPath)
      const rerunIntents = replicaChangesToPlannerIntents({
        changes: rerunChanges,
        replicaPath,
      })
      const rerun = await runWithPorts(
        syncOneShot({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          localIntents: rerunIntents,
          maxExecutorSteps: 1,
          leaseToken: 'lease-create-2',
          leaseDurationMs: 0,
          now: clock.now,
        }),
        { gateway: countingGateway },
      )
      settleReplicaChangesAfterSync({
        changes: rerunChanges,
        replicaPath,
        store: storeFixture.store,
        rootId: testIds.rootId,
        decisions: rerun.push.plan.decisions,
      })

      expect(createPageCalls).toHaveLength(0)
      expect(rerun.push.executor.results).toMatchObject([
        {
          _tag: 'failed',
          commandId: 'replica:create-ambiguous',
          attemptState: 'ambiguous',
        },
      ])
      expect(
        storeFixture.store
          .readOutbox(testIds.rootId)
          .find((row) => row.commandId === 'replica:create-ambiguous'),
      ).toMatchObject({ state: 'ambiguous' })
      expect(rowCreateFor(replicaPath, 'create-ambiguous')).toMatchObject({
        status: 'needs_reconciliation',
        remote_page_id: null,
      })
      expect(statusFor(replicaPath, 'create-ambiguous')).toMatchObject({
        status: 'needs_reconciliation',
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('guards invalid row-create payloads, stale schema hashes, unsupported values, and remote-page reconciliation states', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Existing row')] })

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
        const source = db
          .prepare(`SELECT schema_hash FROM notion_data_sources WHERE data_source_id = ?`)
          .get(testIds.dataSourceId) as { schema_hash: string }
        const insertCreate = db.prepare(
          `INSERT INTO notion_row_creates (
             change_id, data_source_id, local_row_id, client_request_key,
             initial_values_json, base_schema_hash, status, remote_page_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        insertCreate.run(
          'create-invalid-payload',
          testIds.dataSourceId,
          'local-invalid',
          'client-invalid',
          JSON.stringify({
            [testIds.propertyA]: { _tag: 'title', plainText: 42 },
          }),
          source.schema_hash,
          'pending',
          null,
        )
        insertCreate.run(
          'create-stale-schema',
          testIds.dataSourceId,
          'local-stale',
          'client-stale',
          JSON.stringify({
            [testIds.propertyA]: { _tag: 'title', plainText: 'Stale schema' },
          }),
          hash('stale-schema'),
          'pending',
          null,
        )
        insertCreate.run(
          'create-unsupported-files',
          testIds.dataSourceId,
          'local-files',
          'client-files',
          JSON.stringify({
            [testIds.propertyA]: { _tag: 'title', plainText: 'Unsupported files' },
            [testIds.propertyB]: {
              _tag: 'computed',
              valueHash: hash('computed'),
            },
          }),
          source.schema_hash,
          'pending',
          null,
        )
        insertCreate.run(
          'create-reconcile',
          testIds.dataSourceId,
          'local-reconcile',
          'client-reconcile',
          JSON.stringify({
            [testIds.propertyA]: { _tag: 'title', plainText: 'Already remote' },
          }),
          source.schema_hash,
          'needs_reconciliation',
          'remote-created-page',
        )
      } finally {
        db.close()
      }

      const changes = readPendingReplicaChanges(replicaPath)
      const intents = replicaChangesToPlannerIntents({ changes, replicaPath })
      expect(intents).toHaveLength(0)
      expect(rowCreateFor(replicaPath, 'create-invalid-payload')).toMatchObject({
        status: 'rejected',
      })
      expect(rowCreateFor(replicaPath, 'create-stale-schema')).toMatchObject({
        status: 'conflict',
      })
      expect(rowCreateFor(replicaPath, 'create-unsupported-files')).toMatchObject({
        status: 'unsupported',
      })
      expect(rowCreateFor(replicaPath, 'create-reconcile')).toMatchObject({
        status: 'planned',
        remote_page_id: 'remote-created-page',
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('marks a settled row-create command without a durable page id as needing reconciliation', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Existing row')] })

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
        const source = db
          .prepare(`SELECT schema_hash FROM notion_data_sources WHERE data_source_id = ?`)
          .get(testIds.dataSourceId) as { schema_hash: string }
        db.prepare(
          `INSERT INTO notion_row_creates (
             change_id, data_source_id, local_row_id, client_request_key,
             initial_values_json, base_schema_hash
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          'create-no-page-id',
          testIds.dataSourceId,
          'local-no-page-id',
          'client-no-page-id',
          JSON.stringify({
            [testIds.propertyA]: { _tag: 'title', plainText: 'Missing page id' },
          }),
          source.schema_hash,
        )
      } finally {
        db.close()
      }

      const changes = readPendingReplicaChanges(replicaPath)
      const intents = replicaChangesToPlannerIntents({ changes, replicaPath })
      const result = await runWithPorts(
        syncOneShot({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          localIntents: intents,
          maxExecutorSteps: 0,
          now: clock.now,
        }),
        { gateway: gateway.gateway },
      )
      const decision = result.push.plan.decisions.find(
        (candidate) => candidate._tag === 'EnqueueCommands',
      )
      expect(decision?._tag).toBe('EnqueueCommands')
      if (decision?._tag !== 'EnqueueCommands') throw new Error('expected row-create command')
      const command = decision.commands[0]
      expect(command).toBeDefined()
      if (command === undefined) throw new Error('expected row-create command')
      const outbox = storeFixture.store
        .readOutbox(testIds.rootId)
        .find((row) => row.commandId === command.commandId)
      expect(outbox).toBeDefined()
      if (outbox === undefined) throw new Error('expected row-create outbox row')
      const desiredHash = decode({ schema: Hash, value: outbox.desiredHash })
      storeFixture.store.appendOutboxAttemptState({
        rootId: testIds.rootId,
        commandId: command.commandId,
        commandKey: command.commandKey,
        surface: command.surface,
        attempt: 1,
        attemptState: 'running',
      })
      storeFixture.store.appendOutboxSettlement({
        rootId: testIds.rootId,
        commandId: command.commandId,
        commandKey: command.commandKey,
        surface: command.surface,
        commandTag: 'CreatePage',
        requestId: testIds.requestId,
        desiredHash,
        observedHash: desiredHash,
        settlementKind: 'verified-success',
      })

      settleReplicaChangesAfterSync({
        changes,
        replicaPath,
        store: storeFixture.store,
        rootId: testIds.rootId,
        decisions: result.push.plan.decisions,
      })

      expect(rowCreateFor(replicaPath, 'create-no-page-id')).toMatchObject({
        status: 'needs_reconciliation',
        remote_page_id: null,
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('promotes typed body metadata database metadata schema and restore CDC rows into guarded planner intents', async () => {
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
        const database = db
          .prepare(
            `SELECT database_id, metadata_hash FROM notion_databases WHERE data_source_id = ?`,
          )
          .get(testIds.dataSourceId) as {
          readonly database_id: string
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
          hash('# Typed body change'),
          '# Typed body change',
          body.current_hash,
        )
        db.prepare(
          `INSERT INTO notion_metadata_changes (
             change_id, data_source_id, database_id, resource_type, title_plain_text,
             description_plain_text, base_hash
           ) VALUES (?, ?, ?, 'database', ?, ?, ?)`,
        ).run(
          'database-metadata-row',
          testIds.dataSourceId,
          database.database_id,
          'Typed database title',
          'Typed database description',
          database.metadata_hash,
        )
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
        'database-metadata-edit',
        'local-delete',
      ])
      expect(statusFor(replicaPath, 'body-row')).toMatchObject({ status: 'pending' })
      expect(statusFor(replicaPath, 'database-metadata-row')).toMatchObject({ status: 'pending' })
      expect(statusFor(replicaPath, 'schema-row')).toMatchObject({
        status: 'unsupported',
        unsupported_reason:
          'Public schema CDC needs expected post-schema hash reconciliation before remote execution; use the dedicated schema command path until that projection exists.',
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
      expect(gateway.ledger.successfulRestorePages).toHaveLength(0)
      expect(gateway.ledger.successfulPatchDataSourceMetadata).toHaveLength(0)
      expect(gateway.ledger.successfulPatchDatabaseMetadata).toHaveLength(0)
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
      expect(applied.push.plan.enqueuedCommands).toBe(3)
      expect(gateway.ledger.successfulRestorePages).toHaveLength(1)
      expect(gateway.ledger.successfulPatchDataSourceMetadata).toHaveLength(0)
      expect(gateway.ledger.successfulPatchDatabaseMetadata).toHaveLength(1)
      expect(gateway.ledger.successfulPatchDataSourceSchemas).toHaveLength(0)
      settleReplicaChangesAfterSync({
        changes: readPendingReplicaChanges(replicaPath),
        replicaPath,
        store: storeFixture.store,
        rootId: testIds.rootId,
        decisions: applied.push.plan.decisions,
      })
      expect(statusFor(replicaPath, 'body-row')).toMatchObject({ status: 'applied' })
      expect(statusFor(replicaPath, 'database-metadata-row')).toMatchObject({ status: 'applied' })
      expect(statusFor(replicaPath, 'schema-row')).toMatchObject({ status: 'unsupported' })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('promotes external URL file attachment CDC through typed staging tables', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({
      propertyPages: [propertyPage('File row'), filesPropertyPage()],
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
          schemaProperties: schemaPropertiesWithFiles,
          now: clock.now,
        }),
        { gateway: gateway.gateway },
      )
      projectReplicaFromSyncStore({
        syncStorePath: storeFixture.path,
        replicaPath,
        rootId: testIds.rootId,
      })

      const externalUrl = 'https://example.com/datasource-sync-fixture.txt'
      const db = new DatabaseSync(replicaPath)
      try {
        const cell = db
          .prepare(`SELECT base_hash FROM notion_cells WHERE page_id = ? AND property_id = ?`)
          .get(testIds.pageId, testIds.propertyB) as { readonly base_hash: string }
        db.prepare(
          `INSERT INTO notion_file_assets (
             asset_id, source_type, name, external_url
           ) VALUES (?, 'external_url', ?, ?)`,
        ).run('asset-external-1', 'fixture.txt', externalUrl)
        db.prepare(
          `INSERT INTO notion_file_changes (
             change_id, asset_id, action, data_source_id, page_id, property_id, base_hash
           ) VALUES (?, ?, 'attach_external_url', ?, ?, ?, ?)`,
        ).run(
          'file-attach-1',
          'asset-external-1',
          testIds.dataSourceId,
          testIds.pageId,
          testIds.propertyB,
          cell.base_hash,
        )
      } finally {
        db.close()
      }

      const changes = readPendingReplicaChanges(replicaPath)
      const intents = replicaChangesToPlannerIntents({ changes, replicaPath })
      expect(intents.map((intent) => intent._tag)).toEqual(['property-edit'])
      expect(intents[0]).toMatchObject({
        _tag: 'property-edit',
        propertyId: testIds.propertyB,
        command: {
          propertyPatch: {
            [testIds.propertyB]: {
              _tag: 'files',
              files: [
                expect.objectContaining({
                  name: 'fixture.txt',
                  externalUrl,
                }),
              ],
            },
          },
        },
      })

      const dryRun = await runWithPorts(
        syncOneShot({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties: schemaPropertiesWithFiles,
          localIntents: intents,
          dryRun: true,
          now: clock.now,
        }),
        { gateway: gateway.gateway },
      )
      expect(dryRun.push.plan.enqueuedCommands).toBe(0)
      expect(gateway.ledger.successfulPatchPageProperties).toHaveLength(0)
      expect(statusFor(replicaPath, 'file-attach-1')).toMatchObject({ status: 'pending' })

      const applied = await runWithPorts(
        syncOneShot({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties: schemaPropertiesWithFiles,
          localIntents: intents,
          maxExecutorSteps: 4,
          now: clock.now,
        }),
        { gateway: gateway.gateway },
      )
      expect(applied.push.plan.enqueuedCommands).toBe(1)
      expect(gateway.ledger.successfulPatchPageProperties).toHaveLength(1)
      settleReplicaChangesAfterSync({
        changes: readPendingReplicaChanges(replicaPath),
        replicaPath,
        store: storeFixture.store,
        rootId: testIds.rootId,
        decisions: applied.push.plan.decisions,
      })
      expect(statusFor(replicaPath, 'file-attach-1')).toMatchObject({
        status: 'applied',
        unsupported_reason: null,
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('fails closed for external URL file attachments against non-empty file cells', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({
      propertyPages: [propertyPage('File row'), filesPropertyPage()],
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
          schemaProperties: schemaPropertiesWithFiles,
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
        const cell = db
          .prepare(`SELECT base_hash FROM notion_cells WHERE page_id = ? AND property_id = ?`)
          .get(testIds.pageId, testIds.propertyB) as { readonly base_hash: string }
        db.prepare(
          `UPDATE notion_cells
           SET value_json = ?
           WHERE page_id = ? AND property_id = ?`,
        ).run(
          JSON.stringify({
            _tag: 'files',
            files: [
              {
                _tag: 'CanonicalFileValue',
                name: 'existing.txt',
                identityHash: hash('existing-file'),
              },
            ],
          }),
          testIds.pageId,
          testIds.propertyB,
        )
        db.prepare(
          `INSERT INTO notion_file_assets (
             asset_id, source_type, name, external_url
           ) VALUES (?, 'external_url', ?, ?)`,
        ).run('asset-external-raw', 'fixture.txt', 'https://example.com/fixture.txt')
        db.prepare(
          `INSERT INTO notion_file_changes (
             change_id, asset_id, action, data_source_id, page_id, property_id, base_hash
           ) VALUES (?, ?, 'attach_external_url', ?, ?, ?, ?)`,
        ).run(
          'file-attach-raw',
          'asset-external-raw',
          testIds.dataSourceId,
          testIds.pageId,
          testIds.propertyB,
          cell.base_hash,
        )
      } finally {
        db.close()
      }

      const intents = replicaChangesToPlannerIntents({
        changes: readPendingReplicaChanges(replicaPath),
        replicaPath,
      })
      expect(intents).toEqual([])
      expect(statusFor(replicaPath, 'file-attach-raw')).toMatchObject({
        status: 'unsupported',
        unsupported_reason:
          'External file attach is supported only for empty files properties until durable preservation of existing file identities is modeled.',
      })
      expect(gateway.ledger.successfulPatchPageProperties).toHaveLength(0)
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
        const fileCell = db
          .prepare(`SELECT base_hash FROM notion_cells WHERE page_id = ? AND property_id = ?`)
          .get(testIds.pageId, testIds.propertyA) as { readonly base_hash: string }
        db.prepare(
          `INSERT INTO notion_metadata_changes (
             change_id, data_source_id, resource_type, description_plain_text, base_hash
           ) VALUES (?, ?, 'database', ?, ?)`,
        ).run(
          'database-metadata-missing-id',
          testIds.dataSourceId,
          'Unsupported database metadata',
          hash('database-metadata-base'),
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
        db.prepare(
          `INSERT INTO notion_file_assets (
             asset_id, source_type, name, content_hash, status
           ) VALUES (?, 'local_upload', ?, ?, 'pending_upload')`,
        ).run('local-upload-asset', 'local.txt', hash('local-file'))
        db.prepare(
          `INSERT INTO notion_file_changes (
             change_id, asset_id, action, data_source_id, page_id, property_id, base_hash
           ) VALUES (?, ?, 'attach_upload', ?, ?, ?, ?)`,
        ).run(
          'local-upload-file-change',
          'local-upload-asset',
          testIds.dataSourceId,
          testIds.pageId,
          testIds.propertyA,
          fileCell.base_hash,
        )
      } finally {
        db.close()
      }

      const intents = replicaChangesToPlannerIntents({
        changes: readPendingReplicaChanges(replicaPath),
        replicaPath,
      })
      expect(intents).toHaveLength(0)
      expect(statusFor(replicaPath, 'database-metadata-missing-id')).toMatchObject({
        status: 'rejected',
        unsupported_reason: 'database metadata_patch requires database_id.',
      })
      expect(statusFor(replicaPath, 'manual-conflict')).toMatchObject({
        status: 'unsupported',
        unsupported_reason:
          'Conflict resolution CDC requires store-backed execution; sync <workspace> handles it before planner-intent conversion.',
      })
      expect(statusFor(replicaPath, 'local-upload-file-change')).toMatchObject({
        status: 'unsupported',
        unsupported_reason:
          'Only external URL file attachments are supported; local uploads need upload-id/status/retry modeling.',
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('applies safe conflict-resolution CDC through store-backed user commands', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Conflict row')] })

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
      const conflict = storeFixture.store.appendEvent(conflictEvent())
      projectReplicaFromSyncStore({
        syncStorePath: storeFixture.path,
        replicaPath,
        rootId: testIds.rootId,
      })

      const db = new DatabaseSync(replicaPath)
      try {
        db.prepare(
          `INSERT INTO notion_conflict_resolutions (
             resolution_id, conflict_id, action
           ) VALUES (?, ?, 'choose_remote')`,
        ).run('choose-remote-conflict', conflict.eventId)
      } finally {
        db.close()
      }

      const changes = readPendingReplicaChanges(replicaPath)
      applyReplicaConflictResolutions({
        changes,
        replicaPath,
        store: storeFixture.store,
        rootId: testIds.rootId,
      })

      expect(statusFor(replicaPath, 'choose-remote-conflict')).toMatchObject({
        status: 'applied',
      })
      expect(storeFixture.store.readConflicts(testIds.rootId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ conflictId: conflict.eventId, state: 'resolved' }),
        ]),
      )
    } finally {
      storeFixture.cleanup()
    }
  })

  it('fails closed for body hash mismatches and settles stale remote-write CDC as conflicts', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Stale CDC row')] })

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
        db.prepare(
          `INSERT INTO notion_body_changes (
             change_id, page_id, body_path, local_body_hash, local_body_content, base_hash
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          'body-mismatch',
          testIds.pageId,
          body.path,
          hash('not-the-content'),
          '# Actual body content',
          body.current_hash,
        )
        db.prepare(
          `INSERT INTO notion_metadata_changes (
             change_id, data_source_id, resource_type, title_plain_text, base_hash
           ) VALUES (?, ?, 'data_source', ?, ?)`,
        ).run('metadata-stale', testIds.dataSourceId, 'Stale title', hash('stale-metadata'))
        db.prepare(
          `INSERT INTO notion_schema_changes (
             change_id, data_source_id, operation_json, base_hash
           ) VALUES (?, ?, ?, ?)`,
        ).run(
          'schema-stale',
          testIds.dataSourceId,
          JSON.stringify({
            _tag: 'AddProperty',
            name: 'Stale schema notes',
            definition: { _tag: 'rich_text' },
          }),
          hash('stale-schema'),
        )
        db.prepare(
          `INSERT INTO notion_schema_changes (
             change_id, data_source_id, operation_json, base_hash
           ) VALUES (?, ?, ?, ?)`,
        ).run(
          'schema-unsupported',
          testIds.dataSourceId,
          JSON.stringify({ _tag: 'DeleteProperty', propertyId: testIds.propertyA }),
          hash('schema-base'),
        )
      } finally {
        db.close()
      }

      const changes = readPendingReplicaChanges(replicaPath)
      const intents = replicaChangesToPlannerIntents({ changes, replicaPath })
      expect(intents).toHaveLength(0)
      expect(statusFor(replicaPath, 'body-mismatch')).toMatchObject({
        status: 'rejected',
        unsupported_reason: 'body_patch local_body_content does not match local_body_hash.',
      })
      expect(statusFor(replicaPath, 'metadata-stale')).toMatchObject({
        status: 'conflict',
        unsupported_reason: 'metadata_patch has a stale base_hash.',
      })
      expect(statusFor(replicaPath, 'schema-stale')).toMatchObject({
        status: 'unsupported',
        unsupported_reason:
          'Public schema CDC needs expected post-schema hash reconciliation before remote execution; use the dedicated schema command path until that projection exists.',
      })
      expect(statusFor(replicaPath, 'schema-unsupported')).toMatchObject({
        status: 'unsupported',
        unsupported_reason:
          'Public schema CDC needs expected post-schema hash reconciliation before remote execution; use the dedicated schema command path until that projection exists.',
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
