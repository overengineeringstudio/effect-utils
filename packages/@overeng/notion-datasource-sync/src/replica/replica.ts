import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Schema } from 'effect'

import {
  bodySurfaceKey,
  databaseMetadataSurfaceKey,
  dataSourceMetadataSurfaceKey,
  dataSourceMetadataHash,
  pageSurfaceKey,
  propertySurfaceKey,
  schemaSurfaceKey,
} from '../core/canonical.ts'
import {
  BodyPushCommand,
  CanonicalDataSourceMetadata,
  CanonicalPropertyValue,
  CreatePageCommand,
  PatchDatabaseMetadataCommand,
  PatchDataSourceMetadataCommand,
  PatchPagePropertiesCommand,
  RestorePageCommand,
  TrashPageCommand,
} from '../core/commands.ts'
import {
  CommandId,
  DatabaseId,
  DataSourceId,
  Hash,
  PageId,
  PropertyId,
  type AbsolutePath,
  BodyPointer,
  WorkspaceRelativePath,
} from '../core/domain.ts'
import { IdempotencyKey, SyncEventId, type SyncRootId } from '../core/events.ts'
import type { PlanDecision, PlannerIntent } from '../planner/planner.ts'
import { resolveConflictCommand } from '../planner/user-commands.ts'
import { hashStoreBytes, pageLifecycleHash } from '../store/projections.ts'
import type { NotionSyncStore } from '../store/store.ts'

type SqlRow = Record<string, unknown>

/** Default file name for the on-disk SQLite replica inside a workspace. */
export const replicaFileName = 'notion.sqlite'
/** Schema version stored in the replica's `PRAGMA user_version`. */
export const replicaSchemaVersion = 1

/** Inputs for projecting the sync store into a user-facing SQLite replica. */
export type ProjectReplicaOptions = {
  readonly syncStorePath: string
  readonly replicaPath: string
  readonly rootId: SyncRootId
}

/** Local replica change row representing a pending CDC entry awaiting planning. */
export type ReplicaLocalChange = {
  readonly changeId: string
  readonly kind:
    | 'cell_patch'
    | 'row_archive'
    | 'row_restore'
    | 'row_create'
    | 'body_patch'
    | 'metadata_patch'
    | 'schema_patch'
    | 'file_attach'
    | 'conflict_resolution'
  readonly dataSourceId: string
  readonly pageId: string | undefined
  readonly propertyId: string | undefined
  readonly valueJson: string | undefined
  readonly baseHash: string | undefined
  readonly status: string
  readonly bodyPath: string | undefined
  readonly localBodyHash: string | undefined
  readonly localBodyContent: string | undefined
  readonly metadataResourceType: string | undefined
  readonly databaseId: string | undefined
  readonly titlePlainText: string | undefined
  readonly descriptionPlainText: string | undefined
  readonly schemaOperationJson: string | undefined
  readonly fileAssetId: string | undefined
  readonly fileAction: string | undefined
  readonly fileName: string | undefined
  readonly fileExternalUrl: string | undefined
  readonly conflictId: string | undefined
  readonly resolutionAction: string | undefined
  readonly localRowId: string | undefined
  readonly clientRequestKey: string | undefined
  readonly remotePageId: string | undefined
}

type ReplicaChangeStatus =
  | 'pending'
  | 'queued'
  | 'planned'
  | 'applied'
  | 'conflict'
  | 'unsupported'
  | 'rejected'
  | 'needs_reconciliation'

export type ApplyReplicaConflictResolutionsOptions = {
  readonly changes: readonly ReplicaLocalChange[]
  readonly replicaPath: string
  readonly store: NotionSyncStore
  readonly rootId: SyncRootId
  readonly dryRun?: boolean
}

