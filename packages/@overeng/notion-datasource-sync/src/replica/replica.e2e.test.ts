import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect, Schema } from 'effect'
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
        expect(
          db.prepare(`SELECT count(*) AS count FROM notion_data_sources`).get(),
        ).toMatchObject({ count: 1 })
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
          db.prepare(`SELECT "Task name" FROM notion_view_data_source_1`).get(),
        ).toMatchObject({ 'Task name': 'Initial task' })
      } finally {
        db.close()
      }
    } finally {
      storeFixture.cleanup()
    }
  })

  it('turns local SQL cell edit intents into guarded planner intents and leaves row creation fail closed', async () => {
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
        db.prepare(`UPDATE notion_cells SET value_json = ? WHERE page_id = ? AND property_id = ?`).run(
          JSON.stringify({ _tag: 'title', plainText: 'Direct edit' }),
          testIds.pageId,
          testIds.propertyA,
        )
        expect(
          db
            .prepare(`SELECT value_text FROM notion_cells WHERE page_id = ? AND property_id = ?`)
            .get(testIds.pageId, testIds.propertyA),
        ).toMatchObject({ value_text: 'Direct edit' })
        expect(
          db.prepare(`SELECT "Task name" FROM notion_view_data_source_1 WHERE page_id = ?`).get(testIds.pageId),
        ).toMatchObject({ 'Task name': 'Direct edit' })
        db.prepare(
          `INSERT INTO notion_local_changes (
             change_id, kind, data_source_id, page_id, property_id, value_json
           ) VALUES (?, 'cell_patch', ?, ?, ?, ?)`,
        ).run(
          'change-1',
          testIds.dataSourceId,
          testIds.pageId,
          testIds.propertyA,
          JSON.stringify({ _tag: 'title', plainText: 'After' }),
        )
        db.prepare(
          `INSERT INTO notion_local_changes (
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
      expect(statusFor(replicaPath, changes[0]?.changeId ?? '')).toMatchObject({ status: 'queued' })

      const after = new DatabaseSync(replicaPath, { readOnly: true })
      try {
        expect(statusFor(replicaPath, 'change-create')).toMatchObject({
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
            .prepare(
              `SELECT "Computed score" FROM notion_view_data_source_1 WHERE page_id = ?`,
            )
            .get(testIds.pageId),
        ).toMatchObject({ 'Computed score': 'Computed value' })
        expect(db.prepare(`SELECT count(*) AS count FROM notion_local_changes`).get()).toMatchObject({
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
        db.prepare(`UPDATE notion_cells SET value_json = ? WHERE page_id = ? AND property_id = ?`).run(
          JSON.stringify({ _tag: 'title', plainText: 'Queued through SQL' }),
          testIds.pageId,
          testIds.propertyA,
        )
      } finally {
        db.close()
      }

      const intents = replicaChangesToPlannerIntents({
        changes: readPendingReplicaChanges(replicaPath),
        replicaPath,
      })
      expect(intents).toHaveLength(1)

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

  it('rejects invalid local value payloads and preserves unsupported restore status', async () => {
    const clock = makeFakeClock()
    const workspaceRoot = tempWorkspace()
    const replicaPath = defaultReplicaPath(workspaceRoot)
    const storeFixture = makeStoreFixture({ mode: 'file', now: clock.now })
    const gateway = makeFakeGatewayHarness({ propertyPages: [propertyPage('Before invalid edits')] })

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
          `INSERT INTO notion_local_changes (
             change_id, kind, data_source_id, page_id, property_id, value_json
           ) VALUES (?, 'cell_patch', ?, ?, ?, ?)`,
        ).run(
          'invalid-json',
          testIds.dataSourceId,
          testIds.pageId,
          testIds.propertyA,
          '{not json',
        )
        db.prepare(
          `INSERT INTO notion_local_changes (
             change_id, kind, data_source_id, page_id, property_id, value_json, base_hash
           ) VALUES (?, 'cell_patch', ?, ?, ?, ?, ?)`,
        ).run(
          'stale-base',
          testIds.dataSourceId,
          testIds.pageId,
          testIds.propertyA,
          JSON.stringify({ _tag: 'title', plainText: 'Stale' }),
          hash('stale-base'),
        )
        db.prepare(
          `INSERT INTO notion_local_changes (
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
      expect(statusFor(replicaPath, 'stale-base')).toMatchObject({
        status: 'conflict',
        unsupported_reason: 'Local cell patch has a stale base_hash.',
      })
      expect(statusFor(replicaPath, 'restore-unsupported')).toMatchObject({
        status: 'unsupported',
        unsupported_reason:
          'Row restore needs a dedicated restore planner intent before it can sync from the replica.',
      })
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
            .prepare(`SELECT "select", "select_prop-b" FROM notion_view_data_source_1 WHERE page_id = ?`)
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
