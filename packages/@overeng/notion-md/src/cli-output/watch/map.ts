/**
 * Map the watch loop's emit events into {@link WatchAction}s for the live view.
 *
 * `runWatch`/`runBatchWatch` build heterogeneous emit events:
 *
 * - single-file: `{ event: 'sync', reason, result: SyncResult }`
 * - batch:       `{ event: 'sync', reason, paths, result: BatchResult }`
 * - failures:    `{ event: 'sync_error', reason, error }` and
 *                `{ event: 'watch_error', path, error }`
 *
 * This mapper is invoked ONLY on the react (TTY) branch — the machine modes run
 * the identical loop with the original `writeJsonLine` emit, so nothing here can
 * affect the ndjson stream. It classifies each event into a `WatchPass`,
 * SYNTHESIZING the `conflict` outcome from an `NmdConflictError` (there is no
 * `conflict` engine result tag — a single-file conflict surfaces as a
 * `sync_error`).
 *
 * @module
 */

import type { WatchAction, WatchOutcome, WatchReason } from './schema.ts'

/** Narrow an unknown emit event to a record. */
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

/** Read a string field, or undefined. */
const str = ({
  record,
  key,
}: {
  readonly record: Record<string, unknown>
  readonly key: string
}): string | undefined => (typeof record[key] === 'string' ? (record[key] as string) : undefined)

/** Read the `_tag` of a value, or undefined. */
const tagOf = (value: unknown): string | undefined => {
  const record = asRecord(value)
  return record === undefined ? undefined : str({ record, key: '_tag' })
}

/** Read an array field, or an empty array. */
const arrayOf = ({
  record,
  key,
}: {
  readonly record: Record<string, unknown>
  readonly key: string
}): readonly unknown[] => {
  const value = record[key]
  return Array.isArray(value) === true ? (value as readonly unknown[]) : []
}

/** Coerce an arbitrary reason string into a {@link WatchReason} (`poll` fallback). */
const coerceReason = (reason: string | undefined): WatchReason => {
  switch (reason) {
    case 'file':
    case 'initial':
    case 'poll':
    case 'batch':
      return reason
    default:
      return 'poll'
  }
}

/** Map a single-file `SyncResult._tag` (`noop`/`pulled`/`pushed`) to an outcome. */
const syncResultOutcome = (result: unknown): WatchOutcome => {
  switch (tagOf(result)) {
    case 'pushed':
      return 'pushed'
    case 'pulled':
      return 'pulled'
    case 'noop':
      return 'noop'
    default:
      return 'noop'
  }
}

/** True when an error payload is a conflict (`NmdConflictError`). */
const isConflictError = (error: unknown): boolean => tagOf(error) === 'NmdConflictError'

/** Short human detail from an error payload (`message`, falling back to `_tag`). */
const errorDetail = (error: unknown): string => {
  const record = asRecord(error)
  if (record === undefined) return String(error)
  return str({ record, key: 'message' }) ?? str({ record, key: '_tag' }) ?? 'unknown error'
}

/**
 * A `BatchResult.items[]` entry → outcome. `success{result}` carries a
 * `SyncResult`; `error{error}` wraps the raw failure (a per-file conflict
 * arrives as a `BatchFailure` whose `error` is an `NmdConflictError`, so it
 * must be reclassified to `conflict` rather than the generic `error` bucket).
 */
const batchItemOutcome = (item: unknown): WatchOutcome => {
  const record = asRecord(item)
  if (record === undefined) return 'error'
  if (str({ record, key: '_tag' }) === 'error') {
    return isConflictError(record['error']) === true ? 'conflict' : 'error'
  }
  return syncResultOutcome(record['result'])
}

/**
 * Classify one emit event into a {@link WatchAction}, or `undefined` for events
 * that are not per-pass results (e.g. nothing today — `watch_error` IS surfaced
 * as a failed pass so the user sees fs-watch breakage).
 */
export const toWatchAction = (event: unknown): WatchAction | undefined => {
  const record = asRecord(event)
  if (record === undefined) return undefined
  const kind = str({ record, key: 'event' })
  const reason = coerceReason(str({ record, key: 'reason' }))

  if (kind === 'sync') {
    const result = record['result']
    // Batch passes carry a `BatchResult` (`_tag: 'batch'`) with `items[]`.
    if (tagOf(result) === 'batch') {
      const items = arrayOf({ record: asRecord(result) ?? {}, key: 'items' })
      const outcomes = items.map(batchItemOutcome)
      const conflicts = outcomes.filter((outcome) => outcome === 'conflict').length
      const errors = outcomes.filter((outcome) => outcome === 'error').length
      return {
        _tag: 'WatchPass',
        reason,
        result: { _tag: 'Batch', outcomes },
        ...(conflicts + errors > 0
          ? { detail: `${errors} failed · ${conflicts} conflict in batch` }
          : {}),
      }
    }
    // Single-file pass.
    return {
      _tag: 'WatchPass',
      reason,
      result: { _tag: 'Single', outcome: syncResultOutcome(result) },
    }
  }

  if (kind === 'sync_error') {
    const error = record['error']
    if (isConflictError(error) === true) {
      return {
        _tag: 'WatchPass',
        reason,
        result: { _tag: 'Single', outcome: 'conflict' },
        detail: 'local and remote both changed — nothing pushed',
      }
    }
    return {
      _tag: 'WatchPass',
      reason,
      result: { _tag: 'Failure', message: errorDetail(error) },
      detail: errorDetail(error),
    }
  }

  if (kind === 'watch_error') {
    return {
      _tag: 'WatchPass',
      reason,
      result: { _tag: 'Failure', message: errorDetail(record['error']) },
      detail: `file watch error: ${errorDetail(record['error'])}`,
    }
  }

  return undefined
}
