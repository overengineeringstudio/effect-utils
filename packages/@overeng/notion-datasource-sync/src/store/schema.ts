/** SQLite schema version — incremented when a migration is needed. */
export const STORE_SCHEMA_VERSION = 3

/** Opaque identifier stamped into every _nds_projection_metadata row to detect when projections were built by an incompatible projector. */
export const PROJECTOR_VERSION = 'notion-datasource-sync/projector/v1'

/**
 * DDL for the full store schema applied on initial bootstrap.
 *
 * Creates the immutable event log (`_nds_sync_root`, `_nds_sync_event`) and all
 * projection tables: `_nds_projection_metadata`, `_nds_outbox`, `_nds_conflict`,
 * `_nds_tombstone`, `_nds_guard_block`, `_nds_path_claim`, `_nds_lease`,
 * `_nds_api_contract`, `_nds_capability`, `_nds_data_source`,
 * `_nds_schema_property`, `_nds_row`, `_nds_property_shadow`,
 * `_nds_body_pointer`, `_nds_query_absence`,
 * `_nds_query_scan_checkpoint`, `_nds_page_property_checkpoint`, and `_nds_migration_history`.
 */
export const createStoreSchemaSql = `
CREATE TABLE IF NOT EXISTS _nds_sync_root (
  root_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  store_identity TEXT NOT NULL,
  settings_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS _nds_workspace_binding (
  root_id TEXT PRIMARY KEY REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  data_source_id TEXT NOT NULL,
  database_id TEXT,
  workspace_root TEXT NOT NULL,
  store_identity TEXT NOT NULL,
  binding_event_id TEXT NOT NULL,
  metadata_event_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS _nds_workspace_binding_block_invalid_insert
BEFORE INSERT ON _nds_workspace_binding
FOR EACH ROW
WHEN NEW.data_source_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'private _nds_workspace_binding is internal; use sync --from-notion to create bindings');
END;

CREATE TABLE IF NOT EXISTS _nds_sync_event (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  codec_version TEXT NOT NULL,
  family TEXT NOT NULL,
  event_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  surface TEXT,
  caused_by_event_ids_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  event_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (root_id, sequence),
  UNIQUE (root_id, event_id),
  UNIQUE (root_id, idempotency_key),
  UNIQUE (root_id, payload_hash, event_type, idempotency_key)
);

CREATE TABLE IF NOT EXISTS _nds_projection_metadata (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  projection_name TEXT NOT NULL,
  projector_version TEXT NOT NULL,
  high_water_sequence INTEGER NOT NULL,
  digest TEXT NOT NULL,
  rebuilt_at TEXT NOT NULL,
  PRIMARY KEY (root_id, projection_name)
);

CREATE TABLE IF NOT EXISTS _nds_outbox (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  command_id TEXT NOT NULL,
  command_key TEXT NOT NULL,
  intent_event_id TEXT NOT NULL,
  surface TEXT,
  command_tag TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'queued',
    'running',
    'retryable',
    'blocked',
    'settled',
    'fenced',
    'ambiguous'
  )),
  base_hash TEXT,
  desired_hash TEXT,
  preflight_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  lease_token TEXT,
  settlement_event_id TEXT,
  last_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, command_id)
);

CREATE TABLE IF NOT EXISTS _nds_conflict (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  conflict_id TEXT NOT NULL,
  page_id TEXT,
  property_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved', 'superseded', 'ignored')),
  base_hash TEXT,
  local_hash TEXT,
  remote_hash TEXT,
  opened_event_id TEXT NOT NULL,
  resolution_event_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, conflict_id)
);

CREATE TABLE IF NOT EXISTS _nds_tombstone (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN (
    'unclassified',
    'remote_trash',
    'moved_out',
    'moved_between_tracked_sources',
    'inaccessible',
    'unknown'
  )),
  reason TEXT NOT NULL,
  event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, page_id)
);

CREATE TABLE IF NOT EXISTS _nds_guard_block (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  surface TEXT,
  guard TEXT NOT NULL,
  message TEXT NOT NULL,
  event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, block_id)
);

CREATE TABLE IF NOT EXISTS _nds_path_claim (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  page_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'released', 'conflict')),
  claim_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, relative_path)
);

CREATE TABLE IF NOT EXISTS _nds_lease (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  lease_name TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  fenced_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, lease_name)
);

CREATE TABLE IF NOT EXISTS _nds_api_contract (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  api_version TEXT NOT NULL,
  client_version TEXT NOT NULL,
  supported_capabilities_json TEXT NOT NULL,
  proof_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, api_version)
);

CREATE TABLE IF NOT EXISTS _nds_capability (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  data_source_id TEXT NOT NULL,
  supported INTEGER NOT NULL CHECK (supported IN (0, 1)),
  request_id TEXT,
  checked_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, capability)
);

CREATE TABLE IF NOT EXISTS _nds_data_source (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  data_source_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  observed_event_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, data_source_id)
);

CREATE TABLE IF NOT EXISTS _nds_schema_property (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  data_source_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  write_class TEXT NOT NULL CHECK (write_class IN ('writable', 'computed', 'unsupported')),
  observed_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, data_source_id, property_id)
);

CREATE TABLE IF NOT EXISTS _nds_row (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  data_source_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  properties_hash TEXT NOT NULL,
  in_trash INTEGER NOT NULL CHECK (in_trash IN (0, 1)),
  moved_out INTEGER NOT NULL CHECK (moved_out IN (0, 1)),
  local_delete_candidate INTEGER NOT NULL CHECK (local_delete_candidate IN (0, 1)),
  observed_event_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, page_id)
);

CREATE TABLE IF NOT EXISTS _nds_property_shadow (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  base_hash TEXT NOT NULL,
  remote_hash TEXT NOT NULL,
  availability TEXT NOT NULL CHECK (availability IN (
    'complete',
    'computed',
    'unsupported',
    'paginated-incomplete',
    'relation-target-inaccessible',
    'related-data-source-unshared'
  )),
  observed_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, page_id, property_id)
);

CREATE TABLE IF NOT EXISTS _nds_body_pointer (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  path TEXT NOT NULL,
  base_hash TEXT NOT NULL,
  current_hash TEXT NOT NULL,
  sidecar_identity_proven INTEGER NOT NULL CHECK (sidecar_identity_proven IN (0, 1)),
  own_write_materialization_ids_json TEXT NOT NULL,
  safety_json TEXT NOT NULL,
  observed_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, page_id)
);

CREATE TABLE IF NOT EXISTS _nds_query_absence (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  data_source_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  query_contract_hash TEXT NOT NULL,
  classified INTEGER NOT NULL CHECK (classified IN (0, 1)),
  membership_scope TEXT NOT NULL CHECK (membership_scope IN (
    'all-data-source-rows',
    'explicit-filter'
  )),
  filtered INTEGER NOT NULL CHECK (filtered IN (0, 1)),
  direct_retrieve TEXT NOT NULL CHECK (direct_retrieve IN (
    'not-run',
    'accessible',
    'in-trash',
    'moved-out',
    'permission-ambiguous',
    'inaccessible',
    'unknown'
  )),
  evidence_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, data_source_id, page_id, query_contract_hash)
);

CREATE TABLE IF NOT EXISTS _nds_query_scan_checkpoint (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  data_source_id TEXT NOT NULL,
  query_contract_hash TEXT NOT NULL,
  next_cursor TEXT,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  capped_at_limit INTEGER NOT NULL DEFAULT 0 CHECK (capped_at_limit IN (0, 1)),
  contract_changed INTEGER NOT NULL DEFAULT 0 CHECK (contract_changed IN (0, 1)),
  high_watermark TEXT,
  event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, data_source_id, query_contract_hash)
);

CREATE TABLE IF NOT EXISTS _nds_page_property_checkpoint (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  next_cursor TEXT,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  value_hash TEXT,
  event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, page_id, property_id)
);

CREATE TABLE IF NOT EXISTS _nds_migration_history (
  schema_version INTEGER PRIMARY KEY,
  migration_name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`

