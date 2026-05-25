import { DatabaseSync } from 'node:sqlite'

import { Schema } from 'effect'

import { Hash } from './domain.ts'
import { LocalStoreError } from './errors.ts'
import { SyncEvent, type SyncRootId } from './events.ts'
import type { GuardName } from './guards.ts'
import {
  computePayloadHash,
  computeProjectionDigest,
  isCompactionBlockingOutboxState,
  OutboxState,
  type ProjectionDigestInput,
} from './store-projections.ts'
import {
  clearProjectionTablesSql,
  createStoreSchemaSql,
  PROJECTOR_VERSION,
  STORE_SCHEMA_VERSION,
} from './store-schema.ts'

type SqlRow = Record<string, unknown>

export type SqliteStoreSettings = {
  readonly journalMode: string
  readonly foreignKeys: boolean
  readonly busyTimeoutMs: number
}

export type OpenNotionSyncStoreOptions = {
  readonly path: string
  readonly busyTimeoutMs?: number
  readonly now?: () => Date
}

export type ProjectionMetadata = {
  readonly rootId: SyncRootId
  readonly projectorVersion: string
  readonly highWaterSequence: bigint
  readonly digest: Hash
}

export type OutboxProjectionRow = {
  readonly commandId: string
  readonly commandKey: string
  readonly intentEventId: string
  readonly surface: string | undefined
  readonly commandTag: string
  readonly state: typeof OutboxState.Type
  readonly baseHash: string | undefined
  readonly desiredHash: string | undefined
  readonly attemptCount: number
  readonly leaseToken: string | undefined
  readonly settlementEventId: string | undefined
}

export type CompactionBlocker = {
  readonly guard: typeof GuardName.Type
  readonly message: string
}

export type CompactionDecision =
  | { readonly _tag: 'allowed' }
  | { readonly _tag: 'blocked'; readonly blockers: readonly CompactionBlocker[] }

const decodeEventFromJson = Schema.decodeSync(Schema.parseJson(SyncEvent))
const encodeEvent = Schema.encodeSync(SyncEvent)

const projectionName = 'core'

const readString = (row: SqlRow, key: string): string => {
  const value = row[key]
  if (typeof value === 'string') return value
  throw new LocalStoreError({
    operation: 'read-sqlite-row',
    message: `Expected SQLite column ${key} to be a string`,
  })
}

const readOptionalString = (row: SqlRow, key: string): string | undefined => {
  const value = row[key]
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return value
  throw new LocalStoreError({
    operation: 'read-sqlite-row',
    message: `Expected SQLite column ${key} to be a string when present`,
  })
}

const readInteger = (row: SqlRow, key: string): bigint => {
  const value = row[key]
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value)
  throw new LocalStoreError({
    operation: 'read-sqlite-row',
    message: `Expected SQLite column ${key} to be an integer`,
  })
}

const readBoolean = (row: SqlRow, key: string): boolean => {
  const value = row[key]
  if (value === 0 || value === 0n) return false
  if (value === 1 || value === 1n) return true
  throw new LocalStoreError({
    operation: 'read-sqlite-row',
    message: `Expected SQLite column ${key} to be a boolean integer`,
  })
}

const readOutboxState = (row: SqlRow, key: string): typeof OutboxState.Type =>
  Schema.decodeUnknownSync(OutboxState)(readString(row, key))

const stringifyJson = (value: unknown): string => JSON.stringify(value)

const currentIso = (now: () => Date): string => now().toISOString()

export class NotionSyncStore {
  readonly #db: DatabaseSync
  readonly #now: () => Date
  readonly settings: SqliteStoreSettings

