export const STORE_SCHEMA_VERSION = 2

export const PROJECTOR_VERSION = 'notion-datasource-sync/projector/v1'

export const createStoreSchemaSql = `
CREATE TABLE IF NOT EXISTS sync_root (
  root_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  store_identity TEXT NOT NULL,
  settings_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_event (
  root_id TEXT NOT NULL REFERENCES sync_root(root_id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS projection_metadata (
  root_id TEXT NOT NULL REFERENCES sync_root(root_id) ON DELETE CASCADE,
  projection_name TEXT NOT NULL,
  projector_version TEXT NOT NULL,
  high_water_sequence INTEGER NOT NULL,
  digest TEXT NOT NULL,
  rebuilt_at TEXT NOT NULL,
  PRIMARY KEY (root_id, projection_name)
);

CREATE TABLE IF NOT EXISTS outbox (
  root_id TEXT NOT NULL REFERENCES sync_root(root_id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS conflict_projection (
  root_id TEXT NOT NULL REFERENCES sync_root(root_id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS tombstone_projection (
  root_id TEXT NOT NULL REFERENCES sync_root(root_id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS path_claim (
  root_id TEXT NOT NULL REFERENCES sync_root(root_id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  page_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'released', 'conflict')),
  claim_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, relative_path)
);

CREATE TABLE IF NOT EXISTS lease (
  root_id TEXT NOT NULL REFERENCES sync_root(root_id) ON DELETE CASCADE,
  lease_name TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  fenced_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, lease_name)
);

CREATE TABLE IF NOT EXISTS api_contract_projection (
  root_id TEXT NOT NULL REFERENCES sync_root(root_id) ON DELETE CASCADE,
  api_version TEXT NOT NULL,
  client_version TEXT NOT NULL,
  supported_capabilities_json TEXT NOT NULL,
  proof_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, api_version)
);

CREATE TABLE IF NOT EXISTS capability_projection (
  root_id TEXT NOT NULL REFERENCES sync_root(root_id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  data_source_id TEXT NOT NULL,
  supported INTEGER NOT NULL CHECK (supported IN (0, 1)),
  request_id TEXT,
  checked_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, capability)
);

CREATE TABLE IF NOT EXISTS data_source_projection (
  root_id TEXT NOT NULL REFERENCES sync_root(root_id) ON DELETE CASCADE,
  data_source_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  observed_event_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, data_source_id)
);

CREATE TABLE IF NOT EXISTS schema_property_projection (
  root_id TEXT NOT NULL REFERENCES sync_root(root_id) ON DELETE CASCADE,
  data_source_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  write_class TEXT NOT NULL CHECK (write_class IN ('writable', 'computed', 'unsupported')),
  observed_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, data_source_id, property_id)
);

CREATE TABLE IF NOT EXISTS row_projection (
  root_id TEXT NOT NULL REFERENCES sync_root(root_id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS property_shadow_projection (
  root_id TEXT NOT NULL REFERENCES sync_root(root_id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS body_pointer_projection (
  root_id TEXT NOT NULL REFERENCES sync_root(root_id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS query_absence_projection (
  root_id TEXT NOT NULL REFERENCES sync_root(root_id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS query_scan_checkpoint (
  root_id TEXT NOT NULL REFERENCES sync_root(root_id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS page_property_checkpoint (
  root_id TEXT NOT NULL REFERENCES sync_root(root_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  next_cursor TEXT,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  value_hash TEXT,
  event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, page_id, property_id)
);

CREATE TABLE IF NOT EXISTS migration_history (
  schema_version INTEGER PRIMARY KEY,
  migration_name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`

export const clearProjectionTablesSql = `
DELETE FROM projection_metadata;
DELETE FROM outbox;
DELETE FROM conflict_projection;
DELETE FROM tombstone_projection;
DELETE FROM path_claim;
DELETE FROM lease;
DELETE FROM api_contract_projection;
DELETE FROM capability_projection;
DELETE FROM data_source_projection;
DELETE FROM schema_property_projection;
DELETE FROM row_projection;
DELETE FROM property_shadow_projection;
DELETE FROM body_pointer_projection;
DELETE FROM query_absence_projection;
DELETE FROM query_scan_checkpoint;
DELETE FROM page_property_checkpoint;
`

export const rootScopedProjectionTables = [
  'projection_metadata',
  'outbox',
  'conflict_projection',
  'tombstone_projection',
  'path_claim',
  'lease',
  'api_contract_projection',
  'capability_projection',
  'data_source_projection',
  'schema_property_projection',
  'row_projection',
  'property_shadow_projection',
  'body_pointer_projection',
  'query_absence_projection',
  'query_scan_checkpoint',
  'page_property_checkpoint',
] as const
