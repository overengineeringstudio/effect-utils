import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Schema } from 'effect'

import {
  CanonicalPropertyValue,
  PatchPagePropertiesCommand,
  TrashPageCommand,
} from '../core/commands.ts'
import { CommandId, DataSourceId, Hash, PageId, PropertyId, type AbsolutePath } from '../core/domain.ts'
import { IdempotencyKey, SyncEventId, type SyncRootId } from '../core/events.ts'
import { pageSurfaceKey, propertySurfaceKey } from '../core/canonical.ts'
import type { PlannerIntent } from '../planner/planner.ts'
import { hashStoreBytes, pageLifecycleHash } from '../store/projections.ts'

type SqlRow = Record<string, unknown>

export const replicaFileName = 'notion.sqlite'
export const replicaSchemaVersion = 1

export type ProjectReplicaOptions = {
  readonly syncStorePath: string
  readonly replicaPath: string
  readonly rootId: SyncRootId
}

export type ReplicaLocalChange = {
  readonly changeId: string
  readonly kind: 'cell_patch' | 'row_archive' | 'row_restore' | 'row_create'
  readonly dataSourceId: string
  readonly pageId: string | undefined
  readonly propertyId: string | undefined
  readonly valueJson: string | undefined
  readonly baseHash: string | undefined
  readonly status: string
}

const readString = ({ row, key }: { readonly row: SqlRow; readonly key: string }): string => {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`Expected SQLite column ${key} to be a string`)
  return value
}

const readOptionalString = ({
  row,
  key,
}: {
  readonly row: SqlRow
  readonly key: string
}): string | undefined => {
  const value = row[key]
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`Expected SQLite column ${key} to be a string`)
  return value
}

const readNumber = ({ row, key }: { readonly row: SqlRow; readonly key: string }): number => {
  const value = row[key]
  if (typeof value !== 'number') throw new Error(`Expected SQLite column ${key} to be a number`)
  return value
}

const decode = <TSchema extends Schema.Schema.AnyNoContext>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: unknown
}): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`
const quoteStringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`

const slugForView = (value: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
  return slug.length === 0 ? 'data_source' : slug
}

export const defaultReplicaPath = (workspaceRoot: AbsolutePath): string =>
  join(workspaceRoot, replicaFileName)

