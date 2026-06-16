import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { createReplicaSchema } from './replica.ts'

const tempDirs: string[] = []

const makeReplicaDb = (): { readonly db: DatabaseSync; readonly path: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'nds-replica-schema-'))
  tempDirs.push(dir)
  const path = join(dir, 'notion.sqlite')
  return { db: new DatabaseSync(path), path }
}

const replicaObjectNames = (db: DatabaseSync, type: 'table' | 'trigger'): readonly string[] =>
  (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = ? AND name LIKE '_nds_replica_%' ORDER BY name`,
      )
      .all(type) as unknown as ReadonlyArray<{ readonly name: string }>
  ).map((row) => row.name)

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('createReplicaSchema', () => {
  it('installs all CDC triggers together with the tables they reference', () => {
    const { db } = makeReplicaDb()
    try {
      createReplicaSchema(db)

      const triggers = replicaObjectNames(db, 'trigger')
      const tables = replicaObjectNames(db, 'table')

      // The schema declares a fixed set of CDC triggers (mirror + guard triggers);
      // assert the whole set is present, not just a representative few, so a
      // partially-installed schema would fail this test.
      expect(triggers).toContain('_nds_replica_cells_guard_direct_value_update')
      expect(triggers).toContain('_nds_replica_local_changes_mirror_cell_insert')
      expect(triggers).toContain('_nds_replica_conflict_resolutions_mirror_local_update')
      expect(triggers.length).toBe(31)

      // Every trigger references one of these CDC tables; their co-presence is the
      // invariant the transactional install protects.
      for (const table of [
        '_nds_replica_cells',
        '_nds_replica_rows',
        '_nds_replica_local_changes',
        '_nds_replica_cell_changes',
        '_nds_replica_row_changes',
        '_nds_replica_row_creates',
      ]) {
        expect(tables).toContain(table)
      }

      // PRAGMAs that must run outside the transaction are still applied.
      const journalMode = db.prepare('PRAGMA journal_mode').get() as unknown as {
        readonly journal_mode: string
      }
      expect(journalMode.journal_mode).toBe('wal')
    } finally {
      db.close()
    }
  })

  it('is idempotent when re-run on an existing replica', () => {
    const { db } = makeReplicaDb()
    try {
      createReplicaSchema(db)
      const triggersAfterFirst = replicaObjectNames(db, 'trigger')
      const tablesAfterFirst = replicaObjectNames(db, 'table')

      // Re-running must not throw (IF NOT EXISTS / OR IGNORE) and must converge.
      expect(() => createReplicaSchema(db)).not.toThrow()

      expect(replicaObjectNames(db, 'trigger')).toEqual(triggersAfterFirst)
      expect(replicaObjectNames(db, 'table')).toEqual(tablesAfterFirst)
    } finally {
      db.close()
    }
  })

  it('rolls back to a clean state when installation fails mid-transaction', () => {
    const { db } = makeReplicaDb()
    try {
      // Inject a single failure on a CREATE statement after the transaction has
      // begun and some objects have been created. ROLLBACK must leave no partial
      // replica schema behind.
      const realExec = db.exec.bind(db)
      let triggered = false
      const injected = new Error('injected mid-install failure')
      db.exec = (sql: string): void => {
        if (
          triggered === false &&
          sql.includes(
            'CREATE TRIGGER IF NOT EXISTS _nds_replica_cells_guard_direct_value_update',
          ) === true
        ) {
          triggered = true
          throw injected
        }
        return realExec(sql)
      }

      expect(() => createReplicaSchema(db)).toThrow(injected)
      expect(triggered).toBe(true)

      // Restore the real exec so ROLLBACK (already issued by the wrapper) and the
      // assertions below run against the unwrapped connection.
      db.exec = realExec

      // The failed install must leave zero replica objects: the schema and its
      // triggers are all-or-nothing.
      expect(replicaObjectNames(db, 'trigger')).toEqual([])
      expect(replicaObjectNames(db, 'table')).toEqual([])
    } finally {
      db.close()
    }
  })
})
