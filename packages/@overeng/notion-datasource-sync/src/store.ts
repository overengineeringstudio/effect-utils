import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { Schema } from 'effect'

import { RemoteWritePlanPayload, type RemoteWriteCommand } from './commands.ts'
import {
  BodySafetySnapshot,
  CapabilityName,
  CommandId,
  DataSourceId,
  Hash,
  type NotionRequestId,
  PageId,
  PropertyId,
} from './domain.ts'
import { LocalStoreError } from './errors.ts'
import { IdempotencyKey, SurfaceKey, SyncEvent, SyncEventId, type SyncRootId } from './events.ts'
import { GuardName } from './guards.ts'
import type { PlannerProjectionSnapshot } from './planner.ts'
import {
  computePayloadHash,
  computeProjectionDigest,
  DataSourceProjectionPayload,
  BodyProjectionSafetyPayload,
  isCompactionBlockingOutboxState,
  OutboxState,
  PropertyCheckpointProjectionPayload,
  QueryAbsenceProjectionPayload,
  QueryCheckpointProjectionPayload,
  RowProjectionPayload,
  type ProjectionDigestInput,
} from './store-projections.ts'
import {
  clearProjectionTablesSql,
  createStoreSchemaSql,
  PROJECTOR_VERSION,
  rootScopedProjectionTables,
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

export type OutboxClaimOptions = {
  readonly rootId: SyncRootId
  readonly leaseToken: string
  readonly leaseDurationMs: number
}

export type ClaimedOutboxCommand = {
  readonly rootId: SyncRootId
  readonly commandId: CommandId
  readonly commandKey: IdempotencyKey
  readonly intentEventId: SyncEventId
  readonly surface: SurfaceKey
  readonly commandTag: string
  readonly command: typeof RemoteWriteCommand.Type | undefined
  readonly baseHash: typeof Hash.Type | undefined
  readonly desiredHash: typeof Hash.Type
  readonly preflight: ReadonlyArray<typeof GuardName.Type>
  readonly attempt: number
  readonly leaseToken: string
  readonly previousState: typeof OutboxState.Type
  readonly attemptState: Extract<
    typeof OutboxState.Type,
    'running' | 'retryable' | 'blocked' | 'fenced' | 'ambiguous'
  >
  readonly attemptEvent: Extract<SyncEvent, { readonly _tag: 'RemoteWriteAttempted' }>
}

export type OutboxAttemptStateInput = {
  readonly rootId: SyncRootId
  readonly commandId: CommandId
  readonly commandKey: IdempotencyKey
  readonly surface: SurfaceKey
  readonly attempt: number
  readonly attemptState: Extract<
    typeof OutboxState.Type,
    'running' | 'retryable' | 'blocked' | 'fenced' | 'ambiguous'
  >
  readonly leaseToken?: string
  readonly guard?: typeof GuardName.Type
  readonly idempotencyKey?: IdempotencyKey
}

export type OutboxSettlementInput = {
  readonly rootId: SyncRootId
  readonly commandId: CommandId
  readonly commandKey: IdempotencyKey
  readonly surface: SurfaceKey
  readonly commandTag: string
  readonly requestId: NotionRequestId
  readonly desiredHash: typeof Hash.Type
  readonly observedHash: typeof Hash.Type
  readonly settlementKind: 'verified-success' | 'verified-no-op'
  readonly idempotencyKey?: IdempotencyKey
}

export type CompactionBlocker = {
  readonly guard: typeof GuardName.Type
  readonly message: string
}

export type CompactionDecision =
  | { readonly _tag: 'allowed' }
  | { readonly _tag: 'blocked'; readonly blockers: readonly CompactionBlocker[] }

export type StoreStatusProjection = {
  readonly outbox: {
    readonly queued: number
    readonly running: number
    readonly retryable: number
    readonly blocked: number
    readonly settled: number
    readonly fenced: number
    readonly ambiguous: number
  }
  readonly conflicts: {
    readonly open: number
  }
  readonly tombstones: {
    readonly unclassified: number
  }
  readonly guards: {
    readonly blocked: number
  }
  readonly capabilities: {
    readonly unsupported: number
  }
  readonly checkpoints: {
    readonly incompleteQueries: number
    readonly cappedQueries: number
    readonly changedQueryContracts: number
    readonly incompleteProperties: number
  }
  readonly projections: {
    readonly dataSources: number
    readonly rows: number
    readonly properties: number
    readonly bodies: number
  }
}

const decodeEventFromJson = Schema.decodeSync(Schema.parseJson(SyncEvent))
const encodeEvent = Schema.encodeSync(SyncEvent)
const decodeBodySafetyFromJson = Schema.decodeSync(Schema.parseJson(BodySafetySnapshot))
const encodeBodySafety = Schema.encodeSync(BodySafetySnapshot)
const decodeCapabilityName = Schema.decodeUnknownSync(CapabilityName)
const decodeDataSourceId = Schema.decodeSync(DataSourceId)
const decodeHash = Schema.decodeSync(Hash)
const decodeIdempotencyKey = Schema.decodeUnknownSync(IdempotencyKey)
const decodePageId = Schema.decodeSync(PageId)
const decodePropertyId = Schema.decodeSync(PropertyId)
const decodeRemoteWritePlanPayload = Schema.decodeUnknownSync(
  Schema.parseJson(RemoteWritePlanPayload),
)
const decodeSurfaceKey = Schema.decodeUnknownSync(SurfaceKey)
const decodeSyncEventId = Schema.decodeSync(SyncEventId)
const decodeDataSourceProjectionPayload = Schema.decodeUnknownSync(
  Schema.parseJson(DataSourceProjectionPayload),
)
const decodeRowProjectionPayload = Schema.decodeUnknownSync(Schema.parseJson(RowProjectionPayload))
const decodeBodyProjectionSafetyPayload = Schema.decodeUnknownSync(
  Schema.parseJson(BodyProjectionSafetyPayload),
)
const decodePropertyCheckpointProjectionPayload = Schema.decodeUnknownSync(
  Schema.parseJson(PropertyCheckpointProjectionPayload),
)
const decodeQueryCheckpointProjectionPayload = Schema.decodeUnknownSync(
  Schema.parseJson(QueryCheckpointProjectionPayload),
)
const decodeQueryAbsenceProjectionPayload = Schema.decodeUnknownSync(
  Schema.parseJson(QueryAbsenceProjectionPayload),
)

const projectionName = 'core'

const defaultUnsafeBodySafety: typeof BodySafetySnapshot.Type = {
  truncated: false,
  unknownBlockCause: 'unknown',
  selection: 'ambiguous',
  wouldDeleteChildren: false,
  syncedPageUnsupported: false,
  adapterConflict: false,
  adapterMutationSurfaces: ['body'],
}

const decodePayload = <TValue>(
  event: SyncEvent,
  decode: (value: unknown) => TValue,
): TValue | undefined => {
  try {
    return decode(event.payload.canonicalJson)
  } catch {
    return undefined
  }
}

const parsePropertySurface = (
  surface: string | undefined,
): { readonly pageId: string; readonly propertyId: string } | undefined => {
  if (surface === undefined) return undefined
  const match = /^page:([^:]+):property:(.+)$/.exec(surface)
  if (match === null) return undefined

  return { pageId: match[1]!, propertyId: match[2]! }
}

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

const readCount = (row: SqlRow | undefined, key: string): number =>
  row === undefined ? 0 : Number(readInteger(row, key))

const stringifyJson = (value: unknown): string => JSON.stringify(value)

const currentIso = (now: () => Date): string => now().toISOString()

const eventPayload = (canonicalJson: string): SyncEvent['payload'] => ({
  _tag: 'VersionedJson',
  codecVersion: 'v1',
  canonicalJson,
})

const makeEventId = (parts: ReadonlyArray<string | number>): SyncEventId =>
  decodeSyncEventId(parts.map((part) => String(part).replaceAll(':', '-')).join(':'))

const decodePlanCommand = (event: SyncEvent): typeof RemoteWriteCommand.Type | undefined =>
  decodePayload(event, decodeRemoteWritePlanPayload)?.command

const assertSupportedSchemaVersion = (db: DatabaseSync): void => {
  const migrationHistoryTable = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name = 'migration_history'`,
    )
    .get()

  if (migrationHistoryTable === undefined) return

  const latestKnownMigration = db
    .prepare(
      `SELECT MAX(schema_version) AS schema_version
       FROM migration_history`,
    )
    .get()
  const schemaVersion = latestKnownMigration?.schema_version

  if (schemaVersion === null || schemaVersion === undefined) return

  if (typeof schemaVersion !== 'bigint' && typeof schemaVersion !== 'number') {
    throw new LocalStoreError({
      operation: 'run-migrations',
      message: `Store schema version is unknown; refusing to migrate to supported version ${STORE_SCHEMA_VERSION}`,
    })
  }

  if (schemaVersion > STORE_SCHEMA_VERSION) {
    throw new LocalStoreError({
      operation: 'run-migrations',
      message: `Store schema version ${schemaVersion.toString()} is newer than supported version ${STORE_SCHEMA_VERSION}`,
    })
  }
}

const preflightMigrationSafety = (path: string): void => {
  if (path === ':memory:' || existsSync(path) === false) return

  const db = new DatabaseSync(path, { readOnly: true, readBigInts: true })
  try {
    assertSupportedSchemaVersion(db)
  } finally {
    db.close()
  }
}

export class NotionSyncStore {
  readonly #db: DatabaseSync
  readonly #now: () => Date
  readonly settings: SqliteStoreSettings

  constructor(options: OpenNotionSyncStoreOptions) {
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000
    preflightMigrationSafety(options.path)
    this.#now = options.now ?? (() => new Date())
    this.#db = new DatabaseSync(options.path, {
      enableForeignKeyConstraints: true,
      timeout: busyTimeoutMs,
      readBigInts: true,
    })

    this.#db.exec('PRAGMA foreign_keys = ON')
    this.#db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)

    try {
      this.#runMigrations()
    } catch (cause) {
      this.#db.close()
      throw cause
    }

    const journalModeRow = this.#db.prepare('PRAGMA journal_mode = WAL').get() ?? {}
    const foreignKeysRow = this.#db.prepare('PRAGMA foreign_keys').get() ?? {}

    this.settings = {
      journalMode: String(
        journalModeRow.journal_mode ?? journalModeRow['journal_mode = WAL'] ?? '',
      ),
      foreignKeys: readBoolean({ enabled: foreignKeysRow.foreign_keys ?? 0 }, 'enabled'),
      busyTimeoutMs,
    }
  }

  close(): void {
    this.#db.close()
  }

  appendEvent(event: SyncEvent): SyncEvent {
    return this.appendEventWithResult(event).event
  }

  appendEventWithResult(event: SyncEvent): {
    readonly event: SyncEvent
    readonly inserted: boolean
  } {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.#appendEventWithResultInTransaction(event)
      this.#db.exec('COMMIT')
      return result
    } catch (cause) {
      this.#db.exec('ROLLBACK')
      throw cause
    }
  }

  claimNextOutboxCommand(options: OutboxClaimOptions): ClaimedOutboxCommand | undefined {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#ensureRoot(options.rootId)
      const leaseCutoff = new Date(this.#now().getTime() - options.leaseDurationMs).toISOString()
      const row = this.#db
        .prepare(
          `SELECT
             outbox.command_id,
             outbox.command_key,
             outbox.intent_event_id,
             outbox.surface,
             outbox.command_tag,
             outbox.state,
             outbox.base_hash,
             outbox.desired_hash,
             outbox.preflight_json,
             outbox.attempt_count,
             outbox.updated_at,
             event.event_json
           FROM outbox
           JOIN sync_event event
             ON event.root_id = outbox.root_id
            AND event.idempotency_key = outbox.command_key
            AND event.event_type = 'RemoteWritePlanned'
           WHERE outbox.root_id = ?
             AND outbox.settlement_event_id IS NULL
             AND (
               outbox.state IN ('queued', 'retryable', 'ambiguous')
               OR (outbox.state = 'running' AND outbox.updated_at <= ?)
             )
           ORDER BY outbox.updated_at, outbox.command_id
           LIMIT 1`,
        )
        .get(options.rootId, leaseCutoff)

      if (row === undefined) {
        this.#db.exec('COMMIT')
        return undefined
      }

      const previousState = readOutboxState(row, 'state')
      const attempt = Number(readInteger(row, 'attempt_count')) + 1
      const attemptState = previousState === 'running' ? 'ambiguous' : 'running'
      const commandId = readString(row, 'command_id')
      const commandKey = decodeIdempotencyKey(readString(row, 'command_key'))
      const surface = decodeSurfaceKey(readString(row, 'surface'))
      const plannedEvent = decodeEventFromJson(readString(row, 'event_json'))
      const attemptEvent = this.#appendOutboxAttemptStateInTransaction({
        rootId: options.rootId,
        commandId: Schema.decodeUnknownSync(CommandId)(commandId),
        commandKey,
        surface,
        attempt,
        attemptState,
        leaseToken: options.leaseToken,
        idempotencyKey: decodeIdempotencyKey(`attempt:${commandId}:${attempt}`),
      })

      this.#db.exec('COMMIT')

      return {
        rootId: options.rootId,
        commandId: Schema.decodeUnknownSync(CommandId)(commandId),
        commandKey,
        intentEventId: decodeSyncEventId(readString(row, 'intent_event_id')),
        surface,
        commandTag: readString(row, 'command_tag'),
        command: decodePlanCommand(plannedEvent),
        baseHash:
          readOptionalString(row, 'base_hash') === undefined
            ? undefined
            : decodeHash(readString(row, 'base_hash')),
        desiredHash: decodeHash(readString(row, 'desired_hash')),
        preflight: Schema.decodeSync(Schema.parseJson(Schema.Array(GuardName)))(
          readString(row, 'preflight_json'),
        ),
        attempt,
        leaseToken: options.leaseToken,
        previousState,
        attemptState,
        attemptEvent,
      }
    } catch (cause) {
      this.#db.exec('ROLLBACK')
      throw cause
    }
  }

  isOutboxLeaseActive({
    rootId,
    commandId,
    leaseToken,
  }: {
    readonly rootId: SyncRootId
    readonly commandId: CommandId
    readonly leaseToken: string
  }): boolean {
    const row = this.#db
      .prepare(
        `SELECT state, lease_token, settlement_event_id
         FROM outbox
         WHERE root_id = ? AND command_id = ?`,
      )
      .get(rootId, commandId)

    return (
      row !== undefined &&
      readOutboxState(row, 'state') === 'running' &&
      readOptionalString(row, 'lease_token') === leaseToken &&
      readOptionalString(row, 'settlement_event_id') === undefined
    )
  }

  appendOutboxAttemptState(input: OutboxAttemptStateInput): SyncEvent {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const event = this.#appendOutboxAttemptStateInTransaction(input)
      this.#db.exec('COMMIT')
      return event
    } catch (cause) {
      this.#db.exec('ROLLBACK')
      throw cause
    }
  }

  appendOutboxSettlement(input: OutboxSettlementInput): SyncEvent {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const event = this.#appendEventInTransaction(
        Schema.decodeUnknownSync(SyncEvent)({
          _tag: 'RemoteWriteSettled',
          eventId: makeEventId(['settled', input.commandId, input.settlementKind]),
          rootId: input.rootId,
          sequence: '0',
          codecVersion: 'v1',
          family: 'CommandSettled',
          eventType: 'RemoteWriteSettled',
          idempotencyKey: input.idempotencyKey ?? `settled:${input.commandId}`,
          surface: input.surface,
          causedByEventIds: [],
          payloadHash: decodeHash('sha256:'.padEnd(71, '0')),
          payload: eventPayload(
            stringifyJson({
              commandId: input.commandId,
              settlementKind: input.settlementKind,
              desiredHash: input.desiredHash,
              observedHash: input.observedHash,
            }),
          ),
          observedAt: currentIso(this.#now),
          commandId: input.commandId,
          commandTag: input.commandTag,
          requestId: input.requestId,
          desiredHash: input.desiredHash,
          observedHash: input.observedHash,
          settlementKind: input.settlementKind,
        }),
      )
      this.#db.exec('COMMIT')
      return event
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
      digest: decodeHash(readString(row, 'digest')),
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

  readPlannerProjectionSnapshot(rootId: SyncRootId): PlannerProjectionSnapshot {
    const apiRow = this.#db
      .prepare(
        `SELECT api_version
         FROM api_contract_projection
         WHERE root_id = ?
         ORDER BY updated_at DESC, api_version
         LIMIT 1`,
      )
      .get(rootId)
    const capabilityRows = this.#db
      .prepare(
        `SELECT capability, supported
         FROM capability_projection
         WHERE root_id = ?
         ORDER BY capability`,
      )
      .all(rootId)
    const requiredCapabilities = capabilityRows.map((row) =>
      decodeCapabilityName(readString(row, 'capability')),
    )
    const supportedCapabilities = capabilityRows
      .filter((row) => readBoolean(row, 'supported'))
      .map((row) => decodeCapabilityName(readString(row, 'capability')))

    const pendingProperties = this.#pendingPropertyIntents(rootId)

    return {
      rootId,
      api: {
        configuredApiVersion:
          apiRow === undefined ? '2026-03-11' : readString(apiRow, 'api_version'),
        compatibilityProof: apiRow === undefined ? 'missing' : 'present',
      },
      capabilities: {
        required: requiredCapabilities,
        supported: supportedCapabilities,
        preflight:
          capabilityRows.length > 0 && capabilityRows.every((row) => readBoolean(row, 'supported'))
            ? 'passed'
            : 'failed',
      },
      schema: this.#db
        .prepare(
          `SELECT data_source_id, property_id, schema_hash, config_hash, write_class
           FROM schema_property_projection
           WHERE root_id = ?
           ORDER BY data_source_id, property_id`,
        )
        .all(rootId)
        .map((row) => ({
          dataSourceId: decodeDataSourceId(readString(row, 'data_source_id')),
          propertyId: decodePropertyId(readString(row, 'property_id')),
          schemaHash: decodeHash(readString(row, 'schema_hash')),
          configHash: decodeHash(readString(row, 'config_hash')),
          writeClass: Schema.decodeUnknownSync(
            Schema.Literal('writable', 'computed', 'unsupported'),
          )(readString(row, 'write_class')),
        })),
      rows: this.#db
        .prepare(
          `SELECT page_id, data_source_id, properties_hash, in_trash, moved_out, local_delete_candidate
           FROM row_projection
           WHERE root_id = ?
           ORDER BY data_source_id, page_id`,
        )
        .all(rootId)
        .map((row) => ({
          pageId: decodePageId(readString(row, 'page_id')),
          dataSourceId: decodeDataSourceId(readString(row, 'data_source_id')),
          propertiesHash: decodeHash(readString(row, 'properties_hash')),
          inTrash: readBoolean(row, 'in_trash'),
          movedOut: readBoolean(row, 'moved_out'),
          localDeleteCandidate: readBoolean(row, 'local_delete_candidate'),
        })),
      properties: this.#db
        .prepare(
          `SELECT page_id, property_id, base_hash, remote_hash, availability
           FROM property_shadow_projection
           WHERE root_id = ?
           ORDER BY page_id, property_id`,
        )
        .all(rootId)
        .map((row) => {
          const pageId = decodePageId(readString(row, 'page_id'))
          const propertyId = decodePropertyId(readString(row, 'property_id'))

          return {
            pageId,
            propertyId,
            baseHash: decodeHash(readString(row, 'base_hash')),
            remoteHash: decodeHash(readString(row, 'remote_hash')),
            availability: Schema.decodeUnknownSync(
              Schema.Literal(
                'complete',
                'computed',
                'unsupported',
                'paginated-incomplete',
                'relation-target-inaccessible',
                'related-data-source-unshared',
              ),
            )(readString(row, 'availability')),
            pendingLocal: pendingProperties.get(`${pageId}\0${propertyId}`),
          }
        }),
      bodies: this.#db
        .prepare(
          `SELECT
             page_id,
             path,
             base_hash,
             current_hash,
             sidecar_identity_proven,
             own_write_materialization_ids_json,
             safety_json
           FROM body_pointer_projection
           WHERE root_id = ?
           ORDER BY page_id`,
        )
        .all(rootId)
        .map((row) => ({
          pageId: decodePageId(readString(row, 'page_id')),
          path: readString(row, 'path'),
          baseHash: decodeHash(readString(row, 'base_hash')),
          currentHash: decodeHash(readString(row, 'current_hash')),
          sidecarIdentityProven: readBoolean(row, 'sidecar_identity_proven'),
          ownWriteMaterializationIds: Schema.decodeSync(
            Schema.parseJson(Schema.Array(Schema.String)),
          )(readString(row, 'own_write_materialization_ids_json')),
          safety: decodeBodySafetyFromJson(readString(row, 'safety_json')),
        })),
      tombstones: this.#readTombstones(rootId),
      queries: this.#readQuerySurfaces(rootId),
      pathClaims: this.#db
        .prepare(
          `SELECT relative_path, page_id, state
           FROM path_claim
           WHERE root_id = ?
           ORDER BY relative_path`,
        )
        .all(rootId)
        .map((row) => ({
          path: readString(row, 'relative_path'),
          ownerPageId: decodePageId(readString(row, 'page_id')),
          released: readString(row, 'state') === 'released',
        })),
      localWorkspace: [],
      remoteChanges: [],
    }
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

  readStatusProjection(rootId: SyncRootId): StoreStatusProjection {
    const outboxRows = this.#db
      .prepare(
        `SELECT state, COUNT(*) AS count
         FROM outbox
         WHERE root_id = ?
         GROUP BY state`,
      )
      .all(rootId)
    const outbox = {
      queued: 0,
      running: 0,
      retryable: 0,
      blocked: 0,
      settled: 0,
      fenced: 0,
      ambiguous: 0,
    } satisfies StoreStatusProjection['outbox']

    for (const row of outboxRows) {
      outbox[readOutboxState(row, 'state')] = Number(readInteger(row, 'count'))
    }

    return {
      outbox,
      conflicts: {
        open: readCount(
          this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM conflict_projection
               WHERE root_id = ? AND state = 'open'`,
            )
            .get(rootId),
          'count',
        ),
      },
      tombstones: {
        unclassified: readCount(
          this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM tombstone_projection
               WHERE root_id = ? AND classification = 'unclassified'`,
            )
            .get(rootId),
          'count',
        ),
      },
      guards: {
        blocked: readCount(
          this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM guard_block_projection
               WHERE root_id = ?`,
            )
            .get(rootId),
          'count',
        ),
      },
      capabilities: {
        unsupported: readCount(
          this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM capability_projection
               WHERE root_id = ? AND supported = 0`,
            )
            .get(rootId),
          'count',
        ),
      },
      checkpoints: {
        incompleteQueries: readCount(
          this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM query_scan_checkpoint
               WHERE root_id = ? AND complete = 0`,
            )
            .get(rootId),
          'count',
        ),
        cappedQueries: readCount(
          this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM query_scan_checkpoint
               WHERE root_id = ? AND capped_at_limit = 1`,
            )
            .get(rootId),
          'count',
        ),
        changedQueryContracts: readCount(
          this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM query_scan_checkpoint
               WHERE root_id = ? AND contract_changed = 1`,
            )
            .get(rootId),
          'count',
        ),
        incompleteProperties: readCount(
          this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM page_property_checkpoint
               WHERE root_id = ? AND complete = 0`,
            )
            .get(rootId),
          'count',
        ),
      },
      projections: {
        dataSources: readCount(
          this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM data_source_projection
               WHERE root_id = ?`,
            )
            .get(rootId),
          'count',
        ),
        rows: readCount(
          this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM row_projection
               WHERE root_id = ?`,
            )
            .get(rootId),
          'count',
        ),
        properties: readCount(
          this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM property_shadow_projection
               WHERE root_id = ?`,
            )
            .get(rootId),
          'count',
        ),
        bodies: readCount(
          this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM body_pointer_projection
               WHERE root_id = ?`,
            )
            .get(rootId),
          'count',
        ),
      },
    }
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

  #appendEventInTransaction(event: SyncEvent): SyncEvent {
    return this.#appendEventWithResultInTransaction(event).event
  }

  #appendEventWithResultInTransaction(event: SyncEvent): {
    readonly event: SyncEvent
    readonly inserted: boolean
  } {
    this.#ensureRoot(event.rootId)

    const existing = this.#db
      .prepare(
        `SELECT event_json
         FROM sync_event
         WHERE root_id = ? AND idempotency_key = ?`,
      )
      .get(event.rootId, event.idempotencyKey)

    if (existing !== undefined) {
      return { event: decodeEventFromJson(readString(existing, 'event_json')), inserted: false }
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
    return { event: eventWithAssignedFields, inserted: true }
  }

  #appendOutboxAttemptStateInTransaction(
    input: OutboxAttemptStateInput,
  ): Extract<SyncEvent, { readonly _tag: 'RemoteWriteAttempted' }> {
    const event = this.#appendEventInTransaction(
      Schema.decodeUnknownSync(SyncEvent)({
        _tag: 'RemoteWriteAttempted',
        eventId: makeEventId(['attempt', input.commandId, input.attempt, input.attemptState]),
        rootId: input.rootId,
        sequence: '0',
        codecVersion: 'v1',
        family: 'CommandAttempted',
        eventType: 'RemoteWriteAttempted',
        idempotencyKey:
          input.idempotencyKey ??
          `attempt:${input.commandId}:${input.attempt}:${input.attemptState}`,
        surface: input.surface,
        causedByEventIds: [],
        payloadHash: decodeHash('sha256:'.padEnd(71, '0')),
        payload: eventPayload(
          stringifyJson({
            commandId: input.commandId,
            attempt: input.attempt,
            attemptState: input.attemptState,
            guard: input.guard,
          }),
        ),
        observedAt: currentIso(this.#now),
        commandId: input.commandId,
        attempt: input.attempt,
        attemptState: input.attemptState,
        ...(input.leaseToken === undefined ? {} : { leaseToken: input.leaseToken }),
        ...(input.guard === undefined ? {} : { guard: input.guard }),
      }),
    )

    if (event._tag !== 'RemoteWriteAttempted') {
      throw new LocalStoreError({
        operation: 'append-outbox-attempt',
        message: `Outbox attempt idempotency key resolved to unexpected event ${event._tag}`,
      })
    }

    return event
  }

  #runMigrations(): void {
    assertSupportedSchemaVersion(this.#db)

    this.#db.exec(createStoreSchemaSql)
    for (const statement of [
      `ALTER TABLE query_scan_checkpoint
       ADD COLUMN capped_at_limit INTEGER NOT NULL DEFAULT 0 CHECK (capped_at_limit IN (0, 1))`,
      `ALTER TABLE query_scan_checkpoint
       ADD COLUMN contract_changed INTEGER NOT NULL DEFAULT 0 CHECK (contract_changed IN (0, 1))`,
    ]) {
      try {
        this.#db.exec(statement)
      } catch (cause) {
        if (String(cause).includes('duplicate column name') === false) {
          throw cause
        }
      }
    }
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO migration_history (schema_version, migration_name, applied_at)
         VALUES (?, ?, ?)`,
      )
      .run(STORE_SCHEMA_VERSION, 'planner-projection-schema', currentIso(this.#now))
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

  #pendingPropertyIntents(
    rootId: SyncRootId,
  ): ReadonlyMap<
    string,
    { readonly intentEventId: typeof SyncEventId.Type; readonly targetHash: typeof Hash.Type }
  > {
    const pending = new Map<
      string,
      { readonly intentEventId: typeof SyncEventId.Type; readonly targetHash: typeof Hash.Type }
    >()

    const rows = this.#db
      .prepare(
        `SELECT intent_event_id, surface, desired_hash
         FROM outbox
         WHERE root_id = ?
           AND command_tag = 'PatchPageProperties'
           AND settlement_event_id IS NULL
           AND state IN ('queued', 'running', 'retryable', 'blocked', 'ambiguous')
         ORDER BY command_id`,
      )
      .all(rootId)

    for (const row of rows) {
      const surface = parsePropertySurface(readOptionalString(row, 'surface'))
      if (surface === undefined) continue

      pending.set(`${surface.pageId}\0${surface.propertyId}`, {
        intentEventId: decodeSyncEventId(readString(row, 'intent_event_id')),
        targetHash: decodeHash(readString(row, 'desired_hash')),
      })
    }

    return pending
  }

  #readTombstones(rootId: SyncRootId): PlannerProjectionSnapshot['tombstones'] {
    return this.#db
      .prepare(
        `SELECT
           tombstone.page_id,
           tombstone.classification,
           absence.data_source_id,
           absence.query_contract_hash,
           absence.direct_retrieve
         FROM tombstone_projection tombstone
         LEFT JOIN query_absence_projection absence
           ON absence.root_id = tombstone.root_id
          AND absence.page_id = tombstone.page_id
          AND absence.evidence_event_id = tombstone.event_id
         WHERE tombstone.root_id = ?
         ORDER BY tombstone.page_id, absence.data_source_id, absence.query_contract_hash`,
      )
      .all(rootId)
      .map((row) => {
        const pageId = readString(row, 'page_id')
        const classification = readString(row, 'classification')
        const state =
          classification === 'unclassified'
            ? 'candidate'
            : classification === 'remote_trash'
              ? 'remote-trash'
              : classification === 'moved_out' || classification === 'moved_between_tracked_sources'
                ? 'moved-out'
                : classification === 'inaccessible' || classification === 'unknown'
                  ? classification
                  : 'none'
        const directRetrieve =
          row.direct_retrieve === null || row.direct_retrieve === undefined
            ? classification === 'remote_trash'
              ? 'in-trash'
              : classification === 'moved_out' || classification === 'moved_between_tracked_sources'
                ? 'moved-out'
                : classification === 'inaccessible' || classification === 'unknown'
                  ? classification
                  : 'not-run'
            : Schema.decodeUnknownSync(
                Schema.Literal(
                  'not-run',
                  'accessible',
                  'in-trash',
                  'moved-out',
                  'permission-ambiguous',
                  'inaccessible',
                  'unknown',
                ),
              )(readString(row, 'direct_retrieve'))

        return {
          pageId: decodePageId(pageId),
          dataSourceId:
            row.data_source_id === null || row.data_source_id === undefined
              ? undefined
              : decodeDataSourceId(readString(row, 'data_source_id')),
          queryContractHash:
            row.query_contract_hash === null || row.query_contract_hash === undefined
              ? undefined
              : decodeHash(readString(row, 'query_contract_hash')),
          state,
          directRetrieve,
        }
      })
  }

  #readQuerySurfaces(rootId: SyncRootId): PlannerProjectionSnapshot['queries'] {
    return this.#db
      .prepare(
        `SELECT
           absence.data_source_id,
           absence.page_id,
           absence.query_contract_hash,
           absence.classified,
           absence.membership_scope,
           absence.filtered,
           absence.direct_retrieve,
           checkpoint.complete,
           checkpoint.capped_at_limit,
           checkpoint.contract_changed
         FROM query_absence_projection absence
         LEFT JOIN query_scan_checkpoint checkpoint
           ON checkpoint.root_id = absence.root_id
          AND checkpoint.data_source_id = absence.data_source_id
          AND checkpoint.query_contract_hash = absence.query_contract_hash
         WHERE absence.root_id = ?
         ORDER BY absence.data_source_id, absence.page_id, absence.query_contract_hash`,
      )
      .all(rootId)
      .map((row) => ({
        dataSourceId: decodeDataSourceId(readString(row, 'data_source_id')),
        pageId: decodePageId(readString(row, 'page_id')),
        queryContractHash: decodeHash(readString(row, 'query_contract_hash')),
        completeness: {
          terminal:
            row.complete === null || row.complete === undefined
              ? false
              : readBoolean(row, 'complete'),
          cappedAtLimit:
            row.capped_at_limit === null || row.capped_at_limit === undefined
              ? false
              : readBoolean(row, 'capped_at_limit'),
          contractChanged:
            row.contract_changed === null || row.contract_changed === undefined
              ? false
              : readBoolean(row, 'contract_changed'),
        },
        absence: {
          classified: readBoolean(row, 'classified'),
          membershipScope: Schema.decodeUnknownSync(
            Schema.Literal('all-data-source-rows', 'explicit-filter'),
          )(readString(row, 'membership_scope')),
          filtered: readBoolean(row, 'filtered'),
          directRetrieve: Schema.decodeUnknownSync(
            Schema.Literal(
              'not-run',
              'accessible',
              'in-trash',
              'moved-out',
              'permission-ambiguous',
              'inaccessible',
              'unknown',
            ),
          )(readString(row, 'direct_retrieve')),
        },
      }))
  }

  #rebuildProjectionsInTransaction(rootId: SyncRootId): ProjectionMetadata {
    this.#clearProjectionTablesForRoot(rootId)

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

  #clearProjectionTablesForRoot(rootId: SyncRootId): void {
    for (const table of rootScopedProjectionTables) {
      this.#db.prepare(`DELETE FROM ${table} WHERE root_id = ?`).run(rootId)
    }
  }

  #applyQueryAbsenceEvidence(
    event: Extract<
      SyncEvent,
      { readonly _tag: 'TombstoneCandidateObserved' | 'TombstoneRecorded' }
    >,
    defaultClassified: boolean,
  ): void {
    const payload = decodePayload(event, decodeQueryAbsenceProjectionPayload)
    if (
      payload?.dataSourceId === undefined ||
      payload.queryContractHash === undefined ||
      (payload.pageId !== undefined && payload.pageId !== event.pageId)
    ) {
      return
    }

    const directRetrieve =
      payload.directRetrieve ??
      (event._tag === 'TombstoneRecorded'
        ? event.reason === 'remote_trash'
          ? 'in-trash'
          : event.reason === 'moved_out' || event.reason === 'moved_between_tracked_sources'
            ? 'moved-out'
            : event.reason
        : 'not-run')

    this.#db
      .prepare(
        `INSERT INTO query_absence_projection (
           root_id,
           data_source_id,
           page_id,
           query_contract_hash,
           classified,
           membership_scope,
           filtered,
           direct_retrieve,
           evidence_event_id,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(root_id, data_source_id, page_id, query_contract_hash) DO UPDATE SET
           classified = excluded.classified,
           membership_scope = excluded.membership_scope,
           filtered = excluded.filtered,
           direct_retrieve = excluded.direct_retrieve,
           evidence_event_id = excluded.evidence_event_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        event.rootId,
        payload.dataSourceId,
        event.pageId,
        payload.queryContractHash,
        (payload.classified ?? defaultClassified) ? 1 : 0,
        payload.membershipScope ?? 'all-data-source-rows',
        payload.filtered === true ? 1 : 0,
        directRetrieve,
        event.eventId,
        currentIso(this.#now),
      )
  }

  #applyEvent(event: SyncEvent): void {
    switch (event._tag) {
      case 'SyncBindingRecorded':
        break
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
      case 'DataSourceObserved': {
        const payload = decodePayload(event, decodeDataSourceProjectionPayload)
        this.#db
          .prepare(
            `INSERT INTO data_source_projection (
               root_id,
               data_source_id,
               request_id,
               schema_hash,
               observed_event_id,
               observed_at,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, data_source_id) DO UPDATE SET
               request_id = excluded.request_id,
               schema_hash = excluded.schema_hash,
               observed_event_id = excluded.observed_event_id,
               observed_at = excluded.observed_at,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.dataSourceId,
            event.requestId,
            event.schemaHash,
            event.eventId,
            Schema.encodeSync(Schema.DateTimeUtc)(event.observedAt),
            currentIso(this.#now),
          )

        if (payload?.schemaProperties !== undefined) {
          this.#db
            .prepare(
              `DELETE FROM schema_property_projection
               WHERE root_id = ? AND data_source_id = ?`,
            )
            .run(event.rootId, event.dataSourceId)
        }

        for (const property of payload?.schemaProperties ?? []) {
          this.#db
            .prepare(
              `INSERT INTO schema_property_projection (
                 root_id,
                 data_source_id,
                 property_id,
                 schema_hash,
                 config_hash,
                 write_class,
                 observed_event_id,
                 updated_at
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(root_id, data_source_id, property_id) DO UPDATE SET
                 schema_hash = excluded.schema_hash,
                 config_hash = excluded.config_hash,
                 write_class = excluded.write_class,
                 observed_event_id = excluded.observed_event_id,
                 updated_at = excluded.updated_at`,
            )
            .run(
              event.rootId,
              event.dataSourceId,
              property.propertyId,
              event.schemaHash,
              property.configHash,
              property.writeClass,
              event.eventId,
              currentIso(this.#now),
            )
        }
        break
      }
      case 'RowObserved': {
        const payload = decodePayload(event, decodeRowProjectionPayload)
        this.#db
          .prepare(
            `INSERT INTO row_projection (
               root_id,
               data_source_id,
               page_id,
               properties_hash,
               in_trash,
               moved_out,
               local_delete_candidate,
               observed_event_id,
               observed_at,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, page_id) DO UPDATE SET
               data_source_id = excluded.data_source_id,
               properties_hash = excluded.properties_hash,
               in_trash = excluded.in_trash,
               moved_out = excluded.moved_out,
               local_delete_candidate = excluded.local_delete_candidate,
               observed_event_id = excluded.observed_event_id,
               observed_at = excluded.observed_at,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.dataSourceId,
            event.pageId,
            event.propertiesHash,
            event.inTrash ? 1 : 0,
            payload?.movedOut === true ? 1 : 0,
            payload?.localDeleteCandidate === true ? 1 : 0,
            event.eventId,
            Schema.encodeSync(Schema.DateTimeUtc)(event.observedAt),
            currentIso(this.#now),
          )

        if (event.bodyPointer !== undefined) {
          const safetyPayload = decodePayload(event, decodeBodyProjectionSafetyPayload)
          const safety =
            event.bodyPointer.safety ?? safetyPayload?.safety ?? defaultUnsafeBodySafety
          const bodyHash = event.bodyPointer.bodyHash
          this.#db
            .prepare(
              `INSERT INTO body_pointer_projection (
                 root_id,
                 page_id,
                 path,
                 base_hash,
                 current_hash,
                 sidecar_identity_proven,
                 own_write_materialization_ids_json,
                 safety_json,
                 observed_event_id,
                 updated_at
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(root_id, page_id) DO UPDATE SET
                 path = excluded.path,
                 current_hash = excluded.current_hash,
                 sidecar_identity_proven = excluded.sidecar_identity_proven,
                 own_write_materialization_ids_json = excluded.own_write_materialization_ids_json,
                 safety_json = excluded.safety_json,
                 observed_event_id = excluded.observed_event_id,
                 updated_at = excluded.updated_at`,
            )
            .run(
              event.rootId,
              event.pageId,
              payload?.bodyPath ?? `page:${event.pageId}:body`,
              bodyHash,
              bodyHash,
              payload?.sidecarIdentityProven === true ? 1 : 0,
              stringifyJson(payload?.ownWriteMaterializationIds ?? []),
              stringifyJson(encodeBodySafety(safety)),
              event.eventId,
              currentIso(this.#now),
            )
        }
        break
      }
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
            `SELECT attempt_count, lease_token, settlement_event_id
             FROM outbox
             WHERE root_id = ? AND command_id = ?`,
          )
          .get(event.rootId, event.commandId)

        if (
          existing !== undefined &&
          readOptionalString(existing, 'settlement_event_id') === undefined
        ) {
          const currentAttempt = Number(readInteger(existing, 'attempt_count'))
          const currentLeaseToken = readOptionalString(existing, 'lease_token')
          const eventMatchesCurrentLease =
            currentLeaseToken === undefined || event.leaseToken === currentLeaseToken

          if (event.attempt < currentAttempt) {
            break
          }

          if (event.attempt === currentAttempt && eventMatchesCurrentLease === false) {
            break
          }

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
      case 'RemoteWriteSettled': {
        const existing = this.#db
          .prepare(
            `SELECT command_tag, state, desired_hash, attempt_count, settlement_event_id
             FROM outbox
             WHERE root_id = ? AND command_id = ?`,
          )
          .get(event.rootId, event.commandId)

        if (
          existing !== undefined &&
          readOptionalString(existing, 'settlement_event_id') === undefined &&
          readString(existing, 'command_tag') === event.commandTag &&
          readString(existing, 'desired_hash') === event.desiredHash &&
          event.observedHash === event.desiredHash &&
          readInteger(existing, 'attempt_count') > 0n &&
          (readOutboxState(existing, 'state') === 'running' ||
            readOutboxState(existing, 'state') === 'ambiguous')
        ) {
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
        }
        break
      }
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
        this.#applyQueryAbsenceEvidence(event, false)
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
        this.#applyQueryAbsenceEvidence(event, true)
        break
      case 'GuardBlocked':
        this.#db
          .prepare(
            `INSERT INTO guard_block_projection (
               root_id,
               block_id,
               surface,
               guard,
               message,
               event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, block_id) DO UPDATE SET
               surface = excluded.surface,
               guard = excluded.guard,
               message = excluded.message,
               event_id = excluded.event_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.idempotencyKey,
            event.surface ?? null,
            event.guard,
            event.message,
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
      case 'QueryScanCheckpointRecorded': {
        const payload = decodePayload(event, decodeQueryCheckpointProjectionPayload)
        this.#db
          .prepare(
            `INSERT INTO query_scan_checkpoint (
               root_id,
               data_source_id,
               query_contract_hash,
               next_cursor,
               complete,
               capped_at_limit,
               contract_changed,
               high_watermark,
               event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, data_source_id, query_contract_hash) DO UPDATE SET
               next_cursor = excluded.next_cursor,
               complete = excluded.complete,
               capped_at_limit = excluded.capped_at_limit,
               contract_changed = excluded.contract_changed,
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
            payload?.cappedAtLimit === true ? 1 : 0,
            payload?.contractChanged === true ? 1 : 0,
            event.highWatermark === null
              ? null
              : Schema.encodeSync(Schema.DateTimeUtc)(event.highWatermark),
            event.eventId,
            currentIso(this.#now),
          )
        break
      }
      case 'PagePropertyCheckpointRecorded': {
        const payload = decodePayload(event, decodePropertyCheckpointProjectionPayload)
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
        if (event.valueHash !== undefined) {
          this.#db
            .prepare(
              `INSERT INTO property_shadow_projection (
                 root_id,
                 page_id,
                 property_id,
                 base_hash,
                 remote_hash,
                 availability,
                 observed_event_id,
                 updated_at
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(root_id, page_id, property_id) DO UPDATE SET
                 remote_hash = excluded.remote_hash,
                 availability = excluded.availability,
                 observed_event_id = excluded.observed_event_id,
                 updated_at = excluded.updated_at`,
            )
            .run(
              event.rootId,
              event.pageId,
              event.propertyId,
              payload?.baseHash ?? event.valueHash,
              event.valueHash,
              payload?.availability ?? (event.complete ? 'complete' : 'paginated-incomplete'),
              event.eventId,
              currentIso(this.#now),
            )
        }
        break
      }
      case 'LocalIntentAccepted':
      case 'DecodeDriftBlocked':
        break
    }
  }
}

export const openNotionSyncStore = (options: OpenNotionSyncStoreOptions): NotionSyncStore =>
  new NotionSyncStore(options)
