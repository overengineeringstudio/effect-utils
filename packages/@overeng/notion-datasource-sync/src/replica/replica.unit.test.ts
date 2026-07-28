import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createReplicaSchema, readPendingReplicaChanges } from './replica.ts'

type SqlRow = Record<string, unknown>

/** Replica tables that must all be present together after schema creation. */
const expectedReplicaTables = [
  '_nds_replica_data_sources',
  '_nds_replica_databases',
  '_nds_replica_properties',
  '_nds_replica_property_column_plan',
  '_nds_replica_views',
  '_nds_replica_rows',
  '_nds_replica_cells',
  '_nds_replica_relation_targets',
  '_nds_replica_bodies',
  '_nds_replica_cell_changes',
  '_nds_replica_row_changes',
  '_nds_replica_row_creates',
  '_nds_replica_body_changes',
  '_nds_replica_metadata_changes',
  '_nds_replica_schema_changes',
  '_nds_replica_file_assets',
  '_nds_replica_file_changes',
  '_nds_replica_view_changes',
  '_nds_replica_conflict_resolutions',
  '_nds_replica_local_changes',
  '_nds_replica_conflicts',
  '_nds_replica_sync_status',
]

const replicaObjectsOfType = (db: DatabaseSync, type: string): readonly string[] =>
  (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = ? AND name LIKE '_nds_replica_%' ORDER BY name`,
      )
      .all(type) as SqlRow[]
  ).map((row) => row['name'] as string)

const replicaTableSchemaRows = (db: DatabaseSync): readonly SqlRow[] =>
  db
    .prepare(
      `SELECT name, sql
       FROM sqlite_master
       WHERE type = 'table' AND name LIKE '_nds_replica_%'
       ORDER BY name`,
    )
    .all() as SqlRow[]

const encodeJsonBytes = (value: unknown): string => JSON.stringify(value, null, 2)

const jsonWireRoundTrip = (value: unknown) => {
  const encoded = encodeJsonBytes(value)
  const decoded = JSON.parse(encoded) as unknown
  const reencoded = encodeJsonBytes(decoded)

  return {
    encoded,
    decoded,
    reencoded,
    byteIdentical: reencoded === encoded,
  }
}

const sqliteFailure = (write: () => void) => {
  try {
    write()
    return { _tag: 'succeeded' as const }
  } catch (error) {
    return {
      _tag: 'failed' as const,
      name: error instanceof Error ? error.name : undefined,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

describe('createReplicaSchema', () => {
  let dir: string
  let replicaPath: string

  beforeEach(() => {
    // A real file-backed db: `PRAGMA journal_mode = WAL` is a no-op on :memory:.
    dir = mkdtempSync(join(tmpdir(), 'nds-replica-schema-'))
    replicaPath = join(dir, 'replica.sqlite')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('installs all replica tables, CDC triggers, and WAL mode together', () => {
    const db = new DatabaseSync(replicaPath)
    try {
      createReplicaSchema(db)

      const tables = replicaObjectsOfType(db, 'table')
      for (const table of expectedReplicaTables) {
        expect(tables, `missing replica table ${table}`).toContain(table)
      }

      // CDC triggers must be present together with the tables they guard.
      const triggers = replicaObjectsOfType(db, 'trigger')
      expect(triggers).toContain('_nds_replica_cells_direct_value_update_intent')
      expect(triggers).toContain('_nds_replica_rows_archive_restore_intent')
      expect(triggers).toContain('_nds_replica_cell_changes_mirror_local_insert')
      expect(triggers.length).toBeGreaterThan(0)

      const journalMode = (db.prepare('PRAGMA journal_mode').get() as SqlRow)['journal_mode']
      expect(journalMode).toBe('wal')
    } finally {
      db.close()
    }
  })

  it('is idempotent: a second run converges without throwing', () => {
    const db = new DatabaseSync(replicaPath)
    try {
      createReplicaSchema(db)
      expect(() => createReplicaSchema(db)).not.toThrow()

      const tables = replicaObjectsOfType(db, 'table')
      for (const table of expectedReplicaTables) {
        expect(tables).toContain(table)
      }
    } finally {
      db.close()
    }
  })

  it('rolls back the entire schema when a CREATE fails mid-transaction', () => {
    const db = new DatabaseSync(replicaPath)
    try {
      const realExec = db.exec.bind(db)
      let injected = false
      // Let the full DDL run inside the open txn (creating every table and
      // trigger in the uncommitted transaction), then fail once on it so the
      // wrapper's catch issues ROLLBACK. Keyed on SQL content, not call-count,
      // and the ROLLBACK exec itself passes through.
      db.exec = ((sql: string) => {
        if (injected === false && sql.includes('CREATE TRIGGER') === true) {
          injected = true
          realExec(sql)
          throw new Error('injected mid-schema failure')
        }
        return realExec(sql)
      }) as typeof db.exec

      expect(() => createReplicaSchema(db)).toThrow('injected mid-schema failure')

      // Restore the real exec before asserting.
      db.exec = realExec

      const leakedTables = replicaObjectsOfType(db, 'table')
      const leakedTriggers = replicaObjectsOfType(db, 'trigger')
      expect(leakedTables).toEqual([])
      expect(leakedTriggers).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe('notion-datasource-sync replica wire baselines (cross-major invariant)', () => {
  let dir: string
  let replicaPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nds-replica-wire-baseline-'))
    replicaPath = join(dir, 'replica.sqlite')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('captures _nds_replica table SQL bytes and re-encoded identity', () => {
    const db = new DatabaseSync(replicaPath)
    try {
      createReplicaSchema(db)

      const baseline = jsonWireRoundTrip(replicaTableSchemaRows(db))
      expect(baseline.byteIdentical).toBe(true)
      expect(baseline).toMatchSnapshot()
    } finally {
      db.close()
    }
  })

  // TODO(live-migration:effect-3-4): Effect 4 reassigns Schema.Date; preserve the replica ISO timestamp strings while keeping SQLite failure classification unchanged.
  it('captures pending replica change JSON bytes and SQLite failure partition', () => {
    const db = new DatabaseSync(replicaPath)
    try {
      createReplicaSchema(db)

      db.prepare(
        `INSERT INTO _nds_replica_cell_changes (
          change_id,
          data_source_id,
          page_id,
          property_id,
          value_json,
          base_hash,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'change-cell-unicode',
        'ds-unicode-ß',
        'page-1',
        'prop-title',
        '{"plainText":"","_tag":"title","annotations":{"bold":false},"unicode":"ß"}',
        'hash-cell-base',
        'pending',
        '2026-07-28T10:00:00.000Z',
        '2026-07-28T10:00:00.000Z',
      )
      db.prepare(
        `INSERT INTO _nds_replica_row_creates (
          change_id,
          data_source_id,
          local_row_id,
          client_request_key,
          initial_values_json,
          base_schema_hash,
          status,
          remote_page_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'change-row-create',
        'ds-unicode-ß',
        'local-row-empty',
        '',
        '{"prop-null":null,"prop-absent":{},"prop-empty":"","prop-unicode":"Grüße"}',
        'hash-schema-base',
        'queued',
        null,
        '2026-07-28T10:01:00.000Z',
        '2026-07-28T10:01:00.000Z',
      )
      db.prepare(
        `INSERT INTO _nds_replica_body_changes (
          change_id,
          page_id,
          body_path,
          local_body_hash,
          local_body_content,
          base_hash,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'change-body-null-content',
        'page-body',
        null,
        'hash-body-local',
        null,
        'hash-body-base',
        'pending',
        '2026-07-28T10:02:00.000Z',
        '2026-07-28T10:02:00.000Z',
      )
      db.prepare(
        `INSERT INTO _nds_replica_metadata_changes (
          change_id,
          data_source_id,
          database_id,
          resource_type,
          title_plain_text,
          description_plain_text,
          base_hash,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'change-metadata-title',
        'ds-unicode-ß',
        'db-1',
        'database',
        'Neue Datenbank',
        null,
        'hash-metadata-base',
        'pending',
        '2026-07-28T10:03:00.000Z',
        '2026-07-28T10:03:00.000Z',
      )
      db.prepare(
        `INSERT INTO _nds_replica_schema_changes (
          change_id,
          data_source_id,
          operation_json,
          base_hash,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'change-schema-json',
        'ds-unicode-ß',
        '{"op":"rename_property","propertyId":"prop-title","name":"Titel ß"}',
        'hash-schema-change-base',
        'pending',
        '2026-07-28T10:04:00.000Z',
        '2026-07-28T10:04:00.000Z',
      )
      db.prepare(
        `INSERT INTO _nds_replica_file_assets (
          asset_id,
          source_type,
          name,
          external_url,
          content_hash,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'asset-external',
        'external_url',
        'föö.txt',
        'https://example.invalid/f%C3%B6%C3%B6.txt',
        null,
        'ready',
        '2026-07-28T10:05:00.000Z',
        '2026-07-28T10:05:00.000Z',
      )
      db.prepare(
        `INSERT INTO _nds_replica_file_changes (
          change_id,
          asset_id,
          action,
          data_source_id,
          page_id,
          property_id,
          base_hash,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'change-file-attach',
        'asset-external',
        'attach_external_url',
        'ds-unicode-ß',
        'page-1',
        'prop-files',
        'hash-file-base',
        'pending',
        '2026-07-28T10:06:00.000Z',
        '2026-07-28T10:06:00.000Z',
      )
      db.prepare(
        `INSERT INTO _nds_replica_view_changes (
          change_id,
          action,
          view_id,
          database_id,
          data_source_id,
          view_name,
          view_type,
          filter_json,
          sorts_json,
          configuration_json,
          base_hash,
          destructive_ack,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'change-view-update',
        'update',
        'view-1',
        'db-1',
        'ds-unicode-ß',
        'Alle Einträge',
        'table',
        null,
        '[]',
        '{"columns":["prop-title","prop-empty"]}',
        'hash-view-base',
        null,
        'queued',
        '2026-07-28T10:07:00.000Z',
        '2026-07-28T10:07:00.000Z',
      )
      db.prepare(
        `INSERT INTO _nds_replica_conflict_resolutions (
          resolution_id,
          conflict_id,
          action,
          value_json,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'change-conflict-resolution',
        'conflict-1',
        'manual_value',
        'null',
        'pending',
        '2026-07-28T10:08:00.000Z',
        '2026-07-28T10:08:00.000Z',
      )
    } finally {
      db.close()
    }

    const pendingChanges = readPendingReplicaChanges(replicaPath)
    const baseline = jsonWireRoundTrip(pendingChanges)

    expect(baseline.byteIdentical).toBe(true)
    expect({
      pendingChanges,
      wire: baseline,
      failures: {
        invalidStatusCheck: sqliteFailure(() => {
          const failureDb = new DatabaseSync(replicaPath)
          try {
            failureDb
              .prepare(
                `INSERT INTO _nds_replica_cell_changes (
                change_id,
                data_source_id,
                page_id,
                property_id,
                value_json,
                status
              ) VALUES (?, ?, ?, ?, ?, ?)`,
              )
              .run(
                'bad-status',
                'ds-unicode-ß',
                'page-1',
                'prop-title',
                '{"_tag":"title","plainText":"bad"}',
                'not-a-status',
              )
          } finally {
            failureDb.close()
          }
        }),
        missingNotNullValueJson: sqliteFailure(() => {
          const failureDb = new DatabaseSync(replicaPath)
          try {
            failureDb
              .prepare(
                `INSERT INTO _nds_replica_cell_changes (
                change_id,
                data_source_id,
                page_id,
                property_id
              ) VALUES (?, ?, ?, ?)`,
              )
              .run('missing-value-json', 'ds-unicode-ß', 'page-1', 'prop-title')
          } finally {
            failureDb.close()
          }
        }),
        invalidJsonCheck: sqliteFailure(() => {
          const failureDb = new DatabaseSync(replicaPath)
          try {
            failureDb
              .prepare(
                `INSERT INTO _nds_replica_schema_changes (
                change_id,
                data_source_id,
                operation_json,
                base_hash
              ) VALUES (?, ?, ?, ?)`,
              )
              .run('bad-json', 'ds-unicode-ß', '{"op":', 'hash-schema-change-base')
          } finally {
            failureDb.close()
          }
        }),
      },
    }).toMatchSnapshot()
  })
})