export type SettleReplicaChangesOptions = {
  readonly changes: readonly ReplicaLocalChange[]
  readonly replicaPath: string
  readonly store: NotionSyncStore
  readonly rootId: SyncRootId
  readonly decisions: readonly PlanDecision[]
  readonly dryRun?: boolean
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

const ensureReplicaColumn = ({
  db,
  table,
  column,
  definition,
}: {
  readonly db: DatabaseSync
  readonly table: string
  readonly column: string
  readonly definition: string
}): void => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[]
  const exists = columns.some((row) => readString({ row, key: 'name' }) === column)
  if (exists === false) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
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

/** Default path for the replica file inside a workspace root. */
export const defaultReplicaPath = (workspaceRoot: AbsolutePath): string =>
  join(workspaceRoot, replicaFileName)

const createReplicaSchema = (db: DatabaseSync): void => {
  const localChangesSchema = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notion_local_changes'`)
    .get() as SqlRow | undefined
  const needsLocalChangesStatusMigration =
    typeof localChangesSchema?.sql === 'string' &&
    (!localChangesSchema.sql.includes("'rejected'") ||
      !localChangesSchema.sql.includes("'queued'") ||
      !localChangesSchema.sql.includes("'body_patch'") ||
      !localChangesSchema.sql.includes("'metadata_patch'") ||
      !localChangesSchema.sql.includes("'schema_patch'") ||
      !localChangesSchema.sql.includes("'file_attach'") ||
      !localChangesSchema.sql.includes("'conflict_resolution'"))
  if (needsLocalChangesStatusMigration === true) {
    db.exec(`ALTER TABLE notion_local_changes RENAME TO notion_local_changes_legacy;`)
  }

  db.exec(`
    DROP TRIGGER IF EXISTS notion_cells_direct_value_update_intent;
    DROP TRIGGER IF EXISTS notion_cells_guard_direct_value_update;
    DROP TRIGGER IF EXISTS notion_cells_guard_direct_value_shape;
    DROP TRIGGER IF EXISTS notion_cells_guard_direct_complex_update;
    DROP TRIGGER IF EXISTS notion_cells_guard_direct_relation_update;
    DROP TRIGGER IF EXISTS notion_cells_block_identity_update;
    DROP TRIGGER IF EXISTS notion_cells_block_delete;
    DROP TRIGGER IF EXISTS notion_rows_archive_restore_intent;
    DROP TRIGGER IF EXISTS notion_rows_block_insert;
    DROP TRIGGER IF EXISTS notion_rows_block_identity_update;
    DROP TRIGGER IF EXISTS notion_rows_block_delete;
    DROP TRIGGER IF EXISTS notion_local_changes_mirror_cell_insert;
    DROP TRIGGER IF EXISTS notion_local_changes_mirror_row_insert;
    DROP TRIGGER IF EXISTS notion_cell_changes_mirror_local_insert;
    DROP TRIGGER IF EXISTS notion_row_changes_mirror_local_insert;
    DROP TRIGGER IF EXISTS notion_cell_changes_mirror_local_update;
    DROP TRIGGER IF EXISTS notion_row_changes_mirror_local_update;
    DROP TRIGGER IF EXISTS notion_row_creates_mirror_row_change_insert;
    DROP TRIGGER IF EXISTS notion_row_creates_mirror_row_change_update;
    DROP TRIGGER IF EXISTS notion_body_changes_mirror_local_insert;
    DROP TRIGGER IF EXISTS notion_body_changes_mirror_local_update;
    DROP TRIGGER IF EXISTS notion_metadata_changes_mirror_local_insert;
    DROP TRIGGER IF EXISTS notion_metadata_changes_mirror_local_update;
    DROP TRIGGER IF EXISTS notion_schema_changes_mirror_local_insert;
    DROP TRIGGER IF EXISTS notion_schema_changes_mirror_local_update;
    DROP TRIGGER IF EXISTS notion_file_changes_mirror_local_insert;
    DROP TRIGGER IF EXISTS notion_file_changes_mirror_local_update;
    DROP TRIGGER IF EXISTS notion_conflict_resolutions_mirror_local_insert;
    DROP TRIGGER IF EXISTS notion_conflict_resolutions_mirror_local_update;

    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA user_version = ${replicaSchemaVersion.toString()};

    CREATE TABLE IF NOT EXISTS notion_data_sources (
      data_source_id TEXT PRIMARY KEY,
      root_id TEXT NOT NULL,
      parent_database_id TEXT,
      schema_hash TEXT NOT NULL,
      metadata_hash TEXT,
      metadata_json TEXT,
      title_plain_text TEXT,
      description_plain_text TEXT,
      observed_event_id TEXT NOT NULL,
      observed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notion_databases (
      database_id TEXT PRIMARY KEY,
      data_source_id TEXT NOT NULL,
      root_id TEXT NOT NULL,
      metadata_hash TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      title_plain_text TEXT,
      description_plain_text TEXT,
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

    CREATE TABLE IF NOT EXISTS notion_views (
      view_id TEXT PRIMARY KEY,
      database_id TEXT NOT NULL,
      data_source_id TEXT NOT NULL,
      root_id TEXT NOT NULL,
      view_name TEXT NOT NULL,
      view_type TEXT NOT NULL,
      view_hash TEXT NOT NULL,
      view_json TEXT NOT NULL,
      observed_event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS notion_relation_targets (
      data_source_id TEXT NOT NULL,
      property_id TEXT NOT NULL,
      target_page_id TEXT NOT NULL,
      observed_from_page_id TEXT NOT NULL,
      observed_event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (data_source_id, property_id, target_page_id)
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

    CREATE TABLE IF NOT EXISTS notion_cell_changes (
      change_id TEXT PRIMARY KEY,
      data_source_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      property_id TEXT NOT NULL,
      value_json TEXT NOT NULL,
      base_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
      )),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS notion_row_changes (
      change_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('row_archive', 'row_restore', 'row_create')),
      data_source_id TEXT NOT NULL,
      page_id TEXT,
      value_json TEXT,
      base_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
      )),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS notion_row_creates (
      change_id TEXT PRIMARY KEY,
      data_source_id TEXT NOT NULL,
      local_row_id TEXT NOT NULL,
      client_request_key TEXT NOT NULL,
      initial_values_json TEXT NOT NULL CHECK (json_valid(initial_values_json)),
      base_schema_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
      )),
      remote_page_id TEXT,
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (data_source_id, local_row_id),
      UNIQUE (data_source_id, client_request_key)
    );

    CREATE TABLE IF NOT EXISTS notion_body_changes (
      change_id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      body_path TEXT,
      local_body_hash TEXT NOT NULL,
      local_body_content TEXT,
      base_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
      )),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS notion_metadata_changes (
      change_id TEXT PRIMARY KEY,
      data_source_id TEXT NOT NULL,
      database_id TEXT,
      resource_type TEXT NOT NULL DEFAULT 'data_source' CHECK (resource_type IN ('data_source', 'database')),
      title_plain_text TEXT,
      description_plain_text TEXT,
      base_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
      )),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (title_plain_text IS NOT NULL OR description_plain_text IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS notion_schema_changes (
      change_id TEXT PRIMARY KEY,
      data_source_id TEXT NOT NULL,
      operation_json TEXT NOT NULL,
      base_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
      )),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (json_valid(operation_json))
    );

    CREATE TABLE IF NOT EXISTS notion_file_assets (
      asset_id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL CHECK (source_type IN ('external_url', 'local_upload')),
      name TEXT NOT NULL,
      external_url TEXT,
      content_hash TEXT,
      notion_file_upload_id TEXT,
      upload_status TEXT,
      status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'pending_upload', 'uploaded', 'expired', 'failed', 'unsupported')),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (
        (source_type = 'external_url' AND external_url IS NOT NULL AND notion_file_upload_id IS NULL)
        OR source_type = 'local_upload'
      )
    );

    CREATE TABLE IF NOT EXISTS notion_file_changes (
      change_id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('attach_external_url', 'attach_upload')),
      data_source_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      property_id TEXT NOT NULL,
      base_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
      )),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS notion_conflict_resolutions (
      resolution_id TEXT PRIMARY KEY,
      conflict_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('choose_remote', 'abandon_local', 'retry_after_refresh', 'choose_local', 'manual_value')),
      value_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
      )),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (value_json IS NULL OR json_valid(value_json))
    );

    CREATE TABLE IF NOT EXISTS notion_local_changes (
      change_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN (
        'cell_patch',
        'row_archive',
        'row_restore',
        'row_create',
        'body_patch',
        'metadata_patch',
        'schema_patch',
        'file_attach',
        'conflict_resolution'
      )),
      data_source_id TEXT NOT NULL,
      page_id TEXT,
      property_id TEXT,
      value_json TEXT,
      base_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
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

    CREATE VIEW IF NOT EXISTS notion_rows_effective AS
      SELECT
        data_source_id,
        page_id,
        NULL AS local_row_id,
        'remote' AS origin,
        properties_hash,
        in_trash,
        moved_out,
        local_delete_candidate,
        'applied' AS sync_status,
        observed_event_id,
        observed_at,
        updated_at
      FROM notion_rows
      UNION ALL
      SELECT
        data_source_id,
        remote_page_id AS page_id,
        local_row_id,
        'local_create' AS origin,
        NULL AS properties_hash,
        0 AS in_trash,
        0 AS moved_out,
        0 AS local_delete_candidate,
        status AS sync_status,
        NULL AS observed_event_id,
        NULL AS observed_at,
        updated_at
      FROM notion_row_creates
      WHERE status IN ('pending', 'queued', 'planned', 'needs_reconciliation')
        OR (remote_page_id IS NOT NULL AND status != 'applied');

    CREATE VIEW IF NOT EXISTS notion_cells_effective AS
      SELECT
        data_source_id,
        page_id,
        NULL AS local_row_id,
        'remote' AS origin,
        property_id,
        property_name,
        property_type,
        value_json,
        value_text,
        value_number,
        value_boolean,
        base_hash,
        remote_hash,
        availability,
        write_class,
        'applied' AS sync_status,
        observed_event_id,
        updated_at
      FROM notion_cells
      UNION ALL
      SELECT
        c.data_source_id,
        c.remote_page_id AS page_id,
        c.local_row_id,
        'local_create' AS origin,
        p.property_id,
        p.property_name,
        p.property_type,
        json_extract(values_by_property.value, '$') AS value_json,
        CASE json_extract(values_by_property.value, '$._tag')
          WHEN 'title' THEN json_extract(values_by_property.value, '$.plainText')
          WHEN 'rich_text' THEN json_extract(values_by_property.value, '$.plainText')
          WHEN 'select' THEN json_extract(values_by_property.value, '$.option.name')
          WHEN 'status' THEN json_extract(values_by_property.value, '$.option.name')
          WHEN 'email' THEN json_extract(values_by_property.value, '$.value')
          WHEN 'url' THEN json_extract(values_by_property.value, '$.value')
          WHEN 'phone_number' THEN json_extract(values_by_property.value, '$.value')
          ELSE NULL
        END AS value_text,
        CASE
          WHEN json_extract(values_by_property.value, '$._tag') = 'number'
          THEN json_extract(values_by_property.value, '$.value')
          ELSE NULL
        END AS value_number,
        CASE
          WHEN json_extract(values_by_property.value, '$._tag') = 'checkbox'
          THEN CASE WHEN json_extract(values_by_property.value, '$.checked') THEN 1 ELSE 0 END
          ELSE NULL
        END AS value_boolean,
        c.base_schema_hash AS base_hash,
        c.base_schema_hash AS remote_hash,
        'local-create' AS availability,
        p.write_class,
        c.status AS sync_status,
        NULL AS observed_event_id,
        c.updated_at
      FROM notion_row_creates c
      JOIN json_each(c.initial_values_json) AS values_by_property
      JOIN notion_properties p
        ON p.data_source_id = c.data_source_id
       AND p.property_id = values_by_property.key
      WHERE c.status IN ('pending', 'queued', 'planned', 'needs_reconciliation')
        OR (c.remote_page_id IS NOT NULL AND c.status != 'applied');

    CREATE INDEX IF NOT EXISTS notion_cells_data_source_property_idx
      ON notion_cells(data_source_id, property_id);
    CREATE INDEX IF NOT EXISTS notion_cells_text_idx ON notion_cells(value_text);
    CREATE INDEX IF NOT EXISTS notion_relation_targets_property_idx
      ON notion_relation_targets(data_source_id, property_id, target_page_id);
    CREATE INDEX IF NOT EXISTS notion_cell_changes_pending_idx
      ON notion_cell_changes(status, data_source_id, page_id, property_id);
    CREATE INDEX IF NOT EXISTS notion_row_changes_pending_idx
      ON notion_row_changes(status, data_source_id, page_id);
    CREATE INDEX IF NOT EXISTS notion_row_creates_pending_idx
      ON notion_row_creates(status, data_source_id, client_request_key);
    CREATE INDEX IF NOT EXISTS notion_body_changes_pending_idx
      ON notion_body_changes(status, page_id);
    CREATE INDEX IF NOT EXISTS notion_metadata_changes_pending_idx
      ON notion_metadata_changes(status, data_source_id);
    CREATE INDEX IF NOT EXISTS notion_schema_changes_pending_idx
      ON notion_schema_changes(status, data_source_id);
    CREATE INDEX IF NOT EXISTS notion_file_changes_pending_idx
      ON notion_file_changes(status, data_source_id, page_id, property_id);
    CREATE INDEX IF NOT EXISTS notion_conflict_resolutions_pending_idx
      ON notion_conflict_resolutions(status, conflict_id);
    CREATE INDEX IF NOT EXISTS notion_local_changes_pending_idx
      ON notion_local_changes(status, data_source_id, page_id);

    CREATE TRIGGER IF NOT EXISTS notion_cells_guard_direct_value_update
    BEFORE UPDATE OF value_json ON notion_cells
    FOR EACH ROW
    WHEN NEW.value_json IS NOT OLD.value_json AND OLD.write_class != 'writable'
    BEGIN
      SELECT RAISE(ABORT, 'notion_cells.value_json is writable only for writable Notion properties');
    END;

    CREATE TRIGGER IF NOT EXISTS notion_cells_guard_direct_value_shape
    BEFORE UPDATE OF value_json ON notion_cells
    FOR EACH ROW
    WHEN NEW.value_json IS NOT OLD.value_json
      AND CASE
        WHEN NEW.value_json IS NULL THEN 1
        WHEN json_valid(NEW.value_json) = 0 THEN 1
        WHEN json_extract(NEW.value_json, '$._tag') = 'empty' THEN 0
        WHEN json_extract(NEW.value_json, '$._tag') IN ('title', 'rich_text')
          THEN CASE WHEN json_type(NEW.value_json, '$.plainText') = 'text' THEN 0 ELSE 1 END
        WHEN json_extract(NEW.value_json, '$._tag') = 'number'
          THEN CASE WHEN json_type(NEW.value_json, '$.value') IN ('integer', 'real') THEN 0 ELSE 1 END
        WHEN json_extract(NEW.value_json, '$._tag') = 'checkbox'
          THEN CASE WHEN json_type(NEW.value_json, '$.checked') IN ('true', 'false') THEN 0 ELSE 1 END
        WHEN json_extract(NEW.value_json, '$._tag') = 'date'
          THEN CASE WHEN json_type(NEW.value_json, '$.start') = 'text'
            AND (json_type(NEW.value_json, '$.end') IS NULL OR json_type(NEW.value_json, '$.end') IN ('text', 'null'))
            THEN 0 ELSE 1 END
        WHEN json_extract(NEW.value_json, '$._tag') IN ('select', 'status')
          THEN CASE WHEN json_type(NEW.value_json, '$.option') = 'null'
            OR (json_type(NEW.value_json, '$.option') = 'object' AND json_type(NEW.value_json, '$.option.name') = 'text')
            THEN 0 ELSE 1 END
        WHEN json_extract(NEW.value_json, '$._tag') = 'multi_select'
          THEN CASE WHEN json_type(NEW.value_json, '$.options') = 'array' THEN 0 ELSE 1 END
        WHEN json_extract(NEW.value_json, '$._tag') = 'relation'
          THEN CASE WHEN json_type(NEW.value_json, '$.pageIds') = 'array' THEN 0 ELSE 1 END
        WHEN json_extract(NEW.value_json, '$._tag') = 'people'
          THEN CASE WHEN json_type(NEW.value_json, '$.userIds') = 'array' THEN 0 ELSE 1 END
        WHEN json_extract(NEW.value_json, '$._tag') = 'files'
          THEN CASE WHEN json_type(NEW.value_json, '$.files') = 'array' THEN 0 ELSE 1 END
        WHEN json_extract(NEW.value_json, '$._tag') IN ('email', 'url', 'phone_number')
          THEN CASE WHEN json_type(NEW.value_json, '$.value') IN ('text', 'null') THEN 0 ELSE 1 END
        ELSE 1
      END = 1
    BEGIN
      SELECT RAISE(ABORT, 'notion_cells.value_json must be canonical Notion property value JSON');
    END;

    CREATE TRIGGER IF NOT EXISTS notion_cells_guard_direct_complex_update
    BEFORE UPDATE OF value_json ON notion_cells
    FOR EACH ROW
    WHEN NEW.value_json IS NOT OLD.value_json
      AND json_valid(NEW.value_json)
      AND (
        OLD.property_type IN ('people', 'files')
        OR json_extract(NEW.value_json, '$._tag') IN ('people', 'files')
      )
    BEGIN
      SELECT RAISE(ABORT, 'people and files current-state edits require typed CDC staging; direct notion_cells.value_json updates are fail-closed');
    END;

    CREATE TRIGGER IF NOT EXISTS notion_cells_guard_direct_relation_update
    BEFORE UPDATE OF value_json ON notion_cells
    FOR EACH ROW
    WHEN NEW.value_json IS NOT OLD.value_json
      AND OLD.property_type = 'relation'
      AND json_extract(NEW.value_json, '$._tag') = 'relation'
      AND (
        OLD.availability != 'complete'
        OR json_extract(OLD.value_json, '$._tag') != 'relation'
        OR json_array_length(NEW.value_json, '$.pageIds') > 100
        OR EXISTS (
          SELECT 1
          FROM json_each(NEW.value_json, '$.pageIds') AS desired
          WHERE NOT EXISTS (
            SELECT 1
            FROM json_each(OLD.value_json, '$.pageIds') AS observed
            WHERE observed.value = desired.value
          )
          AND NOT EXISTS (
            SELECT 1
            FROM notion_relation_targets rt
            WHERE rt.data_source_id = OLD.data_source_id
              AND rt.property_id = OLD.property_id
              AND rt.target_page_id = desired.value
          )
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'relation value_json direct edits require a complete observed base and observed accessible relation targets');
    END;

    CREATE TRIGGER IF NOT EXISTS notion_cells_direct_value_update_intent
    AFTER UPDATE OF value_json ON notion_cells
    FOR EACH ROW
    WHEN NEW.value_json IS NOT OLD.value_json
    BEGIN
      UPDATE notion_cells
      SET
        value_text =
          CASE
            WHEN NEW.value_json IS NOT NULL AND json_valid(NEW.value_json) THEN
              CASE json_extract(NEW.value_json, '$._tag')
                WHEN 'title' THEN json_extract(NEW.value_json, '$.plainText')
                WHEN 'rich_text' THEN json_extract(NEW.value_json, '$.plainText')
                WHEN 'select' THEN json_extract(NEW.value_json, '$.option.name')
                WHEN 'status' THEN json_extract(NEW.value_json, '$.option.name')
                WHEN 'email' THEN json_extract(NEW.value_json, '$.value')
                WHEN 'url' THEN json_extract(NEW.value_json, '$.value')
                WHEN 'phone_number' THEN json_extract(NEW.value_json, '$.value')
                ELSE NULL
              END
            ELSE NULL
          END,
        value_number =
          CASE
            WHEN NEW.value_json IS NOT NULL
              AND json_valid(NEW.value_json)
              AND json_extract(NEW.value_json, '$._tag') = 'number'
              AND json_type(NEW.value_json, '$.value') IN ('integer', 'real')
            THEN json_extract(NEW.value_json, '$.value')
            ELSE NULL
          END,
        value_boolean =
          CASE
            WHEN NEW.value_json IS NOT NULL
              AND json_valid(NEW.value_json)
              AND json_extract(NEW.value_json, '$._tag') = 'checkbox'
              AND json_type(NEW.value_json, '$.checked') IN ('true', 'false')
            THEN CASE WHEN json_extract(NEW.value_json, '$.checked') THEN 1 ELSE 0 END
            ELSE NULL
          END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE page_id = OLD.page_id AND property_id = OLD.property_id;

      UPDATE notion_cell_changes
      SET
        value_json = NEW.value_json,
        base_hash = OLD.base_hash,
        status = 'pending',
        unsupported_reason = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE page_id = OLD.page_id
        AND property_id = OLD.property_id
        AND status IN ('pending', 'queued');

      INSERT INTO notion_cell_changes (
        change_id,
        data_source_id,
        page_id,
        property_id,
        value_json,
        base_hash
      )
      SELECT
        'cell:' || OLD.page_id || ':' || OLD.property_id || ':' || lower(hex(randomblob(8))),
        OLD.data_source_id,
        OLD.page_id,
        OLD.property_id,
        NEW.value_json,
        OLD.base_hash
      WHERE changes() = 0;

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
      UPDATE notion_row_changes
      SET
        status = 'rejected',
        unsupported_reason = 'Superseded by later direct row lifecycle edit.',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE page_id = OLD.page_id
        AND status IN ('pending', 'queued');

      INSERT INTO notion_row_changes (
        change_id,
        kind,
        data_source_id,
        page_id,
        base_hash
      )
      SELECT
        'row:' || OLD.page_id || ':' || CASE WHEN NEW.in_trash = 1 THEN 'archive' ELSE 'restore' END || ':' || lower(hex(randomblob(8))),
        CASE WHEN NEW.in_trash = 1 THEN 'row_archive' ELSE 'row_restore' END,
        OLD.data_source_id,
        OLD.page_id,
        OLD.properties_hash
      WHERE changes() = 0;

    END;

    CREATE TRIGGER IF NOT EXISTS notion_rows_block_identity_update
    BEFORE UPDATE OF data_source_id, page_id, properties_hash, moved_out, local_delete_candidate ON notion_rows
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'notion_rows identity/hash columns are read-only; edit in_trash to queue an archive/restore intent');
    END;

    CREATE TRIGGER IF NOT EXISTS notion_rows_block_insert
    BEFORE INSERT ON notion_rows
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'notion_rows is observed remote state; insert into notion_row_creates to create a Notion row');
    END;

    CREATE TRIGGER IF NOT EXISTS notion_rows_block_delete
    BEFORE DELETE ON notion_rows
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'deleting notion_rows is unsafe; set in_trash=1 or insert an explicit local change intent');
    END;

    CREATE TRIGGER IF NOT EXISTS notion_cell_changes_mirror_local_insert
    AFTER INSERT ON notion_cell_changes
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO notion_local_changes (
        change_id,
        kind,
        data_source_id,
        page_id,
        property_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        'cell_patch',
        NEW.data_source_id,
        NEW.page_id,
        NEW.property_id,
        NEW.value_json,
        NEW.base_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS notion_cell_changes_mirror_local_update
    AFTER UPDATE ON notion_cell_changes
    FOR EACH ROW
    BEGIN
      UPDATE notion_local_changes
      SET
        value_json = NEW.value_json,
        base_hash = NEW.base_hash,
        status = NEW.status,
        unsupported_reason = NEW.unsupported_reason,
        updated_at = NEW.updated_at
      WHERE change_id = NEW.change_id;
    END;

    CREATE TRIGGER IF NOT EXISTS notion_row_changes_mirror_local_insert
    AFTER INSERT ON notion_row_changes
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO notion_local_changes (
        change_id,
        kind,
        data_source_id,
        page_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        NEW.kind,
        NEW.data_source_id,
        NEW.page_id,
        NEW.value_json,
        NEW.base_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS notion_row_changes_mirror_local_update
    AFTER UPDATE ON notion_row_changes
    FOR EACH ROW
    BEGIN
      UPDATE notion_local_changes
      SET
        kind = NEW.kind,
        page_id = NEW.page_id,
        value_json = NEW.value_json,
        base_hash = NEW.base_hash,
        status = NEW.status,
        unsupported_reason = NEW.unsupported_reason,
        updated_at = NEW.updated_at
      WHERE change_id = NEW.change_id;
    END;

    CREATE TRIGGER IF NOT EXISTS notion_row_creates_mirror_row_change_insert
    AFTER INSERT ON notion_row_creates
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO notion_row_changes (
        change_id,
        kind,
        data_source_id,
        page_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        'row_create',
        NEW.data_source_id,
        NEW.remote_page_id,
        NEW.initial_values_json,
        NEW.base_schema_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS notion_row_creates_mirror_row_change_update
    AFTER UPDATE ON notion_row_creates
    FOR EACH ROW
    BEGIN
      UPDATE notion_row_changes
      SET
        page_id = NEW.remote_page_id,
        value_json = NEW.initial_values_json,
        base_hash = NEW.base_schema_hash,
        status = NEW.status,
        unsupported_reason = NEW.unsupported_reason,
        updated_at = NEW.updated_at
      WHERE change_id = NEW.change_id;
    END;

    CREATE TRIGGER IF NOT EXISTS notion_body_changes_mirror_local_insert
    AFTER INSERT ON notion_body_changes
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO notion_local_changes (
        change_id,
        kind,
        data_source_id,
        page_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        'body_patch',
        '',
        NEW.page_id,
        json_object(
          'body_path', NEW.body_path,
          'local_body_hash', NEW.local_body_hash,
          'local_body_content', NEW.local_body_content
        ),
        NEW.base_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS notion_body_changes_mirror_local_update
    AFTER UPDATE ON notion_body_changes
    FOR EACH ROW
    BEGIN
      UPDATE notion_local_changes
      SET
        value_json = json_object(
          'body_path', NEW.body_path,
          'local_body_hash', NEW.local_body_hash,
          'local_body_content', NEW.local_body_content
        ),
        base_hash = NEW.base_hash,
        status = NEW.status,
        unsupported_reason = NEW.unsupported_reason,
        updated_at = NEW.updated_at
      WHERE change_id = NEW.change_id;
    END;

    CREATE TRIGGER IF NOT EXISTS notion_metadata_changes_mirror_local_insert
    AFTER INSERT ON notion_metadata_changes
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO notion_local_changes (
        change_id,
        kind,
        data_source_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        'metadata_patch',
        NEW.data_source_id,
        json_object(
          'resource_type', NEW.resource_type,
          'title_plain_text', NEW.title_plain_text,
          'description_plain_text', NEW.description_plain_text
        ),
        NEW.base_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS notion_metadata_changes_mirror_local_update
    AFTER UPDATE ON notion_metadata_changes
    FOR EACH ROW
    BEGIN
      UPDATE notion_local_changes
      SET
        value_json = json_object(
          'resource_type', NEW.resource_type,
          'title_plain_text', NEW.title_plain_text,
          'description_plain_text', NEW.description_plain_text
        ),
        base_hash = NEW.base_hash,
        status = NEW.status,
        unsupported_reason = NEW.unsupported_reason,
        updated_at = NEW.updated_at
      WHERE change_id = NEW.change_id;
    END;

    CREATE TRIGGER IF NOT EXISTS notion_schema_changes_mirror_local_insert
    AFTER INSERT ON notion_schema_changes
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO notion_local_changes (
        change_id,
        kind,
        data_source_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        'schema_patch',
        NEW.data_source_id,
        NEW.operation_json,
        NEW.base_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS notion_schema_changes_mirror_local_update
    AFTER UPDATE ON notion_schema_changes
    FOR EACH ROW
    BEGIN
      UPDATE notion_local_changes
      SET
        value_json = NEW.operation_json,
        base_hash = NEW.base_hash,
        status = NEW.status,
        unsupported_reason = NEW.unsupported_reason,
        updated_at = NEW.updated_at
      WHERE change_id = NEW.change_id;
    END;

    CREATE TRIGGER IF NOT EXISTS notion_file_changes_mirror_local_insert
    AFTER INSERT ON notion_file_changes
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO notion_local_changes (
        change_id,
        kind,
        data_source_id,
        page_id,
        property_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        'file_attach',
        NEW.data_source_id,
        NEW.page_id,
        NEW.property_id,
        json_object('asset_id', NEW.asset_id, 'action', NEW.action),
        NEW.base_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS notion_file_changes_mirror_local_update
    AFTER UPDATE ON notion_file_changes
    FOR EACH ROW
    BEGIN
      UPDATE notion_local_changes
      SET
        value_json = json_object('asset_id', NEW.asset_id, 'action', NEW.action),
        base_hash = NEW.base_hash,
        status = NEW.status,
        unsupported_reason = NEW.unsupported_reason,
        updated_at = NEW.updated_at
      WHERE change_id = NEW.change_id;
    END;

    CREATE TRIGGER IF NOT EXISTS notion_conflict_resolutions_mirror_local_insert
    AFTER INSERT ON notion_conflict_resolutions
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO notion_local_changes (
        change_id,
        kind,
        data_source_id,
        value_json,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.resolution_id,
        'conflict_resolution',
        '',
        json_object(
          'conflict_id', NEW.conflict_id,
          'action', NEW.action,
          'value_json', NEW.value_json
        ),
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS notion_conflict_resolutions_mirror_local_update
    AFTER UPDATE ON notion_conflict_resolutions
    FOR EACH ROW
    BEGIN
      UPDATE notion_local_changes
      SET
        value_json = json_object(
          'conflict_id', NEW.conflict_id,
          'action', NEW.action,
          'value_json', NEW.value_json
        ),
        status = NEW.status,
        unsupported_reason = NEW.unsupported_reason,
        updated_at = NEW.updated_at
      WHERE change_id = NEW.resolution_id;
    END;

    CREATE TRIGGER IF NOT EXISTS notion_local_changes_mirror_cell_insert
    AFTER INSERT ON notion_local_changes
    FOR EACH ROW
    WHEN NEW.kind = 'cell_patch'
    BEGIN
      INSERT OR IGNORE INTO notion_cell_changes (
        change_id,
        data_source_id,
        page_id,
        property_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        NEW.data_source_id,
        NEW.page_id,
        NEW.property_id,
        NEW.value_json,
        NEW.base_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS notion_local_changes_mirror_row_insert
    AFTER INSERT ON notion_local_changes
    FOR EACH ROW
    WHEN NEW.kind IN ('row_archive', 'row_restore', 'row_create')
    BEGIN
      INSERT OR IGNORE INTO notion_row_changes (
        change_id,
        kind,
        data_source_id,
        page_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        NEW.kind,
        NEW.data_source_id,
        NEW.page_id,
        NEW.value_json,
        NEW.base_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;
  `)

  ensureReplicaColumn({
    db,
    table: 'notion_data_sources',
    column: 'parent_database_id',
    definition: 'TEXT',
  })
  ensureReplicaColumn({
    db,
    table: 'notion_data_sources',
    column: 'metadata_json',
    definition: 'TEXT',
  })
  ensureReplicaColumn({
    db,
    table: 'notion_data_sources',
    column: 'title_plain_text',
    definition: 'TEXT',
  })
  ensureReplicaColumn({
    db,
    table: 'notion_data_sources',
    column: 'description_plain_text',
    definition: 'TEXT',
  })
  ensureReplicaColumn({
    db,
    table: 'notion_metadata_changes',
    column: 'database_id',
    definition: 'TEXT',
  })

  if (needsLocalChangesStatusMigration === true) {
    db.exec(`
      INSERT OR IGNORE INTO notion_local_changes (
        change_id,
        kind,
        data_source_id,
        page_id,
        property_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      )
      SELECT
        change_id,
        kind,
        data_source_id,
        page_id,
        property_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      FROM notion_local_changes_legacy;

      DROP TABLE notion_local_changes_legacy;
    `)
  }

  db.exec(`
    INSERT OR IGNORE INTO notion_cell_changes (
      change_id,
      data_source_id,
      page_id,
      property_id,
      value_json,
      base_hash,
      status,
      unsupported_reason,
      created_at,
      updated_at
    )
    SELECT
      change_id,
      data_source_id,
      page_id,
      property_id,
      value_json,
      base_hash,
      status,
      unsupported_reason,
      created_at,
      updated_at
    FROM notion_local_changes
    WHERE kind = 'cell_patch'
      AND page_id IS NOT NULL
      AND property_id IS NOT NULL
      AND value_json IS NOT NULL;

    INSERT OR IGNORE INTO notion_row_changes (
      change_id,
      kind,
      data_source_id,
      page_id,
      value_json,
      base_hash,
      status,
      unsupported_reason,
      created_at,
      updated_at
    )
    SELECT
      change_id,
      kind,
      data_source_id,
      page_id,
      value_json,
      base_hash,
      status,
      unsupported_reason,
      created_at,
      updated_at
    FROM notion_local_changes
    WHERE kind IN ('row_archive', 'row_restore', 'row_create');
  `)
}

const clearProjectedReplicaTables = (db: DatabaseSync): void => {
  db.exec(`
    DROP TRIGGER IF EXISTS notion_cells_direct_value_update_intent;
    DROP TRIGGER IF EXISTS notion_cells_guard_direct_value_update;
    DROP TRIGGER IF EXISTS notion_cells_guard_direct_complex_update;
    DROP TRIGGER IF EXISTS notion_cells_block_identity_update;
    DROP TRIGGER IF EXISTS notion_cells_block_delete;
    DROP TRIGGER IF EXISTS notion_rows_archive_restore_intent;
    DROP TRIGGER IF EXISTS notion_rows_block_insert;
    DROP TRIGGER IF EXISTS notion_rows_block_identity_update;
    DROP TRIGGER IF EXISTS notion_rows_block_delete;
    DROP TRIGGER IF EXISTS notion_local_changes_mirror_cell_insert;
    DROP TRIGGER IF EXISTS notion_local_changes_mirror_row_insert;
    DROP TRIGGER IF EXISTS notion_cell_changes_mirror_local_insert;
    DROP TRIGGER IF EXISTS notion_row_changes_mirror_local_insert;
    DROP TRIGGER IF EXISTS notion_file_changes_mirror_local_insert;

    DELETE FROM notion_data_sources;
    DELETE FROM notion_databases;
    DELETE FROM notion_views;
    DELETE FROM notion_properties;
    DELETE FROM notion_rows;
    DELETE FROM notion_cells;
    DELETE FROM notion_relation_targets;
    DELETE FROM notion_bodies;
    DELETE FROM notion_conflicts;
    DELETE FROM notion_sync_status;
  `)
}

const parsePayload = (payloadJson: string): unknown => {
  const decoded = JSON.parse(payloadJson) as { readonly canonicalJson?: unknown }
  return typeof decoded.canonicalJson === 'string' ? JSON.parse(decoded.canonicalJson) : {}
}

const latestDataSourcePayloads = ({
  syncDb,
  rootId,
}: {
  readonly syncDb: DatabaseSync
  readonly rootId: SyncRootId
}): Map<string, Record<string, unknown>> => {
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
    if (Array.isArray(properties) === false) continue
    for (const property of properties) {
      if (typeof property !== 'object' || property === null) continue
      const propertyId = (property as { readonly propertyId?: unknown }).propertyId
      if (typeof propertyId === 'string')
        result.set(propertyId, property as Record<string, unknown>)
    }
  }
  return result
}