const createReplicaSchema = (db: DatabaseSync): void => {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA user_version = ${replicaSchemaVersion.toString()};

    CREATE TABLE IF NOT EXISTS notion_data_sources (
      data_source_id TEXT PRIMARY KEY,
      root_id TEXT NOT NULL,
      schema_hash TEXT NOT NULL,
      metadata_hash TEXT,
      observed_event_id TEXT NOT NULL,
      observed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notion_properties (
      data_source_id TEXT NOT NULL,
      property_id TEXT NOT NULL,
      property_name TEXT NOT NULL,
      property_type TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      schema_hash TEXT NOT NULL,
      write_class TEXT NOT NULL,
      observed_event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (data_source_id, property_id)
    );

    CREATE TABLE IF NOT EXISTS notion_rows (
      data_source_id TEXT NOT NULL,
      page_id TEXT PRIMARY KEY,
      properties_hash TEXT NOT NULL,
      in_trash INTEGER NOT NULL CHECK (in_trash IN (0, 1)),
      moved_out INTEGER NOT NULL CHECK (moved_out IN (0, 1)),
      local_delete_candidate INTEGER NOT NULL CHECK (local_delete_candidate IN (0, 1)),
      observed_event_id TEXT NOT NULL,
      observed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notion_cells (
      data_source_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      property_id TEXT NOT NULL,
      property_name TEXT NOT NULL,
      property_type TEXT NOT NULL,
      value_json TEXT,
      value_text TEXT,
      value_number REAL,
      value_boolean INTEGER CHECK (value_boolean IN (0, 1) OR value_boolean IS NULL),
      base_hash TEXT NOT NULL,
      remote_hash TEXT NOT NULL,
      availability TEXT NOT NULL,
      write_class TEXT NOT NULL,
      observed_event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (page_id, property_id)
    );

    CREATE TABLE IF NOT EXISTS notion_bodies (
      page_id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      base_hash TEXT NOT NULL,
      current_hash TEXT NOT NULL,
      sidecar_identity_proven INTEGER NOT NULL,
      safety_json TEXT NOT NULL,
      observed_event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notion_local_changes (
      change_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('cell_patch', 'row_archive', 'row_restore', 'row_create')),
      data_source_id TEXT NOT NULL,
      page_id TEXT,
      property_id TEXT,
      value_json TEXT,
      base_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'planned',
        'applied',
        'conflict',
        'unsupported'
      )),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS notion_conflicts (
      conflict_id TEXT PRIMARY KEY,
      page_id TEXT,
      property_id TEXT,
      state TEXT NOT NULL,
      base_hash TEXT,
      local_hash TEXT,
      remote_hash TEXT,
      opened_event_id TEXT NOT NULL,
      resolution_event_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notion_sync_status (
      root_id TEXT PRIMARY KEY,
      data_sources INTEGER NOT NULL,
      rows INTEGER NOT NULL,
      cells INTEGER NOT NULL,
      bodies INTEGER NOT NULL,
      conflicts_open INTEGER NOT NULL,
      pending_local_changes INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS notion_cells_data_source_property_idx
      ON notion_cells(data_source_id, property_id);
    CREATE INDEX IF NOT EXISTS notion_cells_text_idx ON notion_cells(value_text);
    CREATE INDEX IF NOT EXISTS notion_local_changes_pending_idx
      ON notion_local_changes(status, data_source_id, page_id);

    CREATE TRIGGER IF NOT EXISTS notion_cells_direct_value_update_intent
    AFTER UPDATE OF value_json ON notion_cells
    FOR EACH ROW
    WHEN NEW.value_json IS NOT OLD.value_json
    BEGIN
      INSERT INTO notion_local_changes (
        change_id,
        kind,
        data_source_id,
        page_id,
        property_id,
        value_json,
        base_hash
      ) VALUES (
        'cell:' || OLD.page_id || ':' || OLD.property_id || ':' || lower(hex(randomblob(8))),
        'cell_patch',
        OLD.data_source_id,
        OLD.page_id,
        OLD.property_id,
        NEW.value_json,
        OLD.base_hash
      );
    END;

    CREATE TRIGGER IF NOT EXISTS notion_cells_block_identity_update
    BEFORE UPDATE OF data_source_id, page_id, property_id, base_hash, remote_hash, write_class ON notion_cells
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'notion_cells identity/hash columns are read-only; edit value_json to queue a local change');
    END;

    CREATE TRIGGER IF NOT EXISTS notion_cells_block_delete
    BEFORE DELETE ON notion_cells
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'deleting notion_cells is unsafe; use notion_rows.in_trash or notion_local_changes for explicit destructive intents');
    END;

    CREATE TRIGGER IF NOT EXISTS notion_rows_archive_restore_intent
    AFTER UPDATE OF in_trash ON notion_rows
    FOR EACH ROW
    WHEN NEW.in_trash IS NOT OLD.in_trash
    BEGIN
      INSERT INTO notion_local_changes (
        change_id,
        kind,
        data_source_id,
        page_id,
        base_hash
      ) VALUES (
        'row:' || OLD.page_id || ':' || CASE WHEN NEW.in_trash = 1 THEN 'archive' ELSE 'restore' END || ':' || lower(hex(randomblob(8))),
        CASE WHEN NEW.in_trash = 1 THEN 'row_archive' ELSE 'row_restore' END,
        OLD.data_source_id,
        OLD.page_id,
        OLD.properties_hash
      );
    END;

    CREATE TRIGGER IF NOT EXISTS notion_rows_block_identity_update
    BEFORE UPDATE OF data_source_id, page_id, properties_hash, moved_out, local_delete_candidate ON notion_rows
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'notion_rows identity/hash columns are read-only; edit in_trash to queue an archive/restore intent');
    END;

    CREATE TRIGGER IF NOT EXISTS notion_rows_block_delete
    BEFORE DELETE ON notion_rows
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'deleting notion_rows is unsafe; set in_trash=1 or insert an explicit local change intent');
    END;
  `)
}

const clearProjectedReplicaTables = (db: DatabaseSync): void => {
  db.exec(`
    DROP TRIGGER IF EXISTS notion_cells_direct_value_update_intent;
    DROP TRIGGER IF EXISTS notion_cells_block_identity_update;
    DROP TRIGGER IF EXISTS notion_cells_block_delete;
    DROP TRIGGER IF EXISTS notion_rows_archive_restore_intent;
    DROP TRIGGER IF EXISTS notion_rows_block_identity_update;
    DROP TRIGGER IF EXISTS notion_rows_block_delete;

    DELETE FROM notion_data_sources;
    DELETE FROM notion_properties;
    DELETE FROM notion_rows;
    DELETE FROM notion_cells;
    DELETE FROM notion_bodies;
    DELETE FROM notion_conflicts;
    DELETE FROM notion_sync_status;
  `)
}

const parsePayload = (payloadJson: string): unknown => {
  const decoded = JSON.parse(payloadJson) as { readonly canonicalJson?: unknown }
  return typeof decoded.canonicalJson === 'string' ? JSON.parse(decoded.canonicalJson) : {}
}

const latestDataSourcePayloads = (
  syncDb: DatabaseSync,
  rootId: SyncRootId,
): Map<string, Record<string, unknown>> => {
  const rows = syncDb
    .prepare(
      `SELECT payload_json
       FROM sync_event
       WHERE root_id = ? AND event_type = 'DataSourceObserved'
       ORDER BY sequence`,
    )
    .all(rootId) as SqlRow[]
  const result = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const payload = parsePayload(readString({ row, key: 'payload_json' }))
    if (typeof payload !== 'object' || payload === null) continue
    const properties = (payload as { readonly schemaProperties?: unknown }).schemaProperties
    if (!Array.isArray(properties)) continue
    for (const property of properties) {
      if (typeof property !== 'object' || property === null) continue
      const propertyId = (property as { readonly propertyId?: unknown }).propertyId
      if (typeof propertyId === 'string') result.set(propertyId, property as Record<string, unknown>)
    }
  }
  return result
}

const latestPropertyValueJson = (
  syncDb: DatabaseSync,
  rootId: SyncRootId,
): Map<string, string> => {
  const rows = syncDb
    .prepare(
      `SELECT event_json, payload_json
       FROM sync_event
       WHERE root_id = ? AND event_type = 'PagePropertyCheckpointRecorded'
       ORDER BY sequence`,
    )
    .all(rootId) as SqlRow[]
  const result = new Map<string, string>()
  for (const row of rows) {
    const payload = parsePayload(readString({ row, key: 'payload_json' }))
    if (typeof payload !== 'object' || payload === null) continue
    const valueJson = (payload as { readonly valueJson?: unknown }).valueJson
    if (typeof valueJson !== 'string') continue
    const event = JSON.parse(readString({ row, key: 'event_json' })) as {
      readonly pageId?: unknown
      readonly propertyId?: unknown
    }
    if (typeof event.pageId !== 'string' || typeof event.propertyId !== 'string') continue
    result.set(
      `${event.pageId}\0${event.propertyId}`,
      valueJson,
    )
  }
  return result
}

const scalarColumns = (valueJson: string | undefined) => {
  if (valueJson === undefined) {
    return { text: undefined, number: undefined, boolean: undefined }
  }
  try {
    const value = JSON.parse(valueJson) as Record<string, unknown>
    switch (value._tag) {
      case 'title':
      case 'rich_text':
        return {
          text: typeof value.plainText === 'string' ? value.plainText : undefined,
          number: undefined,
          boolean: undefined,
        }
      case 'number':
        return {
          text: undefined,
          number: typeof value.value === 'number' ? value.value : undefined,
          boolean: undefined,
        }
      case 'checkbox':
        return {
          text: undefined,
          number: undefined,
          boolean: value.checked === true ? 1 : 0,
        }
      case 'select':
      case 'status':
        return {
          text:
            value.option !== null &&
            typeof value.option === 'object' &&
            typeof (value.option as Record<string, unknown>).name === 'string'
              ? ((value.option as Record<string, unknown>).name as string)
              : undefined,
          number: undefined,
          boolean: undefined,
        }
      case 'email':
      case 'url':
      case 'phone_number':
        return {
          text: typeof value.value === 'string' ? value.value : undefined,
          number: undefined,
          boolean: undefined,
        }
      default:
        return { text: undefined, number: undefined, boolean: undefined }
    }
  } catch {
    return { text: undefined, number: undefined, boolean: undefined }
  }
}

const rebuildGeneratedViews = (db: DatabaseSync): void => {
  const existing = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE 'notion_view_%'`)
    .all() as SqlRow[]
  for (const row of existing) db.exec(`DROP VIEW IF EXISTS ${quoteIdentifier(readString({ row, key: 'name' }))}`)

  const dataSources = db
    .prepare(`SELECT data_source_id FROM notion_data_sources ORDER BY data_source_id`)
    .all() as SqlRow[]
  for (const dataSource of dataSources) {
    const dataSourceId = readString({ row: dataSource, key: 'data_source_id' })
    const properties = db
      .prepare(
        `SELECT property_id, property_name
         FROM notion_properties
         WHERE data_source_id = ?
         ORDER BY property_name, property_id`,
      )
      .all(dataSourceId) as SqlRow[]
    const usedNames = new Map<string, number>()
    const columns = properties.map((property) => {
      const propertyId = readString({ row: property, key: 'property_id' })
      const baseName = readString({ row: property, key: 'property_name' })
      const count = usedNames.get(baseName) ?? 0
      usedNames.set(baseName, count + 1)
      const columnName = count === 0 ? baseName : `${baseName}_${propertyId.slice(0, 8)}`
      return `(SELECT value_text FROM notion_cells c WHERE c.page_id = r.page_id AND c.property_id = ${quoteStringLiteral(propertyId)}) AS ${quoteIdentifier(columnName)}`
    })
    const viewName = `notion_view_${slugForView(dataSourceId).slice(0, 48)}`
    db.exec(`
      CREATE VIEW ${quoteIdentifier(viewName)} AS
      SELECT
        r.page_id,
        r.data_source_id,
        r.in_trash,
        r.moved_out
        ${columns.length === 0 ? '' : `,\n        ${columns.join(',\n        ')}`}
      FROM notion_rows r
      WHERE r.data_source_id = ${quoteStringLiteral(dataSourceId)};
    `)
  }
}