/**
 * SQL that wipes all projection tables in preparation for a full replay.
 *
 * Deletes rows from all seventeen projection tables (everything except
 * `_nds_sync_root`, `_nds_sync_event`, and `_nds_migration_history`) without touching the
 * append-only event log.
 */
export const clearProjectionTablesSql = `
DELETE FROM _nds_projection_metadata;
DELETE FROM _nds_workspace_binding;
DELETE FROM _nds_outbox;
DELETE FROM _nds_conflict;
DELETE FROM _nds_tombstone;
DELETE FROM _nds_guard_block;
DELETE FROM _nds_path_claim;
DELETE FROM _nds_lease;
DELETE FROM _nds_api_contract;
DELETE FROM _nds_capability;
DELETE FROM _nds_data_source;
DELETE FROM _nds_schema_property;
DELETE FROM _nds_row;
DELETE FROM _nds_property_shadow;
DELETE FROM _nds_body_pointer;
DELETE FROM _nds_query_absence;
DELETE FROM _nds_query_scan_checkpoint;
DELETE FROM _nds_page_property_checkpoint;
`

/**
 * All projection table names that are scoped to a `_nds_sync_root`, used when
 * deleting a root to cascade-clean its projection rows via generated SQL.
 */
export const rootScopedProjectionTables = [
  '_nds_projection_metadata',
  '_nds_workspace_binding',
  '_nds_outbox',
  '_nds_conflict',
  '_nds_tombstone',
  '_nds_guard_block',
  '_nds_path_claim',
  '_nds_lease',
  '_nds_api_contract',
  '_nds_capability',
  '_nds_data_source',
  '_nds_schema_property',
  '_nds_row',
  '_nds_property_shadow',
  '_nds_body_pointer',
  '_nds_query_absence',
  '_nds_query_scan_checkpoint',
  '_nds_page_property_checkpoint',
] as const