  constructor(options: OpenNotionSyncStoreOptions) {
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000
    this.#now = options.now ?? (() => new Date())
    this.#db = new DatabaseSync(options.path, {
      enableForeignKeyConstraints: true,
      timeout: busyTimeoutMs,
      readBigInts: true,
    })

    this.#db.exec('PRAGMA foreign_keys = ON')
    this.#db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)

    const journalModeRow = this.#db.prepare('PRAGMA journal_mode = WAL').get() ?? {}
    const foreignKeysRow = this.#db.prepare('PRAGMA foreign_keys').get() ?? {}

    this.settings = {
      journalMode: String(
        journalModeRow.journal_mode ?? journalModeRow['journal_mode = WAL'] ?? '',
      ),
      foreignKeys: readBoolean({ enabled: foreignKeysRow.foreign_keys ?? 0 }, 'enabled'),
      busyTimeoutMs,
    }

    this.#runMigrations()
  }

  close(): void {
    this.#db.close()
  }

  appendEvent(event: SyncEvent): SyncEvent {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#ensureRoot(event.rootId)

      const existing = this.#db
        .prepare(
          `SELECT event_json
           FROM sync_event
           WHERE root_id = ? AND idempotency_key = ?`,
        )
        .get(event.rootId, event.idempotencyKey)

      if (existing !== undefined) {
        this.#db.exec('COMMIT')
        return decodeEventFromJson(readString(existing, 'event_json'))
      }

      const sequence = this.#nextSequence(event.rootId)
      const encodedOriginalEvent = encodeEvent(event)
      const eventWithAssignedFields = Schema.decodeUnknownSync(SyncEvent)({
        ...encodedOriginalEvent,
        sequence: sequence.toString(),
        payloadHash: computePayloadHash(event),
      })
      const encodedEvent = encodeEvent(eventWithAssignedFields)

      this.#db
        .prepare(
          `INSERT INTO sync_event (
             root_id,
             sequence,
             event_id,
             codec_version,
             family,
             event_type,
             idempotency_key,
             surface,
             caused_by_event_ids_json,
             payload_hash,
             payload_json,
             event_json,
             observed_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          encodedEvent.rootId,
          sequence,
          encodedEvent.eventId,
          encodedEvent.codecVersion,
          encodedEvent.family,
          encodedEvent.eventType,
          encodedEvent.idempotencyKey,
          encodedEvent.surface,
          stringifyJson(encodedEvent.causedByEventIds),
          encodedEvent.payloadHash,
          stringifyJson(encodedEvent.payload),
          stringifyJson(encodedEvent),
          encodedEvent.observedAt,
        )

      this.#rebuildProjectionsInTransaction(event.rootId)
      this.#db.exec('COMMIT')
      return eventWithAssignedFields
    } catch (cause) {
      this.#db.exec('ROLLBACK')
      throw cause
    }
  }

  replay(rootId: SyncRootId): readonly SyncEvent[] {
    return this.#eventRows(rootId).map((row) => decodeEventFromJson(readString(row, 'event_json')))
  }

  clearProjectionTables(): void {
    this.#db.exec(clearProjectionTablesSql)
  }

  rebuildProjections(rootId: SyncRootId): ProjectionMetadata {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const metadata = this.#rebuildProjectionsInTransaction(rootId)
      this.#db.exec('COMMIT')
      return metadata
    } catch (cause) {
      this.#db.exec('ROLLBACK')
      throw cause
    }
  }

  readProjectionMetadata(rootId: SyncRootId): ProjectionMetadata | undefined {
    const row = this.#db
      .prepare(
        `SELECT root_id, projector_version, high_water_sequence, digest
         FROM projection_metadata
         WHERE root_id = ? AND projection_name = ?`,
      )
      .get(rootId, projectionName)

    if (row === undefined) return undefined

    return {
      rootId,
      projectorVersion: readString(row, 'projector_version'),
      highWaterSequence: readInteger(row, 'high_water_sequence'),
      digest: Schema.decodeSync(Hash)(readString(row, 'digest')),
    }
  }

  computeCurrentProjectionDigest(rootId: SyncRootId): Hash {
    return computeProjectionDigest(this.#projectionDigestInputs(rootId))
  }

  readOutbox(rootId: SyncRootId): readonly OutboxProjectionRow[] {
    return this.#db
      .prepare(
        `SELECT
           command_id,
           command_key,
           intent_event_id,
           surface,
           command_tag,
           state,
           base_hash,
           desired_hash,
           attempt_count,
           lease_token,
           settlement_event_id
         FROM outbox
         WHERE root_id = ?
         ORDER BY command_id`,
      )
      .all(rootId)
      .map((row) => ({
        commandId: readString(row, 'command_id'),
        commandKey: readString(row, 'command_key'),
        intentEventId: readString(row, 'intent_event_id'),
        surface: readOptionalString(row, 'surface'),
        commandTag: readString(row, 'command_tag'),
        state: readOutboxState(row, 'state'),
        baseHash: readOptionalString(row, 'base_hash'),
        desiredHash: readOptionalString(row, 'desired_hash'),
        attemptCount: Number(readInteger(row, 'attempt_count')),
        leaseToken: readOptionalString(row, 'lease_token'),
        settlementEventId: readOptionalString(row, 'settlement_event_id'),
      }))
  }

  getCompactionDecision(rootId: SyncRootId): CompactionDecision {
    const blockers: CompactionBlocker[] = []
    const metadata = this.readProjectionMetadata(rootId)
    const currentDigest = this.computeCurrentProjectionDigest(rootId)

    if (metadata === undefined || metadata.digest !== currentDigest) {
      blockers.push({
        guard: 'CheckpointDigestMismatch',
        message: 'Projection metadata digest does not match replayed event digest',
      })
    }

    const outboxRows = this.#db
      .prepare(
        `SELECT command_id, state, lease_token
         FROM outbox
         WHERE root_id = ?`,
      )
      .all(rootId)

    for (const row of outboxRows) {
      const state = readOutboxState(row, 'state')
      const leaseToken = readOptionalString(row, 'lease_token')
      if (
        isCompactionBlockingOutboxState(state) ||
        (state !== 'settled' && leaseToken !== undefined)
      ) {
        blockers.push({
          guard: 'CompactionUnsafe',
          message: `Outbox command ${readString(row, 'command_id')} is ${state}`,
        })
      }
    }

    const openConflict = this.#db
      .prepare(
        `SELECT conflict_id
         FROM conflict_projection
         WHERE root_id = ? AND state = 'open'
         ORDER BY conflict_id
         LIMIT 1`,
      )
      .get(rootId)

    if (openConflict !== undefined) {
      blockers.push({
        guard: 'CompactionUnsafe',
        message: `Conflict ${readString(openConflict, 'conflict_id')} is still open`,
      })
    }

    const unclassifiedTombstone = this.#db
      .prepare(
        `SELECT page_id
         FROM tombstone_projection
         WHERE root_id = ? AND classification = 'unclassified'
         ORDER BY page_id
         LIMIT 1`,
      )
      .get(rootId)

    if (unclassifiedTombstone !== undefined) {
      blockers.push({
        guard: 'CompactionUnsafe',
        message: `Tombstone for page ${readString(unclassifiedTombstone, 'page_id')} is unclassified`,
      })
    }

    return blockers.length === 0 ? { _tag: 'allowed' } : { _tag: 'blocked', blockers }
  }

  replaceProjectionDigestForRepairTest(rootId: SyncRootId, digest: Hash): void {
    this.#db
      .prepare(
        `UPDATE projection_metadata
         SET digest = ?
         WHERE root_id = ? AND projection_name = ?`,
      )
      .run(digest, rootId, projectionName)
  }

  #runMigrations(): void {
    this.#db.exec(createStoreSchemaSql)
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO migration_history (schema_version, migration_name, applied_at)
         VALUES (?, ?, ?)`,
      )
      .run(STORE_SCHEMA_VERSION, 'initial-sync-core-schema', currentIso(this.#now))
  }

  #ensureRoot(rootId: SyncRootId): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO sync_root (root_id, created_at, store_identity, settings_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(rootId, currentIso(this.#now), `store:${rootId}`, '{}')
  }

  #nextSequence(rootId: SyncRootId): bigint {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS sequence
         FROM sync_event
         WHERE root_id = ?`,
      )
      .get(rootId)

    return readInteger(row ?? { sequence: 0n }, 'sequence') + 1n
  }

  #eventRows(rootId: SyncRootId): readonly SqlRow[] {
    return this.#db
      .prepare(
        `SELECT sequence, event_id, payload_hash, event_json
         FROM sync_event
         WHERE root_id = ?
         ORDER BY sequence, event_id`,
      )
      .all(rootId)
  }

  #projectionDigestInputs(rootId: SyncRootId): readonly ProjectionDigestInput[] {
    return this.#eventRows(rootId).map((row) => ({
      sequence: readInteger(row, 'sequence'),
      eventId: readString(row, 'event_id'),
      payloadHash: readString(row, 'payload_hash'),
    }))
  }

  #rebuildProjectionsInTransaction(rootId: SyncRootId): ProjectionMetadata {
    this.#db.exec(clearProjectionTablesSql)

    for (const event of this.replay(rootId)) {
      this.#applyEvent(event)
    }

    const digestInputs = this.#projectionDigestInputs(rootId)
    const highWaterSequence = digestInputs.at(-1)?.sequence ?? 0n
    const digest = computeProjectionDigest(digestInputs)

    this.#db
      .prepare(
        `INSERT INTO projection_metadata (
           root_id,
           projection_name,
           projector_version,
           high_water_sequence,
           digest,
           rebuilt_at
         )
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(root_id, projection_name) DO UPDATE SET
           projector_version = excluded.projector_version,
           high_water_sequence = excluded.high_water_sequence,
           digest = excluded.digest,
           rebuilt_at = excluded.rebuilt_at`,
      )
      .run(
        rootId,
        projectionName,
        PROJECTOR_VERSION,
        highWaterSequence,
        digest,
        currentIso(this.#now),
      )

    return { rootId, projectorVersion: PROJECTOR_VERSION, highWaterSequence, digest }
  }

  #applyEvent(event: SyncEvent): void {
    switch (event._tag) {
      case 'ApiContractObserved':
        this.#db
          .prepare(
            `INSERT INTO api_contract_projection (
               root_id,
               api_version,
               client_version,
               supported_capabilities_json,
               proof_event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, api_version) DO UPDATE SET
               client_version = excluded.client_version,
               supported_capabilities_json = excluded.supported_capabilities_json,
               proof_event_id = excluded.proof_event_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.apiContract.apiVersion,
            event.apiContract.clientVersion,
            stringifyJson(event.apiContract.supportedCapabilities),
            event.eventId,
            currentIso(this.#now),
          )
        break
      case 'CapabilityPreflightChecked':
        this.#db
          .prepare(
            `INSERT INTO capability_projection (
               root_id,
               capability,
               data_source_id,
               supported,
               request_id,
               checked_event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, capability) DO UPDATE SET
               data_source_id = excluded.data_source_id,
               supported = excluded.supported,
               request_id = excluded.request_id,
               checked_event_id = excluded.checked_event_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.capability,
            event.dataSourceId,
            event.supported ? 1 : 0,
            event.requestId ?? null,
            event.eventId,
            currentIso(this.#now),
          )
        break
      case 'RemoteWritePlanned':
        this.#db
          .prepare(
            `INSERT INTO outbox (
               root_id,
               command_id,
               command_key,
               intent_event_id,
               surface,
               command_tag,
               state,
               base_hash,
               desired_hash,
               preflight_json,
               attempt_count,
               lease_token,
               settlement_event_id,
               last_event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, NULL, NULL, ?, ?)
             ON CONFLICT(root_id, command_id) DO NOTHING`,
          )
          .run(
            event.rootId,
            event.commandId,
            event.commandKey,
            event.intentEventId,
            event.surface,
            event.commandTag,
            event.baseHash ?? null,
            event.desiredHash,
            stringifyJson(event.preflight),
            event.eventId,
            currentIso(this.#now),
          )
        break
      case 'RemoteWriteAttempted': {
        const existing = this.#db
          .prepare(
            `SELECT settlement_event_id
             FROM outbox
             WHERE root_id = ? AND command_id = ?`,
          )
          .get(event.rootId, event.commandId)

        if (
          existing !== undefined &&
          readOptionalString(existing, 'settlement_event_id') === undefined
        ) {
          this.#db
            .prepare(
              `UPDATE outbox
               SET state = ?,
                   attempt_count = MAX(attempt_count, ?),
                   lease_token = ?,
                   last_event_id = ?,
                   updated_at = ?
               WHERE root_id = ? AND command_id = ?`,
            )
            .run(
              event.attemptState,
              event.attempt,
              event.leaseToken ?? null,
              event.eventId,
              currentIso(this.#now),
              event.rootId,
              event.commandId,
            )
        }
        break
      }
      case 'RemoteWriteSettled':
        this.#db
          .prepare(
            `UPDATE outbox
             SET state = 'settled',
                 lease_token = NULL,
                 settlement_event_id = ?,
                 last_event_id = ?,
                 updated_at = ?
             WHERE root_id = ?
               AND command_id = ?
               AND settlement_event_id IS NULL`,
          )
          .run(event.eventId, event.eventId, currentIso(this.#now), event.rootId, event.commandId)
        break
      case 'ConflictRaised':
        this.#db
          .prepare(
            `INSERT INTO conflict_projection (
               root_id,
               conflict_id,
               page_id,
               property_id,
               state,
               base_hash,
               local_hash,
               remote_hash,
               opened_event_id,
               resolution_event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL, ?)
             ON CONFLICT(root_id, conflict_id) DO NOTHING`,
          )
          .run(
            event.rootId,
            event.eventId,
            event.pageId,
            event.propertyId ?? null,
            event.baseHash,
            event.localHash,
            event.remoteHash,
            event.eventId,
            currentIso(this.#now),
          )
        break
      case 'TombstoneCandidateObserved':
        this.#db
          .prepare(
            `INSERT INTO tombstone_projection (
               root_id,
               page_id,
               classification,
               reason,
               event_id,
               updated_at
             )
             VALUES (?, ?, 'unclassified', ?, ?, ?)
             ON CONFLICT(root_id, page_id) DO UPDATE SET
               classification = 'unclassified',
               reason = excluded.reason,
               event_id = excluded.event_id,
               updated_at = excluded.updated_at`,
          )
          .run(event.rootId, event.pageId, event.reason, event.eventId, currentIso(this.#now))
        break
      case 'TombstoneRecorded':
        this.#db
          .prepare(
            `INSERT INTO tombstone_projection (
               root_id,
               page_id,
               classification,
               reason,
               event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, page_id) DO UPDATE SET
               classification = excluded.classification,
               reason = excluded.reason,
               event_id = excluded.event_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.pageId,
            event.reason,
            event.reason,
            event.eventId,
            currentIso(this.#now),
          )
        break
      case 'PathClaimed':
        this.#db
          .prepare(
            `INSERT INTO path_claim (
               root_id,
               relative_path,
               page_id,
               state,
               claim_event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, relative_path) DO UPDATE SET
               page_id = excluded.page_id,
               state = excluded.state,
               claim_event_id = excluded.claim_event_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.relativePath,
            event.pageId,
            event.claimState,
            event.eventId,
            currentIso(this.#now),
          )
        break
      case 'QueryScanCheckpointRecorded':
        this.#db
          .prepare(
            `INSERT INTO query_scan_checkpoint (
               root_id,
               data_source_id,
               query_contract_hash,
               next_cursor,
               complete,
               high_watermark,
               event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, data_source_id, query_contract_hash) DO UPDATE SET
               next_cursor = excluded.next_cursor,
               complete = excluded.complete,
               high_watermark = excluded.high_watermark,
               event_id = excluded.event_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.dataSourceId,
            event.queryContractHash,
            event.nextCursor ?? null,
            event.complete ? 1 : 0,
            event.highWatermark === null
              ? null
              : Schema.encodeSync(Schema.DateTimeUtc)(event.highWatermark),
            event.eventId,
            currentIso(this.#now),
          )
        break
      case 'PagePropertyCheckpointRecorded':
        this.#db
          .prepare(
            `INSERT INTO page_property_checkpoint (
               root_id,
               page_id,
               property_id,
               next_cursor,
               complete,
               value_hash,
               event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, page_id, property_id) DO UPDATE SET
               next_cursor = excluded.next_cursor,
               complete = excluded.complete,
               value_hash = excluded.value_hash,
               event_id = excluded.event_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.pageId,
            event.propertyId,
            event.nextCursor ?? null,
            event.complete ? 1 : 0,
            event.valueHash ?? null,
            event.eventId,
            currentIso(this.#now),
          )
        break
      case 'DataSourceObserved':
      case 'RowObserved':
      case 'LocalIntentAccepted':
      case 'DecodeDriftBlocked':
        break
    }
  }
}

export const openNotionSyncStore = (options: OpenNotionSyncStoreOptions): NotionSyncStore =>
  new NotionSyncStore(options)