export const projectReplicaFromSyncStore = (options: ProjectReplicaOptions): void => {
  mkdirSync(dirname(options.replicaPath), { recursive: true })
  const syncDb = new DatabaseSync(options.syncStorePath, { readOnly: true })
  const replicaDb = new DatabaseSync(options.replicaPath)
  try {
    createReplicaSchema(replicaDb)
    const schemaPayloads = latestDataSourcePayloads(syncDb, options.rootId)
    const valueJsonByCell = latestPropertyValueJson(syncDb, options.rootId)
    replicaDb.exec('BEGIN IMMEDIATE')
    try {
      clearProjectedReplicaTables(replicaDb)
      const now = new Date().toISOString()
      const metadataRows = syncDb
        .prepare(
          `SELECT event_json
           FROM sync_event
           WHERE root_id = ? AND event_type = 'DataSourceMetadataObserved'
           ORDER BY sequence`,
        )
        .all(options.rootId) as SqlRow[]
      const metadata = new Map<string, string>()
      for (const row of metadataRows) {
        const event = JSON.parse(readString({ row, key: 'event_json' })) as {
          readonly dataSourceId?: unknown
          readonly metadataHash?: unknown
        }
        if (typeof event.dataSourceId === 'string' && typeof event.metadataHash === 'string') {
          metadata.set(event.dataSourceId, event.metadataHash)
        }
      }

      for (const row of syncDb
        .prepare(
          `SELECT data_source_id, schema_hash, observed_event_id, observed_at, updated_at
           FROM data_source_projection
           WHERE root_id = ?
           ORDER BY data_source_id`,
        )
        .all(options.rootId) as SqlRow[]) {
        const dataSourceId = readString({ row, key: 'data_source_id' })
        replicaDb
          .prepare(
            `INSERT INTO notion_data_sources (
               data_source_id, root_id, schema_hash, metadata_hash, observed_event_id, observed_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            dataSourceId,
            options.rootId,
            readString({ row, key: 'schema_hash' }),
            metadata.get(dataSourceId) ?? null,
            readString({ row, key: 'observed_event_id' }),
            readOptionalString({ row, key: 'observed_at' }) ?? null,
            readString({ row, key: 'updated_at' }),
          )
      }

      for (const row of syncDb
        .prepare(
          `SELECT data_source_id, property_id, schema_hash, config_hash, write_class, observed_event_id, updated_at
           FROM schema_property_projection
           WHERE root_id = ?
           ORDER BY data_source_id, property_id`,
        )
        .all(options.rootId) as SqlRow[]) {
        const propertyId = readString({ row, key: 'property_id' })
        const payload = schemaPayloads.get(propertyId)
        replicaDb
          .prepare(
            `INSERT INTO notion_properties (
               data_source_id, property_id, property_name, property_type, config_hash, schema_hash,
               write_class, observed_event_id, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            readString({ row, key: 'data_source_id' }),
            propertyId,
            typeof payload?.name === 'string' ? payload.name : propertyId,
            typeof payload?.type === 'string' ? payload.type : 'unknown',
            readString({ row, key: 'config_hash' }),
            readString({ row, key: 'schema_hash' }),
            readString({ row, key: 'write_class' }),
            readString({ row, key: 'observed_event_id' }),
            readString({ row, key: 'updated_at' }),
          )
      }

      for (const row of syncDb
        .prepare(
          `SELECT data_source_id, page_id, properties_hash, in_trash, moved_out, local_delete_candidate,
                  observed_event_id, observed_at, updated_at
           FROM row_projection
           WHERE root_id = ?
           ORDER BY data_source_id, page_id`,
        )
        .all(options.rootId) as SqlRow[]) {
        replicaDb
          .prepare(
            `INSERT INTO notion_rows (
               data_source_id, page_id, properties_hash, in_trash, moved_out, local_delete_candidate,
               observed_event_id, observed_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            readString({ row, key: 'data_source_id' }),
            readString({ row, key: 'page_id' }),
            readString({ row, key: 'properties_hash' }),
            readNumber({ row, key: 'in_trash' }),
            readNumber({ row, key: 'moved_out' }),
            readNumber({ row, key: 'local_delete_candidate' }),
            readString({ row, key: 'observed_event_id' }),
            readOptionalString({ row, key: 'observed_at' }) ?? null,
            readString({ row, key: 'updated_at' }),
          )
      }

      for (const row of syncDb
        .prepare(
          `SELECT
             ps.page_id,
             rp.data_source_id,
             ps.property_id,
             ps.base_hash,
             ps.remote_hash,
             ps.availability,
             ps.observed_event_id,
             ps.updated_at
           FROM property_shadow_projection ps
           JOIN row_projection rp ON rp.root_id = ps.root_id AND rp.page_id = ps.page_id
           WHERE ps.root_id = ?
           ORDER BY rp.data_source_id, ps.page_id, ps.property_id`,
        )
        .all(options.rootId) as SqlRow[]) {
        const pageId = readString({ row, key: 'page_id' })
        const propertyId = readString({ row, key: 'property_id' })
        const dataSourceId = readString({ row, key: 'data_source_id' })
        const property = replicaDb
          .prepare(
            `SELECT property_name, property_type, write_class
             FROM notion_properties
             WHERE data_source_id = ? AND property_id = ?`,
          )
          .get(dataSourceId, propertyId) as SqlRow | undefined
        const valueJson = valueJsonByCell.get(`${pageId}\0${propertyId}`)
        const scalar = scalarColumns(valueJson)
        replicaDb
          .prepare(
            `INSERT INTO notion_cells (
               data_source_id, page_id, property_id, property_name, property_type, value_json,
               value_text, value_number, value_boolean, base_hash, remote_hash, availability,
               write_class, observed_event_id, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            dataSourceId,
            pageId,
            propertyId,
            property === undefined ? propertyId : readString({ row: property, key: 'property_name' }),
            property === undefined ? 'unknown' : readString({ row: property, key: 'property_type' }),
            valueJson ?? null,
            scalar.text ?? null,
            scalar.number ?? null,
            scalar.boolean ?? null,
            readString({ row, key: 'base_hash' }),
            readString({ row, key: 'remote_hash' }),
            readString({ row, key: 'availability' }),
            property === undefined ? 'unsupported' : readString({ row: property, key: 'write_class' }),
            readString({ row, key: 'observed_event_id' }),
            readString({ row, key: 'updated_at' }),
          )
      }

      for (const row of syncDb
        .prepare(
          `SELECT page_id, path, base_hash, current_hash, sidecar_identity_proven, safety_json,
                  observed_event_id, updated_at
           FROM body_pointer_projection
           WHERE root_id = ?
           ORDER BY page_id`,
        )
        .all(options.rootId) as SqlRow[]) {
        replicaDb
          .prepare(
            `INSERT INTO notion_bodies (
               page_id, path, base_hash, current_hash, sidecar_identity_proven, safety_json,
               observed_event_id, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            readString({ row, key: 'page_id' }),
            readString({ row, key: 'path' }),
            readString({ row, key: 'base_hash' }),
            readString({ row, key: 'current_hash' }),
            readNumber({ row, key: 'sidecar_identity_proven' }),
            readString({ row, key: 'safety_json' }),
            readString({ row, key: 'observed_event_id' }),
            readString({ row, key: 'updated_at' }),
          )
      }

      for (const row of syncDb
        .prepare(
          `SELECT conflict_id, page_id, property_id, state, base_hash, local_hash, remote_hash,
                  opened_event_id, resolution_event_id, updated_at
           FROM conflict_projection
           WHERE root_id = ?
           ORDER BY conflict_id`,
        )
        .all(options.rootId) as SqlRow[]) {
        replicaDb
          .prepare(
            `INSERT INTO notion_conflicts (
               conflict_id, page_id, property_id, state, base_hash, local_hash, remote_hash,
               opened_event_id, resolution_event_id, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            readString({ row, key: 'conflict_id' }),
            readOptionalString({ row, key: 'page_id' }) ?? null,
            readOptionalString({ row, key: 'property_id' }) ?? null,
            readString({ row, key: 'state' }),
            readOptionalString({ row, key: 'base_hash' }) ?? null,
            readOptionalString({ row, key: 'local_hash' }) ?? null,
            readOptionalString({ row, key: 'remote_hash' }) ?? null,
            readString({ row, key: 'opened_event_id' }),
            readOptionalString({ row, key: 'resolution_event_id' }) ?? null,
            readString({ row, key: 'updated_at' }),
          )
      }

      const counts = replicaDb
        .prepare(
          `SELECT
             (SELECT count(*) FROM notion_data_sources) AS data_sources,
             (SELECT count(*) FROM notion_rows) AS rows,
             (SELECT count(*) FROM notion_cells) AS cells,
             (SELECT count(*) FROM notion_bodies) AS bodies,
             (SELECT count(*) FROM notion_conflicts WHERE state = 'open') AS conflicts_open,
             (SELECT count(*) FROM notion_local_changes WHERE status = 'pending') AS pending_local_changes`,
        )
        .get() as SqlRow
      replicaDb
        .prepare(
          `INSERT INTO notion_sync_status (
             root_id, data_sources, rows, cells, bodies, conflicts_open, pending_local_changes, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          options.rootId,
          readNumber({ row: counts, key: 'data_sources' }),
          readNumber({ row: counts, key: 'rows' }),
          readNumber({ row: counts, key: 'cells' }),
          readNumber({ row: counts, key: 'bodies' }),
          readNumber({ row: counts, key: 'conflicts_open' }),
          readNumber({ row: counts, key: 'pending_local_changes' }),
          now,
        )

      rebuildGeneratedViews(replicaDb)
      createReplicaSchema(replicaDb)
      replicaDb.exec('COMMIT')
    } catch (error) {
      replicaDb.exec('ROLLBACK')
      throw error
    }
  } finally {
    syncDb.close()
    replicaDb.close()
  }
}

export const readPendingReplicaChanges = (replicaPath: string): readonly ReplicaLocalChange[] => {
  const db = new DatabaseSync(replicaPath)
  try {
    createReplicaSchema(db)
    return (db
      .prepare(
        `SELECT change_id, kind, data_source_id, page_id, property_id, value_json, base_hash, status
         FROM notion_local_changes
         WHERE status = 'pending'
         ORDER BY created_at, change_id`,
      )
      .all() as SqlRow[]).map((row) => ({
      changeId: readString({ row, key: 'change_id' }),
      kind: Schema.decodeUnknownSync(
        Schema.Literal('cell_patch', 'row_archive', 'row_restore', 'row_create'),
      )(readString({ row, key: 'kind' })),
      dataSourceId: readString({ row, key: 'data_source_id' }),
      pageId: readOptionalString({ row, key: 'page_id' }),
      propertyId: readOptionalString({ row, key: 'property_id' }),
      valueJson: readOptionalString({ row, key: 'value_json' }),
      baseHash: readOptionalString({ row, key: 'base_hash' }),
      status: readString({ row, key: 'status' }),
    }))
  } finally {
    db.close()
  }
}

export const markReplicaChangeStatus = ({
  replicaPath,
  changeId,
  status,
  unsupportedReason,
}: {
  readonly replicaPath: string
  readonly changeId: string
  readonly status: 'planned' | 'unsupported'
  readonly unsupportedReason?: string
}): void => {
  const db = new DatabaseSync(replicaPath)
  try {
    createReplicaSchema(db)
    db.prepare(
      `UPDATE notion_local_changes
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE change_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
  } finally {
    db.close()
  }
}

export const replicaChangesToPlannerIntents = ({
  changes,
  replicaPath,
  dryRun,
}: {
  readonly changes: readonly ReplicaLocalChange[]
  readonly replicaPath: string
  readonly dryRun?: boolean
}): readonly PlannerIntent[] => {
  const db = new DatabaseSync(replicaPath)
  try {
    createReplicaSchema(db)
    const intents: PlannerIntent[] = []
    for (const change of changes) {
      if (change.kind === 'row_create') {
        if (dryRun !== true) {
          markReplicaChangeStatus({
            replicaPath,
            changeId: change.changeId,
            status: 'unsupported',
            unsupportedReason:
              'Row creation needs a create-page gateway command before it can sync safely.',
          })
        }
        continue
      }
      if (change.pageId === undefined) continue
      const pageId = decode({ schema: PageId, value: change.pageId })
      const dataSourceId = decode({ schema: DataSourceId, value: change.dataSourceId })
      const row = db
        .prepare(`SELECT properties_hash, in_trash FROM notion_rows WHERE page_id = ?`)
        .get(change.pageId) as SqlRow | undefined
      if (row === undefined) continue
      if (change.kind === 'row_restore') {
        if (dryRun !== true) {
          markReplicaChangeStatus({
            replicaPath,
            changeId: change.changeId,
            status: 'unsupported',
            unsupportedReason:
              'Row restore needs a dedicated restore planner intent before it can sync from the replica.',
          })
        }
        continue
      }
      if (change.kind === 'row_archive') {
        const baseHash = decode({
          schema: Hash,
          value: change.baseHash ?? pageLifecycleHash({ pageId, inTrash: readNumber({ row, key: 'in_trash' }) === 1 }),
        })
        const commandId = decode({ schema: CommandId, value: `replica:${change.changeId}` })
        const command = TrashPageCommand.make({
          _tag: 'TrashPageCommand',
          commandId,
          pageId,
          basePropertiesHash: baseHash,
        })
        intents.push({
          _tag: 'local-delete',
          intentEventId: decode({ schema: SyncEventId, value: `replica:${change.changeId}` }),
          commandKey: decode({ schema: IdempotencyKey, value: `replica:${change.changeId}` }),
          surface: pageSurfaceKey(pageId),
          pageId,
          command,
          baseHash,
          desiredHash: hashStoreBytes(`${change.kind}:${change.pageId}`),
          explicitDestructiveIntent: true,
          policy: 'trustedRemoteTrash',
          directRetrieve: 'accessible',
        })
        continue
      }
      if (change.kind === 'cell_patch') {
        if (change.propertyId === undefined || change.valueJson === undefined) continue
        const propertyId = decode({ schema: PropertyId, value: change.propertyId })
        const cell = db
          .prepare(
            `SELECT base_hash, config_hash
             FROM notion_cells c
             JOIN notion_properties p
               ON p.data_source_id = c.data_source_id AND p.property_id = c.property_id
             WHERE c.page_id = ? AND c.property_id = ?`,
          )
          .get(change.pageId, change.propertyId) as SqlRow | undefined
        if (cell === undefined) continue
        const value = Schema.decodeUnknownSync(Schema.parseJson(CanonicalPropertyValue))(
          change.valueJson,
        )
        const baseHash = decode({
          schema: Hash,
          value: change.baseHash ?? readString({ row: cell, key: 'base_hash' }),
        })
        const desiredHash = hashStoreBytes(change.valueJson)
        const commandId = decode({ schema: CommandId, value: `replica:${change.changeId}` })
        intents.push({
          _tag: 'property-edit',
          intentEventId: decode({ schema: SyncEventId, value: `replica:${change.changeId}` }),
          commandKey: decode({ schema: IdempotencyKey, value: `replica:${change.changeId}` }),
          surface: propertySurfaceKey({ pageId, propertyId }),
          pageId,
          propertyId,
          command: PatchPagePropertiesCommand.make({
            _tag: 'PatchPagePropertiesCommand',
            commandId,
            pageId,
            basePropertiesHash: decode({
              schema: Hash,
              value: readString({ row, key: 'properties_hash' }),
            }),
            propertyPatch: { [propertyId]: value },
          }),
          baseHash,
          desiredHash,
          expectedPropertyConfigHash: decode({
            schema: Hash,
            value: readString({ row: cell, key: 'config_hash' }),
          }),
        })
      }
    }
    return intents
  } finally {
    db.close()
  }
}