const latestPropertyValueJson = ({
  syncDb,
  rootId,
}: {
  readonly syncDb: DatabaseSync
  readonly rootId: SyncRootId
}): Map<string, string> => {
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
    result.set(`${event.pageId}\0${event.propertyId}`, valueJson)
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

const relationValueSetEquals = (leftJson: string, rightJson: string): boolean => {
  try {
    const left = JSON.parse(leftJson) as { readonly _tag?: unknown; readonly pageIds?: unknown }
    const right = JSON.parse(rightJson) as { readonly _tag?: unknown; readonly pageIds?: unknown }
    if (left._tag !== 'relation' || right._tag !== 'relation') return false
    if (Array.isArray(left.pageIds) === false || Array.isArray(right.pageIds) === false)
      return false
    return (
      JSON.stringify([...left.pageIds].toSorted()) === JSON.stringify([...right.pageIds].toSorted())
    )
  } catch {
    return false
  }
}

const cellValueMatches = ({
  observedJson,
  desiredJson,
}: {
  readonly observedJson: string | undefined
  readonly desiredJson: string
}): boolean =>
  observedJson === desiredJson ||
  (observedJson !== undefined && relationValueSetEquals(observedJson, desiredJson) === true)

const settleAppliedCellChangesFromProjection = ({
  replicaDb,
  now,
}: {
  readonly replicaDb: DatabaseSync
  readonly now: string
}): void => {
  const changes = replicaDb
    .prepare(
      `SELECT change_id, page_id, property_id, value_json
       FROM notion_cell_changes
       WHERE status IN ('pending', 'queued', 'planned')`,
    )
    .all() as SqlRow[]
  for (const change of changes) {
    const cell = replicaDb
      .prepare(`SELECT value_json FROM notion_cells WHERE page_id = ? AND property_id = ?`)
      .get(
        readString({ row: change, key: 'page_id' }),
        readString({ row: change, key: 'property_id' }),
      ) as SqlRow | undefined
    if (
      cellValueMatches({
        observedJson:
          cell === undefined ? undefined : readOptionalString({ row: cell, key: 'value_json' }),
        desiredJson: readString({ row: change, key: 'value_json' }),
      }) === false
    )
      continue

    const changeId = readString({ row: change, key: 'change_id' })
    replicaDb
      .prepare(
        `UPDATE notion_cell_changes
         SET status = 'applied', unsupported_reason = NULL, updated_at = ?
         WHERE change_id = ?`,
      )
      .run(now, changeId)
    replicaDb
      .prepare(
        `UPDATE notion_local_changes
         SET status = 'applied', unsupported_reason = NULL, updated_at = ?
         WHERE change_id = ?`,
      )
      .run(now, changeId)
  }
}

const rebuildGeneratedViews = (db: DatabaseSync): void => {
  const existing = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE 'notion_view_%'`)
    .all() as SqlRow[]
  for (const row of existing)
    db.exec(`DROP VIEW IF EXISTS ${quoteIdentifier(readString({ row, key: 'name' }))}`)

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

/** Project the sync store's authoritative events into a user-facing SQLite replica. */
export const projectReplicaFromSyncStore = (options: ProjectReplicaOptions): void => {
  mkdirSync(dirname(options.replicaPath), { recursive: true })
  const syncDb = new DatabaseSync(options.syncStorePath, { readOnly: true })
  const replicaDb = new DatabaseSync(options.replicaPath)
  try {
    createReplicaSchema(replicaDb)
    const schemaPayloads = latestDataSourcePayloads({ syncDb, rootId: options.rootId })
    const valueJsonByCell = latestPropertyValueJson({ syncDb, rootId: options.rootId })
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
      const metadata = new Map<
        string,
        {
          readonly hash: string
          readonly parentDatabaseId: string | undefined
          readonly metadataJson: string | undefined
          readonly titlePlainText: string | undefined
          readonly descriptionPlainText: string | undefined
        }
      >()
      for (const row of metadataRows) {
        const event = JSON.parse(readString({ row, key: 'event_json' })) as {
          readonly dataSourceId?: unknown
          readonly parentDatabaseId?: unknown
          readonly metadataHash?: unknown
          readonly metadataJson?: unknown
          readonly titlePlainText?: unknown
          readonly descriptionPlainText?: unknown
        }
        if (typeof event.dataSourceId === 'string' && typeof event.metadataHash === 'string') {
          metadata.set(event.dataSourceId, {
            hash: event.metadataHash,
            parentDatabaseId:
              typeof event.parentDatabaseId === 'string' ? event.parentDatabaseId : undefined,
            metadataJson:
              typeof event.metadataJson === 'string' ? event.metadataJson : undefined,
            titlePlainText:
              typeof event.titlePlainText === 'string' ? event.titlePlainText : undefined,
            descriptionPlainText:
              typeof event.descriptionPlainText === 'string'
                ? event.descriptionPlainText
                : undefined,
          })
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
        const metadataRow = metadata.get(dataSourceId)
        replicaDb
          .prepare(
            `INSERT INTO notion_data_sources (
               data_source_id, root_id, schema_hash, metadata_hash, metadata_json, title_plain_text,
               description_plain_text, parent_database_id, observed_event_id, observed_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            dataSourceId,
            options.rootId,
            readString({ row, key: 'schema_hash' }),
            metadataRow?.hash ?? null,
            metadataRow?.metadataJson ?? null,
            metadataRow?.titlePlainText ?? null,
            metadataRow?.descriptionPlainText ?? null,
            metadataRow?.parentDatabaseId ?? null,
            readString({ row, key: 'observed_event_id' }),
            readOptionalString({ row, key: 'observed_at' }) ?? null,
            readString({ row, key: 'updated_at' }),
          )
        if (
          metadataRow?.parentDatabaseId !== undefined &&
          metadataRow.metadataJson !== undefined
        ) {
          replicaDb
            .prepare(
              `INSERT OR REPLACE INTO notion_databases (
                 database_id, data_source_id, root_id, metadata_hash, metadata_json,
                 title_plain_text, description_plain_text, observed_event_id, observed_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              metadataRow.parentDatabaseId,
              dataSourceId,
              options.rootId,
              metadataRow.hash,
              metadataRow.metadataJson,
              metadataRow.titlePlainText ?? null,
              metadataRow.descriptionPlainText ?? null,
              readString({ row, key: 'observed_event_id' }),
              readOptionalString({ row, key: 'observed_at' }) ?? null,
              readString({ row, key: 'updated_at' }),
            )
        }
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
          `SELECT event_json, observed_at
           FROM sync_event
           WHERE root_id = ? AND event_type = 'DataSourceViewObserved'
           ORDER BY sequence`,
        )
        .all(options.rootId) as SqlRow[]) {
        const event = JSON.parse(readString({ row, key: 'event_json' })) as {
          readonly dataSourceId?: unknown
          readonly databaseId?: unknown
          readonly viewId?: unknown
          readonly viewName?: unknown
          readonly viewType?: unknown
          readonly viewHash?: unknown
          readonly viewJson?: unknown
          readonly eventId?: unknown
        }
        if (
          typeof event.dataSourceId !== 'string' ||
          typeof event.databaseId !== 'string' ||
          typeof event.viewId !== 'string' ||
          typeof event.viewName !== 'string' ||
          typeof event.viewType !== 'string' ||
          typeof event.viewHash !== 'string' ||
          typeof event.viewJson !== 'string' ||
          typeof event.eventId !== 'string'
        ) {
          continue
        }
        replicaDb
          .prepare(
            `INSERT INTO notion_views (
               view_id, database_id, data_source_id, root_id, view_name, view_type, view_hash,
               view_json, observed_event_id, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(view_id) DO UPDATE SET
               database_id = excluded.database_id,
               data_source_id = excluded.data_source_id,
               root_id = excluded.root_id,
               view_name = excluded.view_name,
               view_type = excluded.view_type,
               view_hash = excluded.view_hash,
               view_json = excluded.view_json,
               observed_event_id = excluded.observed_event_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.viewId,
            event.databaseId,
            event.dataSourceId,
            options.rootId,
            event.viewName,
            event.viewType,
            event.viewHash,
            event.viewJson,
            event.eventId,
            readOptionalString({ row, key: 'observed_at' }) ?? now,
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
            property === undefined
              ? propertyId
              : readString({ row: property, key: 'property_name' }),
            property === undefined
              ? 'unknown'
              : readString({ row: property, key: 'property_type' }),
            valueJson ?? null,
            scalar.text ?? null,
            scalar.number ?? null,
            scalar.boolean ?? null,
            readString({ row, key: 'base_hash' }),
            readString({ row, key: 'remote_hash' }),
            readString({ row, key: 'availability' }),
            property === undefined
              ? 'unsupported'
              : readString({ row: property, key: 'write_class' }),
            readString({ row, key: 'observed_event_id' }),
            readString({ row, key: 'updated_at' }),
          )
        if (valueJson !== undefined && property !== undefined) {
          const propertyType = readString({ row: property, key: 'property_type' })
          if (
            propertyType === 'relation' &&
            readString({ row, key: 'availability' }) === 'complete'
          ) {
            const parsed = JSON.parse(valueJson) as {
              readonly _tag?: unknown
              readonly pageIds?: unknown
            }
            if (parsed._tag === 'relation' && Array.isArray(parsed.pageIds) === true) {
              for (const targetPageId of parsed.pageIds) {
                if (typeof targetPageId !== 'string') continue
                replicaDb
                  .prepare(
                    `INSERT OR IGNORE INTO notion_relation_targets (
                       data_source_id, property_id, target_page_id, observed_from_page_id,
                       observed_event_id, updated_at
                     ) VALUES (?, ?, ?, ?, ?, ?)`,
                  )
                  .run(
                    dataSourceId,
                    propertyId,
                    targetPageId,
                    pageId,
                    readString({ row, key: 'observed_event_id' }),
                    readString({ row, key: 'updated_at' }),
                  )
              }
            }
          }
        }
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

      settleAppliedCellChangesFromProjection({ replicaDb, now })

      const counts = replicaDb
        .prepare(
          `SELECT
             (SELECT count(*) FROM notion_data_sources) AS data_sources,
             (SELECT count(*) FROM notion_rows) AS rows,
             (SELECT count(*) FROM notion_cells) AS cells,
             (SELECT count(*) FROM notion_bodies) AS bodies,
             (SELECT count(*) FROM notion_conflicts WHERE state = 'open') AS conflicts_open,
             (
               (SELECT count(*) FROM notion_cell_changes WHERE status IN ('pending', 'queued')) +
               (SELECT count(*) FROM notion_row_changes WHERE status IN ('pending', 'queued')) +
               (SELECT count(*) FROM notion_row_creates WHERE status IN ('pending', 'queued', 'planned', 'needs_reconciliation')) +
               (SELECT count(*) FROM notion_body_changes WHERE status IN ('pending', 'queued')) +
               (SELECT count(*) FROM notion_metadata_changes WHERE status IN ('pending', 'queued')) +
               (SELECT count(*) FROM notion_schema_changes WHERE status IN ('pending', 'queued')) +
               (SELECT count(*) FROM notion_file_changes WHERE status IN ('pending', 'queued')) +
               (SELECT count(*) FROM notion_conflict_resolutions WHERE status IN ('pending', 'queued'))
             ) AS pending_local_changes`,
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

/** Read the queue of pending local changes captured by the replica's CDC triggers. */
export const readPendingReplicaChanges = (replicaPath: string): readonly ReplicaLocalChange[] => {
  const db = new DatabaseSync(replicaPath)
  try {
    createReplicaSchema(db)
    return (
      db
        .prepare(
          `SELECT
             change_id,
             kind,
             data_source_id,
             page_id,
             property_id,
             value_json,
             base_hash,
             status,
             body_path,
             local_body_hash,
             local_body_content,
             metadata_resource_type,
             database_id,
             title_plain_text,
             description_plain_text,
             schema_operation_json,
             file_asset_id,
             file_action,
             file_name,
             file_external_url,
             conflict_id,
             resolution_action,
             local_row_id,
             client_request_key,
             remote_page_id,
             created_at
           FROM (
             SELECT
               change_id,
               'cell_patch' AS kind,
               data_source_id,
               page_id,
               property_id,
               value_json,
               base_hash,
               status,
               NULL AS body_path,
               NULL AS local_body_hash,
               NULL AS local_body_content,
               NULL AS metadata_resource_type,
               NULL AS database_id,
               NULL AS title_plain_text,
               NULL AS description_plain_text,
               NULL AS schema_operation_json,
               NULL AS file_asset_id,
               NULL AS file_action,
               NULL AS file_name,
               NULL AS file_external_url,
               NULL AS conflict_id,
               NULL AS resolution_action,
               NULL AS local_row_id,
               NULL AS client_request_key,
               NULL AS remote_page_id,
               created_at
             FROM notion_cell_changes
             WHERE status IN ('pending', 'queued')
             UNION ALL
             SELECT
               change_id,
               'row_create' AS kind,
               data_source_id,
               remote_page_id AS page_id,
               NULL AS property_id,
               initial_values_json AS value_json,
               base_schema_hash AS base_hash,
               status,
               NULL AS body_path,
               NULL AS local_body_hash,
               NULL AS local_body_content,
               NULL AS metadata_resource_type,
               NULL AS database_id,
               NULL AS title_plain_text,
               NULL AS description_plain_text,
               NULL AS schema_operation_json,
               NULL AS file_asset_id,
               NULL AS file_action,
               NULL AS file_name,
               NULL AS file_external_url,
               NULL AS conflict_id,
               NULL AS resolution_action,
               local_row_id,
               client_request_key,
               remote_page_id,
               created_at
             FROM notion_row_creates
             WHERE status IN ('pending', 'queued', 'planned', 'needs_reconciliation')
             UNION ALL
             SELECT
               change_id,
               kind,
               data_source_id,
               page_id,
               NULL AS property_id,
               value_json,
               base_hash,
               status,
               NULL AS body_path,
               NULL AS local_body_hash,
               NULL AS local_body_content,
               NULL AS metadata_resource_type,
               NULL AS database_id,
               NULL AS title_plain_text,
               NULL AS description_plain_text,
               NULL AS schema_operation_json,
               NULL AS file_asset_id,
               NULL AS file_action,
               NULL AS file_name,
               NULL AS file_external_url,
               NULL AS conflict_id,
               NULL AS resolution_action,
               NULL AS local_row_id,
               NULL AS client_request_key,
               NULL AS remote_page_id,
               created_at
             FROM notion_row_changes
             WHERE status IN ('pending', 'queued') AND kind != 'row_create'
             UNION ALL
             SELECT
               change_id,
               'body_patch' AS kind,
               '' AS data_source_id,
               page_id,
               NULL AS property_id,
               NULL AS value_json,
               base_hash,
               status,
               body_path,
               local_body_hash,
               local_body_content,
               NULL AS metadata_resource_type,
               NULL AS database_id,
               NULL AS title_plain_text,
               NULL AS description_plain_text,
               NULL AS schema_operation_json,
               NULL AS file_asset_id,
               NULL AS file_action,
               NULL AS file_name,
               NULL AS file_external_url,
               NULL AS conflict_id,
               NULL AS resolution_action,
               NULL AS local_row_id,
               NULL AS client_request_key,
               NULL AS remote_page_id,
               created_at
             FROM notion_body_changes
             WHERE status IN ('pending', 'queued')
             UNION ALL
             SELECT
               change_id,
               'metadata_patch' AS kind,
               data_source_id,
               NULL AS page_id,
               NULL AS property_id,
               NULL AS value_json,
               base_hash,
               status,
               NULL AS body_path,
               NULL AS local_body_hash,
               NULL AS local_body_content,
               resource_type AS metadata_resource_type,
               database_id,
               title_plain_text,
               description_plain_text,
               NULL AS schema_operation_json,
               NULL AS file_asset_id,
               NULL AS file_action,
               NULL AS file_name,
               NULL AS file_external_url,
               NULL AS conflict_id,
               NULL AS resolution_action,
               NULL AS local_row_id,
               NULL AS client_request_key,
               NULL AS remote_page_id,
               created_at
             FROM notion_metadata_changes
             WHERE status IN ('pending', 'queued')
             UNION ALL
             SELECT
               change_id,
               'schema_patch' AS kind,
               data_source_id,
               NULL AS page_id,
               NULL AS property_id,
               NULL AS value_json,
               base_hash,
               status,
               NULL AS body_path,
               NULL AS local_body_hash,
               NULL AS local_body_content,
               NULL AS metadata_resource_type,
               NULL AS database_id,
               NULL AS title_plain_text,
               NULL AS description_plain_text,
               operation_json AS schema_operation_json,
               NULL AS file_asset_id,
               NULL AS file_action,
               NULL AS file_name,
               NULL AS file_external_url,
               NULL AS conflict_id,
               NULL AS resolution_action,
               NULL AS local_row_id,
               NULL AS client_request_key,
               NULL AS remote_page_id,
               created_at
             FROM notion_schema_changes
             WHERE status IN ('pending', 'queued')
             UNION ALL
             SELECT
               fc.change_id,
               'file_attach' AS kind,
               fc.data_source_id,
               fc.page_id,
               fc.property_id,
               NULL AS value_json,
               fc.base_hash,
               fc.status,
               NULL AS body_path,
               NULL AS local_body_hash,
               NULL AS local_body_content,
               NULL AS metadata_resource_type,
               NULL AS database_id,
               NULL AS title_plain_text,
               NULL AS description_plain_text,
               NULL AS schema_operation_json,
               fc.asset_id AS file_asset_id,
               fc.action AS file_action,
               fa.name AS file_name,
               fa.external_url AS file_external_url,
               NULL AS conflict_id,
               NULL AS resolution_action,
               NULL AS local_row_id,
               NULL AS client_request_key,
               NULL AS remote_page_id,
               fc.created_at
             FROM notion_file_changes fc
             JOIN notion_file_assets fa ON fa.asset_id = fc.asset_id
             WHERE fc.status IN ('pending', 'queued')
             UNION ALL
             SELECT
               resolution_id AS change_id,
               'conflict_resolution' AS kind,
               '' AS data_source_id,
               NULL AS page_id,
               NULL AS property_id,
               value_json,
               NULL AS base_hash,
               status,
               NULL AS body_path,
               NULL AS local_body_hash,
               NULL AS local_body_content,
               NULL AS metadata_resource_type,
               NULL AS database_id,
               NULL AS title_plain_text,
               NULL AS description_plain_text,
               NULL AS schema_operation_json,
               NULL AS file_asset_id,
               NULL AS file_action,
               NULL AS file_name,
               NULL AS file_external_url,
               conflict_id,
               action AS resolution_action,
               NULL AS local_row_id,
               NULL AS client_request_key,
               NULL AS remote_page_id,
               created_at
             FROM notion_conflict_resolutions
             WHERE status IN ('pending', 'queued')
           )
           ORDER BY created_at, change_id`,
        )
        .all() as SqlRow[]
    ).map((row) => ({
      changeId: readString({ row, key: 'change_id' }),
      kind: Schema.decodeUnknownSync(
        Schema.Literal(
          'cell_patch',
          'row_archive',
          'row_restore',
          'row_create',
          'body_patch',
          'metadata_patch',
          'schema_patch',
          'file_attach',
          'conflict_resolution',
        ),
      )(readString({ row, key: 'kind' })),
      dataSourceId: readString({ row, key: 'data_source_id' }),
      pageId: readOptionalString({ row, key: 'page_id' }),
      propertyId: readOptionalString({ row, key: 'property_id' }),
      valueJson: readOptionalString({ row, key: 'value_json' }),
      baseHash: readOptionalString({ row, key: 'base_hash' }),
      status: readString({ row, key: 'status' }),
      bodyPath: readOptionalString({ row, key: 'body_path' }),
      localBodyHash: readOptionalString({ row, key: 'local_body_hash' }),
      localBodyContent: readOptionalString({ row, key: 'local_body_content' }),
      metadataResourceType: readOptionalString({ row, key: 'metadata_resource_type' }),
      databaseId: readOptionalString({ row, key: 'database_id' }),
      titlePlainText: readOptionalString({ row, key: 'title_plain_text' }),
      descriptionPlainText: readOptionalString({ row, key: 'description_plain_text' }),
      schemaOperationJson: readOptionalString({ row, key: 'schema_operation_json' }),
      fileAssetId: readOptionalString({ row, key: 'file_asset_id' }),
      fileAction: readOptionalString({ row, key: 'file_action' }),
      fileName: readOptionalString({ row, key: 'file_name' }),
      fileExternalUrl: readOptionalString({ row, key: 'file_external_url' }),
      conflictId: readOptionalString({ row, key: 'conflict_id' }),
      resolutionAction: readOptionalString({ row, key: 'resolution_action' }),
      localRowId: readOptionalString({ row, key: 'local_row_id' }),
      clientRequestKey: readOptionalString({ row, key: 'client_request_key' }),
      remotePageId: readOptionalString({ row, key: 'remote_page_id' }),
    }))
  } finally {
    db.close()
  }
}

/** Mark a replica change as planned, applied, rejected, or otherwise progressed. */
export const markReplicaChangeStatus = ({
  replicaPath,
  changeId,
  status,
  unsupportedReason,
}: {
  readonly replicaPath: string
  readonly changeId: string
  readonly status: Exclude<ReplicaChangeStatus, 'pending'>
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
    db.prepare(
      `UPDATE notion_cell_changes
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE change_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
    db.prepare(
      `UPDATE notion_row_changes
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE change_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
    db.prepare(
      `UPDATE notion_row_creates
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE change_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
    db.prepare(
      `UPDATE notion_body_changes
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE change_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
    db.prepare(
      `UPDATE notion_metadata_changes
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE change_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
    db.prepare(
      `UPDATE notion_schema_changes
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE change_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
    db.prepare(
      `UPDATE notion_file_changes
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE change_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
    db.prepare(
      `UPDATE notion_conflict_resolutions
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE resolution_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
  } finally {
    db.close()
  }
}

const markChange = ({
  replicaPath,
  dryRun,
  changeId,
  status,
  reason,
}: {
  readonly replicaPath: string
  readonly dryRun?: boolean | undefined
  readonly changeId: string
  readonly status: Exclude<ReplicaChangeStatus, 'pending'>
  readonly reason?: string
}): void => {
  if (dryRun === true) return
  markReplicaChangeStatus({
    replicaPath,
    changeId,
    status,
    ...(reason === undefined ? {} : { unsupportedReason: reason }),
  })
}

const conflictResolutionChoiceForChange = (
  change: ReplicaLocalChange,
): Parameters<typeof resolveConflictCommand>[0]['choice'] | string => {
  switch (change.resolutionAction) {
    case 'choose_remote':
    case 'abandon_local':
      return { _tag: 'keep-remote' }
    case 'choose_local':
    case 'manual_value':
      return 'choose_local/manual_value conflict resolution needs property-write post-hash reconciliation before SQLite CDC can execute it safely.'
    case 'retry_after_refresh':
      return 'retry_after_refresh needs a fresh pull/replan workflow before it can be executed from SQLite CDC.'
    default:
      return `Unsupported conflict resolution action: ${change.resolutionAction ?? 'unknown'}.`
  }
}

/** Apply pending conflict-resolution CDC rows through the store-backed user-command surface. */
export const applyReplicaConflictResolutions = ({
  changes,
  replicaPath,
  store,
  rootId,
  dryRun,
}: ApplyReplicaConflictResolutionsOptions): void => {
  for (const change of changes) {
    if (change.kind !== 'conflict_resolution') continue
    if (change.conflictId === undefined) {
      markChange({
        replicaPath,
        dryRun,
        changeId: change.changeId,
        status: 'rejected',
        reason: 'conflict_resolution requires conflict_id.',
      })
      continue
    }

    let conflictId: SyncEventId
    try {
      conflictId = decode({ schema: SyncEventId, value: change.conflictId })
    } catch {
      markChange({
        replicaPath,
        dryRun,
        changeId: change.changeId,
        status: 'rejected',
        reason: 'Invalid conflict_id in conflict_resolution.',
      })
      continue
    }

    const choice = conflictResolutionChoiceForChange(change)
    if (typeof choice === 'string') {
      markChange({
        replicaPath,
        dryRun,
        changeId: change.changeId,
        status:
          choice.startsWith('retry_after_refresh') === true ||
          choice.startsWith('Unsupported') === true ||
          choice.startsWith('choose_local/manual_value') === true
            ? 'unsupported'
            : 'rejected',
        reason: choice,
      })
      continue
    }

    const result = resolveConflictCommand({
      store,
      rootId,
      conflictId,
      choice,
      ...(dryRun === undefined ? {} : { dryRun }),
    })
    const guard = result.planned.guards[0]
    if (guard !== undefined) {
      markChange({
        replicaPath,
        dryRun,
        changeId: change.changeId,
        status: 'conflict',
        reason: guard.message,
      })
      continue
    }

    markChange({
      replicaPath,
      dryRun,
      changeId: change.changeId,
      status: result.planned.commands.length > 0 ? 'planned' : 'applied',
    })
  }
}

const surfaceForReplicaChange = (change: ReplicaLocalChange): string | undefined => {
  if (
    change.kind === 'cell_patch' &&
    change.pageId !== undefined &&
    change.propertyId !== undefined
  ) {
    return propertySurfaceKey({
      pageId: decode({ schema: PageId, value: change.pageId }),
      propertyId: decode({ schema: PropertyId, value: change.propertyId }),
    })
  }
  if (
    (change.kind === 'row_archive' || change.kind === 'row_restore') &&
    change.pageId !== undefined
  ) {
    return pageSurfaceKey(decode({ schema: PageId, value: change.pageId }))
  }
  if (change.kind === 'body_patch' && change.pageId !== undefined) {
    return bodySurfaceKey(decode({ schema: PageId, value: change.pageId }))
  }
  if (change.kind === 'metadata_patch' && change.dataSourceId.length > 0) {
    if (change.metadataResourceType === 'database' && change.databaseId !== undefined) {
      return databaseMetadataSurfaceKey(
        decode({ schema: DatabaseId, value: change.databaseId }),
      )
    }
    return dataSourceMetadataSurfaceKey(
      decode({ schema: DataSourceId, value: change.dataSourceId }),
    )
  }
  if (change.kind === 'schema_patch' && change.dataSourceId.length > 0) {
    return schemaSurfaceKey({
      dataSourceId: decode({ schema: DataSourceId, value: change.dataSourceId }),
      propertyId: decode({ schema: PropertyId, value: `replica:${change.changeId}` }),
    })
  }
  if (
    change.kind === 'file_attach' &&
    change.pageId !== undefined &&
    change.propertyId !== undefined
  ) {
    return propertySurfaceKey({
      pageId: decode({ schema: PageId, value: change.pageId }),
      propertyId: decode({ schema: PropertyId, value: change.propertyId }),
    })
  }
  if (change.kind === 'row_create' && change.dataSourceId.length > 0) {
    return schemaSurfaceKey({
      dataSourceId: decode({ schema: DataSourceId, value: change.dataSourceId }),
      propertyId: decode({ schema: PropertyId, value: `replica-create:${change.changeId}` }),
    })
  }
  return undefined
}

const decisionForReplicaChange = ({
  change,
  decisions,
}: {
  readonly change: ReplicaLocalChange
  readonly decisions: readonly PlanDecision[]
}): PlanDecision | undefined => {
  const commandId = `replica:${change.changeId}`
  const commandDecision = decisions.find(
    (decision) =>
      decision._tag === 'EnqueueCommands' &&
      decision.commands.some((command) => command.commandId === commandId),
  )
  if (commandDecision !== undefined) return commandDecision

  const surface = surfaceForReplicaChange(change)
  if (surface === undefined) return undefined
  return decisions.find(
    (decision) =>
      (decision._tag === 'BlockedByGuard' && decision.surface === surface) ||
      (decision._tag === 'OpenConflict' && decision.conflict.localSurface === surface),
  )
}

const settlementStatusForOutboxState = (
  state: ReturnType<NotionSyncStore['readOutbox']>[number]['state'],
): Exclude<ReplicaChangeStatus, 'pending'> => {
  switch (state) {
    case 'settled':
      return 'applied'
    case 'blocked':
    case 'fenced':
      return 'conflict'
    case 'queued':
    case 'running':
    case 'retryable':
    case 'ambiguous':
      return 'planned'
  }
}

const createdPageIdForCommand = ({
  store,
  rootId,
  commandId,
}: {
  readonly store: NotionSyncStore
  readonly rootId: SyncRootId
  readonly commandId: string
}): string | undefined => {
  const events = store
    .replay(rootId)
    .filter((event) => event._tag === 'RemoteWriteSettled' && event.commandId === commandId)
  const event = events.at(-1)
  return event?._tag === 'RemoteWriteSettled' ? event.createdPageId : undefined
}

/** Settle public replica CDC statuses from planner decisions and durable outbox state. */
export const settleReplicaChangesAfterSync = ({
  changes,
  replicaPath,
  store,
  rootId,
  decisions,
  dryRun,
}: SettleReplicaChangesOptions): void => {
  if (dryRun === true) return
  const outboxByCommandId = new Map(
    store.readOutbox(rootId).map((row) => [row.commandId, row] as const),
  )
  for (const change of changes) {
    if (change.kind === 'conflict_resolution') continue
    const decision = decisionForReplicaChange({ change, decisions })
    if (decision === undefined) {
      const outbox = outboxByCommandId.get(`replica:${change.changeId}`)
      if (outbox === undefined) continue
      if (change.kind === 'row_create' && outbox.state === 'ambiguous') {
        markChange({
          replicaPath,
          changeId: change.changeId,
          status: 'needs_reconciliation',
          reason:
            'Create command has an ambiguous remote outcome after an expired running attempt; manual reconciliation is required before retry.',
        })
        continue
      }
      if (change.kind === 'row_create' && outbox.state === 'settled') {
        const createdPageId = createdPageIdForCommand({
          store,
          rootId,
          commandId: outbox.commandId,
        })
        if (createdPageId === undefined) {
          markChange({
            replicaPath,
            changeId: change.changeId,
            status: 'needs_reconciliation',
            reason:
              'Create command settled without a durable created page id; manual reconciliation is required before retry.',
          })
          continue
        }
        const db = new DatabaseSync(replicaPath)
        try {
          createReplicaSchema(db)
          db.prepare(
            `UPDATE notion_row_creates
             SET remote_page_id = ?, status = 'applied', unsupported_reason = NULL, updated_at = ?
             WHERE change_id = ?`,
          ).run(createdPageId, new Date().toISOString(), change.changeId)
        } finally {
          db.close()
        }
        continue
      }
      markChange({
        replicaPath,
        changeId: change.changeId,
        status: settlementStatusForOutboxState(outbox.state),
        ...(outbox.state === 'blocked' || outbox.state === 'fenced'
          ? {
              reason:
                'Remote write was blocked during executor preflight; inspect sync status and outbox diagnostics.',
            }
          : {}),
      })
      continue
    }
    if (decision._tag === 'OpenConflict') {
      markChange({
        replicaPath,
        changeId: change.changeId,
        status: 'conflict',
        reason: decision.conflict.message,
      })
      continue
    }
    if (decision._tag === 'BlockedByGuard') {
      markChange({
        replicaPath,
        changeId: change.changeId,
        status:
          decision.guard === 'StaleSurfaceBase' || decision.guard === 'DeleteVsEdit'
            ? 'conflict'
            : 'unsupported',
        reason: decision.detail.summary,
      })
      continue
    }
    if (decision._tag !== 'EnqueueCommands') continue
    const command = decision.commands.find(
      (candidate) => candidate.commandId === `replica:${change.changeId}`,
    )
    if (command === undefined) continue
    const outbox = outboxByCommandId.get(command.commandId)
    if (outbox === undefined) continue
    if (change.kind === 'row_create' && outbox.state === 'ambiguous') {
      markChange({
        replicaPath,
        changeId: change.changeId,
        status: 'needs_reconciliation',
        reason:
          'Create command has an ambiguous remote outcome after an expired running attempt; manual reconciliation is required before retry.',
      })
      continue
    }
    if (change.kind === 'row_create' && outbox.state === 'settled') {
      const createdPageId = createdPageIdForCommand({
        store,
        rootId,
        commandId: command.commandId,
      })
      if (createdPageId === undefined) {
        markChange({
          replicaPath,
          changeId: change.changeId,
          status: 'needs_reconciliation',
          reason:
            'Create command settled without a durable created page id; manual reconciliation is required before retry.',
        })
        continue
      }
      const db = new DatabaseSync(replicaPath)
      try {
        createReplicaSchema(db)
        db.prepare(
          `UPDATE notion_row_creates
           SET remote_page_id = ?, status = 'applied', unsupported_reason = NULL, updated_at = ?
           WHERE change_id = ?`,
        ).run(createdPageId, new Date().toISOString(), change.changeId)
      } finally {
        db.close()
      }
      continue
    }
    markChange({
      replicaPath,
      changeId: change.changeId,
      status: settlementStatusForOutboxState(outbox.state),
      ...(outbox.state === 'blocked' || outbox.state === 'fenced'
        ? {
            reason:
              'Remote write was blocked during executor preflight; inspect sync status and outbox diagnostics.',
          }
        : {}),
    })
  }
}

/** Translate pending replica changes into planner intents the sync executor can consume. */
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
        if (change.remotePageId !== undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'planned',
            reason: 'Row create already has a remote_page_id and is waiting for observation.',
          })
          continue
        }
        if (
          change.valueJson === undefined ||
          change.baseHash === undefined ||
          change.clientRequestKey === undefined ||
          change.localRowId === undefined
        ) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason:
              'row_create requires initial_values_json, base_schema_hash, local_row_id, and client_request_key.',
          })
          continue
        }
        let dataSourceId: DataSourceId
        let baseSchemaHash: Hash
        let initialProperties: Record<PropertyId, typeof CanonicalPropertyValue.Type>
        try {
          dataSourceId = decode({ schema: DataSourceId, value: change.dataSourceId })
          baseSchemaHash = decode({ schema: Hash, value: change.baseHash })
          const parsed = JSON.parse(change.valueJson) as Record<string, unknown>
          initialProperties = Object.fromEntries(
            Object.entries(parsed).map(([propertyId, value]) => [
              decode({ schema: PropertyId, value: propertyId }),
              Schema.decodeUnknownSync(CanonicalPropertyValue)(value),
            ]),
          ) as Record<PropertyId, typeof CanonicalPropertyValue.Type>
        } catch {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'row_create initial_values_json must map property ids to canonical values.',
          })
          continue
        }
        const dataSource = db
          .prepare(`SELECT schema_hash FROM notion_data_sources WHERE data_source_id = ?`)
          .get(change.dataSourceId) as SqlRow | undefined
        if (dataSource === undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'row_create targets a data source that is not present in the replica.',
          })
          continue
        }
        if (change.baseHash !== readString({ row: dataSource, key: 'schema_hash' })) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'conflict',
            reason: 'row_create has a stale base_schema_hash.',
          })
          continue
        }
        const properties = db
          .prepare(
            `SELECT property_id, property_type, write_class
             FROM notion_properties
             WHERE data_source_id = ?`,
          )
          .all(change.dataSourceId) as SqlRow[]
        const propertyById = new Map(
          properties.map((property) => [
            readString({ row: property, key: 'property_id' }),
            property,
          ]),
        )
        const hasTitle = properties.some(
          (property) =>
            readString({ row: property, key: 'property_type' }) === 'title' &&
            initialProperties[readString({ row: property, key: 'property_id' }) as PropertyId]
              ?._tag === 'title',
        )
        if (hasTitle === false) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'row_create requires an initial title property value.',
          })
          continue
        }
        const unsupported = Object.entries(initialProperties).find(([propertyId, value]) => {
          const property = propertyById.get(propertyId)
          if (property === undefined) return true
          if (readString({ row: property, key: 'write_class' }) !== 'writable') return true
          const propertyType = readString({ row: property, key: 'property_type' })
          return (
            ['relation', 'people', 'files'].includes(propertyType) ||
            ['relation', 'people', 'files', 'computed', 'empty'].includes(value._tag)
          )
        })
        if (unsupported !== undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason:
              'row_create supports only writable scalar/select/status initial values; relation, people, files, empty, and computed values remain fail-closed.',
          })
          continue
        }
        const desiredHash = hashStoreBytes(change.valueJson)
        const commandId = decode({ schema: CommandId, value: `replica:${change.changeId}` })
        intents.push({
          _tag: 'row-create',
          intentEventId: decode({ schema: SyncEventId, value: `replica:${change.changeId}` }),
          commandKey: decode({
            schema: IdempotencyKey,
            value: `replica:create:${change.dataSourceId}:${change.clientRequestKey}`,
          }),
          surface: schemaSurfaceKey({
            dataSourceId,
            propertyId: decode({ schema: PropertyId, value: `replica-create:${change.changeId}` }),
          }),
          dataSourceId,
          command: CreatePageCommand.make({
            _tag: 'CreatePageCommand',
            commandId,
            dataSourceId,
            clientRequestKey: change.clientRequestKey,
            baseSchemaHash,
            initialProperties,
          }),
          baseHash: baseSchemaHash,
          desiredHash,
        })
        continue
      }
      if (change.kind === 'conflict_resolution') {
        markChange({
          replicaPath,
          dryRun,
          changeId: change.changeId,
          status: 'unsupported',
          reason:
            'Conflict resolution CDC requires store-backed execution; sync <workspace> handles it before planner-intent conversion.',
        })
        continue
      }
      if (change.kind === 'metadata_patch') {
        if (change.metadataResourceType === 'database') {
          if (change.baseHash === undefined) {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'rejected',
              reason: 'database metadata_patch requires base_hash.',
            })
            continue
          }
          if (change.databaseId === undefined) {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'rejected',
              reason: 'database metadata_patch requires database_id.',
            })
            continue
          }
          const database = db
            .prepare(
              `SELECT data_source_id, metadata_hash, metadata_json
               FROM notion_databases
               WHERE database_id = ?`,
            )
            .get(change.databaseId) as SqlRow | undefined
          if (database === undefined) {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'rejected',
              reason: 'database metadata_patch targets a database that is not present in the replica.',
            })
            continue
          }
          const metadataHash = readString({ row: database, key: 'metadata_hash' })
          const metadataJson = readString({ row: database, key: 'metadata_json' })
          const dataSourceIdString = readString({ row: database, key: 'data_source_id' })
          if (metadataHash !== change.baseHash) {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'conflict',
              reason: 'database metadata_patch has a stale base_hash.',
            })
            continue
          }
          let databaseId: DatabaseId
          let dataSourceId: DataSourceId
          let baseMetadataHash: Hash
          let currentMetadata: CanonicalDataSourceMetadata
          try {
            databaseId = decode({ schema: DatabaseId, value: change.databaseId })
            dataSourceId = decode({ schema: DataSourceId, value: dataSourceIdString })
            baseMetadataHash = decode({ schema: Hash, value: change.baseHash })
            currentMetadata = Schema.decodeUnknownSync(Schema.parseJson(CanonicalDataSourceMetadata))(
              metadataJson,
            )
          } catch {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'rejected',
              reason:
                'database metadata_patch contains invalid database_id, data_source_id, base_hash, or metadata_json.',
            })
            continue
          }
          const nextMetadata: CanonicalDataSourceMetadata = {
            ...currentMetadata,
            ...(change.titlePlainText === undefined
              ? {}
              : { titlePlainText: change.titlePlainText }),
            ...(change.descriptionPlainText === undefined
              ? {}
              : { descriptionPlainText: change.descriptionPlainText }),
          }
          const desiredHash = dataSourceMetadataHash(nextMetadata)
          const commandId = decode({ schema: CommandId, value: `replica:${change.changeId}` })
          intents.push({
            _tag: 'database-metadata-edit',
            intentEventId: decode({ schema: SyncEventId, value: `replica:${change.changeId}` }),
            commandKey: decode({ schema: IdempotencyKey, value: `replica:${change.changeId}` }),
            surface: databaseMetadataSurfaceKey(databaseId),
            databaseId,
            dataSourceId,
            command: PatchDatabaseMetadataCommand.make({
              _tag: 'PatchDatabaseMetadataCommand',
              commandId,
              databaseId,
              dataSourceId,
              baseMetadataHash,
              metadataPatch: {
                ...(change.titlePlainText === undefined
                  ? {}
                  : { titlePlainText: change.titlePlainText }),
                ...(change.descriptionPlainText === undefined
                  ? {}
                  : { descriptionPlainText: change.descriptionPlainText }),
              },
            }),
            baseHash: baseMetadataHash,
            desiredHash,
          })
          continue
        }
        if (change.metadataResourceType !== 'data_source') {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason:
              'Database metadata CDC needs a separate database authority projection and remains fail-closed.',
          })
          continue
        }
        if (change.baseHash === undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'metadata_patch requires base_hash.',
          })
          continue
        }
        const dataSource = db
          .prepare(
            `SELECT metadata_hash, metadata_json
             FROM notion_data_sources
             WHERE data_source_id = ?`,
          )
          .get(change.dataSourceId) as SqlRow | undefined
        if (dataSource === undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'metadata_patch targets a data source that is not present in the replica.',
          })
          continue
        }
        const metadataHash = readOptionalString({ row: dataSource, key: 'metadata_hash' })
        const metadataJson = readOptionalString({ row: dataSource, key: 'metadata_json' })
        if (metadataHash === undefined || metadataJson === undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason:
              'metadata_patch requires canonical metadata projection before post-write hash reconciliation can be computed.',
          })
          continue
        }
        if (metadataHash !== change.baseHash) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'conflict',
            reason: 'metadata_patch has a stale base_hash.',
          })
          continue
        }
        let dataSourceId: DataSourceId
        let baseMetadataHash: Hash
        let currentMetadata: CanonicalDataSourceMetadata
        try {
          dataSourceId = decode({ schema: DataSourceId, value: change.dataSourceId })
          baseMetadataHash = decode({ schema: Hash, value: change.baseHash })
          currentMetadata = Schema.decodeUnknownSync(Schema.parseJson(CanonicalDataSourceMetadata))(
            metadataJson,
          )
        } catch {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'metadata_patch contains invalid data_source_id, base_hash, or metadata_json.',
          })
          continue
        }
        const nextMetadata: CanonicalDataSourceMetadata = {
          ...currentMetadata,
          ...(change.titlePlainText === undefined
            ? {}
            : { titlePlainText: change.titlePlainText }),
          ...(change.descriptionPlainText === undefined
            ? {}
            : { descriptionPlainText: change.descriptionPlainText }),
        }
        const desiredHash = dataSourceMetadataHash(nextMetadata)
        const commandId = decode({ schema: CommandId, value: `replica:${change.changeId}` })
        intents.push({
          _tag: 'data-source-metadata-edit',
          intentEventId: decode({ schema: SyncEventId, value: `replica:${change.changeId}` }),
          commandKey: decode({ schema: IdempotencyKey, value: `replica:${change.changeId}` }),
          surface: dataSourceMetadataSurfaceKey(dataSourceId),
          dataSourceId,
          command: PatchDataSourceMetadataCommand.make({
            _tag: 'PatchDataSourceMetadataCommand',
            commandId,
            dataSourceId,
            baseMetadataHash,
            metadataPatch: {
              ...(change.titlePlainText === undefined
                ? {}
                : { titlePlainText: change.titlePlainText }),
              ...(change.descriptionPlainText === undefined
                ? {}
                : { descriptionPlainText: change.descriptionPlainText }),
            },
          }),
          baseHash: baseMetadataHash,
          desiredHash,
        })
        continue
      }
      if (change.kind === 'schema_patch') {
        markChange({
          replicaPath,
          dryRun,
          changeId: change.changeId,
          status: 'unsupported',
          reason:
            'Public schema CDC needs expected post-schema hash reconciliation before remote execution; use the dedicated schema command path until that projection exists.',
        })
        continue
      }
      if (change.kind === 'body_patch') {
        if (
          change.pageId === undefined ||
          change.baseHash === undefined ||
          change.localBodyHash === undefined
        ) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'body_patch requires page_id, base_hash, and local_body_hash.',
          })
          continue
        }
        if (
          change.localBodyContent !== undefined &&
          hashStoreBytes(change.localBodyContent) !== change.localBodyHash
        ) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'body_patch local_body_content does not match local_body_hash.',
          })
          continue
        }
        let pageId: PageId
        let baseHash: Hash
        let localBodyHash: Hash
        try {
          pageId = decode({ schema: PageId, value: change.pageId })
          baseHash = decode({ schema: Hash, value: change.baseHash })
          localBodyHash = decode({ schema: Hash, value: change.localBodyHash })
        } catch {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'Invalid page_id, base_hash, or local_body_hash in body_patch.',
          })
          continue
        }
        const body = db
          .prepare(
            `SELECT path, current_hash, safety_json, sidecar_identity_proven
             FROM notion_bodies
             WHERE page_id = ?`,
          )
          .get(change.pageId) as SqlRow | undefined
        if (body === undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'body_patch targets a page body that is not present in the replica.',
          })
          continue
        }
        if (readNumber({ row: body, key: 'sidecar_identity_proven' }) !== 1) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason: 'Body writes require a proven local sidecar identity.',
          })
          continue
        }
        if (change.baseHash !== readString({ row: body, key: 'current_hash' })) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'conflict',
            reason: 'body_patch has a stale base_hash.',
          })
          continue
        }
        let safety: unknown
        try {
          safety = JSON.parse(readString({ row: body, key: 'safety_json' }))
        } catch {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason: 'Body safety metadata is not valid JSON.',
          })
          continue
        }
        const bodyPointer = decode({
          schema: BodyPointer,
          value: {
            _tag: 'BodyPointer',
            pageId,
            bodyHash: baseHash,
            observedAt: new Date().toISOString(),
            safety,
          },
        })
        intents.push({
          _tag: 'body-edit',
          intentEventId: decode({ schema: SyncEventId, value: `replica:${change.changeId}` }),
          commandKey: decode({ schema: IdempotencyKey, value: `replica:${change.changeId}` }),
          surface: bodySurfaceKey(pageId),
          pageId,
          command: BodyPushCommand.make({
            _tag: 'BodyPushCommand',
            commandId: decode({ schema: CommandId, value: `replica:${change.changeId}` }),
            pageId,
            baseBodyPointer: bodyPointer,
            nextBodyHash: localBodyHash,
            ...(change.bodyPath === undefined
              ? {}
              : {
                  localBodyPath: decode({ schema: WorkspaceRelativePath, value: change.bodyPath }),
                }),
            ...(change.localBodyContent === undefined
              ? {}
              : { localBodyContent: change.localBodyContent }),
          }),
          baseHash,
          desiredHash: localBodyHash,
        })
        continue
      }
      if (change.kind === 'file_attach') {
        if (
          change.pageId === undefined ||
          change.propertyId === undefined ||
          change.baseHash === undefined ||
          change.fileAssetId === undefined ||
          change.fileAction === undefined
        ) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason:
              'file_attach requires page_id, property_id, asset_id, action, and base_hash.',
          })
          continue
        }
        if (change.fileAction !== 'attach_external_url') {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason:
              'Only external URL file attachments are supported; local uploads need upload-id/status/retry modeling.',
          })
          continue
        }
        if (change.fileName === undefined || change.fileExternalUrl === undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'attach_external_url requires a file asset name and external_url.',
          })
          continue
        }
        let pageId: PageId
        let propertyId: PropertyId
        let baseHash: Hash
        try {
          pageId = decode({ schema: PageId, value: change.pageId })
          propertyId = decode({ schema: PropertyId, value: change.propertyId })
          decode({ schema: DataSourceId, value: change.dataSourceId })
          baseHash = decode({ schema: Hash, value: change.baseHash })
        } catch {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'Invalid data_source_id, page_id, property_id, or base_hash in file_attach.',
          })
          continue
        }
        const cell = db
          .prepare(
            `SELECT c.value_json, c.base_hash, c.remote_hash, r.properties_hash,
                    p.config_hash, p.write_class, p.property_type
             FROM notion_cells c
             JOIN notion_rows r ON r.page_id = c.page_id
             JOIN notion_properties p
               ON p.data_source_id = c.data_source_id AND p.property_id = c.property_id
             WHERE c.page_id = ? AND c.property_id = ?`,
          )
          .get(change.pageId, change.propertyId) as SqlRow | undefined
        if (cell === undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'file_attach targets a cell that is not present in the replica.',
          })
          continue
        }
        if (
          readString({ row: cell, key: 'property_type' }) !== 'files' ||
          readString({ row: cell, key: 'write_class' }) !== 'writable'
        ) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason: 'file_attach targets must be writable files properties.',
          })
          continue
        }
        if (change.baseHash !== readString({ row: cell, key: 'base_hash' })) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'conflict',
            reason: 'file_attach has a stale base_hash.',
          })
          continue
        }
        const currentValueJson = readOptionalString({ row: cell, key: 'value_json' })
        let currentValue: typeof CanonicalPropertyValue.Type
        if (
          currentValueJson === undefined ||
          currentValueJson === 'null' ||
          currentValueJson === '[]'
        ) {
          currentValue = { _tag: 'files', files: [] }
        } else {
          try {
            currentValue = decode({
              schema: Schema.parseJson(CanonicalPropertyValue),
              value: currentValueJson,
            })
          } catch {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'unsupported',
              reason:
                'External file attach requires an empty canonical files cell; raw file payload preservation is not modeled.',
            })
            continue
          }
        }
        if (currentValue._tag !== 'files' || currentValue.files.length > 0) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason:
              'External file attach is supported only for empty files properties until durable preservation of existing file identities is modeled.',
          })
          continue
        }
        if (/^https:\/\//u.test(change.fileExternalUrl) === false) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'External file attachments require an https:// external_url.',
          })
          continue
        }
        const value: typeof CanonicalPropertyValue.Type = {
          _tag: 'files',
          files: [
            {
              _tag: 'CanonicalFileValue',
              name: change.fileName,
              identityHash: decode({
                schema: Hash,
                value: hashStoreBytes(`external-file\t${change.fileName}\t${change.fileExternalUrl}`),
              }),
              externalUrl: change.fileExternalUrl,
            },
          ],
        }
        const valueJson = JSON.stringify(value)
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
              value: readString({ row: cell, key: 'properties_hash' }),
            }),
            propertyPatch: { [propertyId]: value },
          }),
          baseHash,
          desiredHash: hashStoreBytes(valueJson),
          expectedPropertyConfigHash: decode({
            schema: Hash,
            value: readString({ row: cell, key: 'config_hash' }),
          }),
        })
        continue
      }
      if (change.pageId === undefined) {
        markChange({
          replicaPath,
          dryRun,
          changeId: change.changeId,
          status: 'rejected',
          reason: `${change.kind} requires page_id.`,
        })
        continue
      }
      let pageId: PageId
      let _dataSourceId: DataSourceId
      try {
        pageId = decode({ schema: PageId, value: change.pageId })
        _dataSourceId = decode({ schema: DataSourceId, value: change.dataSourceId })
      } catch {
        markChange({
          replicaPath,
          dryRun,
          changeId: change.changeId,
          status: 'rejected',
          reason: 'Invalid data_source_id or page_id in local change.',
        })
        continue
      }
      const row = db
        .prepare(`SELECT properties_hash, in_trash FROM notion_rows WHERE page_id = ?`)
        .get(change.pageId) as SqlRow | undefined
      if (row === undefined) {
        markChange({
          replicaPath,
          dryRun,
          changeId: change.changeId,
          status: 'rejected',
          reason: 'Local change targets a row that is not present in the replica.',
        })
        continue
      }
      if (change.kind === 'row_restore') {
        if (readNumber({ row, key: 'in_trash' }) !== 0) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'conflict',
            reason: 'Local row restore no longer matches the current desired row state.',
          })
          continue
        }
        if (
          change.baseHash !== undefined &&
          change.baseHash !== readString({ row, key: 'properties_hash' })
        ) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'conflict',
            reason: 'Local row lifecycle change has a stale base_hash.',
          })
          continue
        }
        const baseHash = decode({
          schema: Hash,
          value:
            change.baseHash ??
            pageLifecycleHash({ pageId, inTrash: readNumber({ row, key: 'in_trash' }) === 1 }),
        })
        const commandId = decode({ schema: CommandId, value: `replica:${change.changeId}` })
        intents.push({
          _tag: 'local-delete',
          intentEventId: decode({ schema: SyncEventId, value: `replica:${change.changeId}` }),
          commandKey: decode({ schema: IdempotencyKey, value: `replica:${change.changeId}` }),
          surface: pageSurfaceKey(pageId),
          pageId,
          command: RestorePageCommand.make({
            _tag: 'RestorePageCommand',
            commandId,
            pageId,
            basePropertiesHash: baseHash,
          }),
          baseHash,
          desiredHash: pageLifecycleHash({ pageId, inTrash: false }),
          explicitDestructiveIntent: true,
          policy: 'trustedRemoteTrash',
          directRetrieve: 'accessible',
        })
        continue
      }
      if (change.kind === 'row_archive') {
        if (readNumber({ row, key: 'in_trash' }) !== 1) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'Local row archive was superseded by the current desired row state.',
          })
          continue
        }
        if (
          change.baseHash !== undefined &&
          change.baseHash !== readString({ row, key: 'properties_hash' })
        ) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'conflict',
            reason: 'Local row lifecycle change has a stale base_hash.',
          })
          continue
        }
        const baseHash = decode({
          schema: Hash,
          value:
            change.baseHash ??
            pageLifecycleHash({ pageId, inTrash: readNumber({ row, key: 'in_trash' }) === 1 }),
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
          desiredHash: pageLifecycleHash({ pageId, inTrash: true }),
          explicitDestructiveIntent: true,
          policy: 'trustedRemoteTrash',
          directRetrieve: 'accessible',
        })
        continue
      }
      if (change.kind === 'cell_patch') {
        if (change.propertyId === undefined || change.valueJson === undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'cell_patch requires property_id and value_json.',
          })
          continue
        }
        let propertyId: PropertyId
        try {
          propertyId = decode({ schema: PropertyId, value: change.propertyId })
        } catch {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'Invalid property_id in local change.',
          })
          continue
        }
        const cell = db
          .prepare(
            `SELECT c.base_hash, c.value_json, c.availability, r.properties_hash,
                    p.config_hash, p.write_class, p.property_type
             FROM notion_cells c
             JOIN notion_rows r ON r.page_id = c.page_id
             JOIN notion_properties p
               ON p.data_source_id = c.data_source_id AND p.property_id = c.property_id
             WHERE c.page_id = ? AND c.property_id = ?`,
          )
          .get(change.pageId, change.propertyId) as SqlRow | undefined
        if (cell === undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'Local change targets a cell that is not present in the replica.',
          })
          continue
        }
        if (readString({ row: cell, key: 'write_class' }) !== 'writable') {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason: 'The target property is read-only or unsupported for replica writes.',
          })
          continue
        }
        const propertyType = readString({ row: cell, key: 'property_type' })
        if (['people', 'files'].includes(propertyType) === true) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason:
              'People and file writes require full paginated base/staging proof before replica sync can apply them safely.',
          })
          continue
        }
        if (
          change.baseHash !== undefined &&
          change.baseHash !== readString({ row: cell, key: 'base_hash' })
        ) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'conflict',
            reason: 'Local cell patch has a stale base_hash.',
          })
          continue
        }
        let value: typeof CanonicalPropertyValue.Type
        try {
          value = Schema.decodeUnknownSync(Schema.parseJson(CanonicalPropertyValue))(
            change.valueJson,
          )
        } catch {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'value_json is not valid canonical Notion property value JSON.',
          })
          continue
        }
        if (propertyType === 'relation') {
          if (readString({ row: cell, key: 'availability' }) !== 'complete') {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'unsupported',
              reason:
                'Relation writes require a complete paginated base value before replacement-shaped writes are safe.',
            })
            continue
          }
          if (value._tag !== 'relation') {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'rejected',
              reason: 'Relation property patches require canonical relation value_json.',
            })
            continue
          }
          const relationPropertyId = change.propertyId
          if (value.pageIds.length > 100) {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'unsupported',
              reason: 'Relation writes are capped at 100 related pages by the Notion API.',
            })
            continue
          }
          let baseValue: typeof CanonicalPropertyValue.Type
          try {
            baseValue = Schema.decodeUnknownSync(Schema.parseJson(CanonicalPropertyValue))(
              readString({ row: cell, key: 'value_json' }),
            )
          } catch {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'unsupported',
              reason:
                'Relation writes require a canonical observed relation base value from page-property pagination.',
            })
            continue
          }
          if (baseValue._tag !== 'relation') {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'unsupported',
              reason:
                'Relation writes require a canonical observed relation base value from page-property pagination.',
            })
            continue
          }
          const addedPageIds = value.pageIds.filter(
            (pageIdValue) => baseValue.pageIds.includes(pageIdValue) === false,
          )
          const inaccessibleTarget = addedPageIds.find((pageIdValue) => {
            const target = db
              .prepare(
                `SELECT 1
                 FROM notion_relation_targets
                 WHERE data_source_id = ? AND property_id = ? AND target_page_id = ?
                 LIMIT 1`,
              )
              .get(change.dataSourceId, relationPropertyId, pageIdValue)
            return target === undefined
          })
          if (inaccessibleTarget !== undefined) {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'unsupported',
              reason:
                'Relation additions require each new target to have been observed through the same relation property.',
            })
            continue
          }
        } else if (value._tag === 'relation') {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'Relation value_json can only patch relation properties.',
          })
          continue
        }
        const baseHash = decode({
          schema: Hash,
          value: change.baseHash ?? readString({ row: cell, key: 'base_hash' }),
        })
        const desiredHash =
          value._tag === 'relation'
            ? hashStoreBytes(
                JSON.stringify({
                  _tag: 'relation',
                  pageIds: value.pageIds.toSorted(),
                }),
              )
            : hashStoreBytes(change.valueJson)
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
