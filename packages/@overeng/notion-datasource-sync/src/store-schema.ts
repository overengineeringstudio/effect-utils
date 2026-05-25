export const STORE_SCHEMA_VERSION = 1

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

CREATE TABLE IF NOT EXISTS query_scan_checkpoint (
  root_id TEXT NOT NULL REFERENCES sync_root(root_id) ON DELETE CASCADE,
  data_source_id TEXT NOT NULL,
  query_contract_hash TEXT NOT NULL,
  next_cursor TEXT,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
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
DELETE FROM query_scan_checkpoint;
DELETE FROM page_property_checkpoint;
`
