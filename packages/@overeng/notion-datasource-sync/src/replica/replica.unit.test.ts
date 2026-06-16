import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createReplicaSchema } from './replica.ts'

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
        if (injected === false && sql.includes('CREATE TRIGGER')) {
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
