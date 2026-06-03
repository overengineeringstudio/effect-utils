import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** File formats supported by replica export. */
export type ReplicaExportFormat = 'json' | 'ndjson'

/** Inputs for exporting public replica surfaces into a portable file. */
export type ReplicaExportOptions = {
  readonly replicaPath: string
  readonly outputPath: string
  readonly format: ReplicaExportFormat
  readonly requireClean?: boolean
  readonly exportedAt?: string
}

/** Summary returned after a replica export file is written. */
export type ReplicaExportResult = {
  readonly _tag: 'ReplicaExportResult'
  readonly version: 'v1'
  readonly replicaPath: string
  readonly outputPath: string
  readonly format: ReplicaExportFormat
  readonly clean: boolean
  readonly counts: {
    readonly rows: number
    readonly schema: number
    readonly schemaProperties: number
    readonly pendingChanges: number
    readonly conflicts: number
  }
}

/** Error raised when a replica cannot be exported under the requested safety constraints. */
export class ReplicaExportError extends Error {
  readonly _tag = 'ReplicaExportError'
}

type JsonRecord = Record<string, unknown>

const jsonFieldNames = new Set([
  'config_json',
  'metadata_json',
  'operation_json',
  'value_json',
  'view_json',
])

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`

const parseJsonColumn = ({ key, value }: { readonly key: string; readonly value: unknown }) => {
  if (typeof value !== 'string' || jsonFieldNames.has(key) === false) return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

const normalizeRecord = (row: JsonRecord): JsonRecord =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? value.toString() : parseJsonColumn({ key, value }),
    ]),
  )

const readRecords = ({
  db,
  surface,
  orderBy,
}: {
  readonly db: DatabaseSync
  readonly surface: string
  readonly orderBy: string
}): readonly JsonRecord[] =>
  (
    db
      .prepare(`SELECT * FROM ${quoteIdentifier(surface)} ORDER BY ${orderBy}`)
      .all() as JsonRecord[]
  ).map(normalizeRecord)

const readStatus = (db: DatabaseSync): JsonRecord => {
  const row = db.prepare(`SELECT * FROM ${quoteIdentifier('sync_status')} LIMIT 1`).get() as
    | JsonRecord
    | undefined
  if (row === undefined) {
    throw new ReplicaExportError('Replica export requires a projected sync_status surface')
  }
  return normalizeRecord(row)
}

const readNumber = ({ row, key }: { readonly row: JsonRecord; readonly key: string }): number => {
  const value = row[key]
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return 0
}

const stringify = (value: unknown): string =>
  JSON.stringify(value, (_key, nested) => (typeof nested === 'bigint' ? nested.toString() : nested))

/** Export rows, schema, sync status, pending changes, and conflicts from a read-only replica. */
export const exportReplica = (options: ReplicaExportOptions): ReplicaExportResult => {
  const db = new DatabaseSync(options.replicaPath, { readOnly: true })
  try {
    const exportedAt = options.exportedAt ?? new Date().toISOString()
    const syncStatus = readStatus(db)
    const rows = readRecords({
      db,
      surface: 'rows',
      orderBy: `${quoteIdentifier('_data_source_id')}, ${quoteIdentifier('_page_id')}, ${quoteIdentifier('_local_row_id')}`,
    })
    const schema = readRecords({
      db,
      surface: 'schema',
      orderBy: `${quoteIdentifier('data_source_id')}`,
    })
    const schemaProperties = readRecords({
      db,
      surface: 'schema_properties',
      orderBy: `${quoteIdentifier('data_source_id')}, ${quoteIdentifier('ordinal')}, ${quoteIdentifier('property_id')}`,
    })
    const pendingChanges = readRecords({
      db,
      surface: 'changes',
      orderBy: `${quoteIdentifier('created_at')}, ${quoteIdentifier('change_id')}`,
    }).filter((change) =>
      ['pending', 'queued', 'planned', 'needs_reconciliation'].includes(String(change.status)),
    )
    const conflicts = readRecords({
      db,
      surface: 'conflicts',
      orderBy: `${quoteIdentifier('updated_at')}, ${quoteIdentifier('conflict_id')}`,
    }).filter((conflict) => String(conflict.state) === 'open')

    const clean =
      readNumber({ row: syncStatus, key: 'pending_local_changes' }) === 0 &&
      readNumber({ row: syncStatus, key: 'conflicts_open' }) === 0

    if (options.requireClean === true && clean === false) {
      throw new ReplicaExportError(
        'Replica has pending local changes or open conflicts; rerun without --require-clean to include pending metadata',
      )
    }

    const result: ReplicaExportResult = {
      _tag: 'ReplicaExportResult',
      version: 'v1',
      replicaPath: options.replicaPath,
      outputPath: options.outputPath,
      format: options.format,
      clean,
      counts: {
        rows: rows.length,
        schema: schema.length,
        schemaProperties: schemaProperties.length,
        pendingChanges: pendingChanges.length,
        conflicts: conflicts.length,
      },
    }

    mkdirSync(dirname(options.outputPath), { recursive: true })
    if (options.format === 'ndjson') {
      const lines = [
        {
          type: 'metadata',
          version: 'v1',
          exportedAt,
          replicaPath: options.replicaPath,
          clean,
        },
        { type: 'sync_status', record: syncStatus },
        ...schema.map((record) => ({ type: 'schema', record })),
        ...schemaProperties.map((record) => ({ type: 'schema_property', record })),
        ...pendingChanges.map((record) => ({ type: 'pending_change', record })),
        ...conflicts.map((record) => ({ type: 'conflict', record })),
        ...rows.map((record) => ({ type: 'row', record })),
      ]
      writeFileSync(options.outputPath, `${lines.map(stringify).join('\n')}\n`)
      return result
    }

    writeFileSync(
      options.outputPath,
      `${stringify({
        _tag: 'NotionDatasourceReplicaExport',
        version: 'v1',
        exportedAt,
        replicaPath: options.replicaPath,
        clean,
        sync: {
          status: syncStatus,
          pendingChanges,
          conflicts,
        },
        schema,
        schemaProperties,
        rows,
      })}\n`,
    )
    return result
  } finally {
    db.close()
  }
}
