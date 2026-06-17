/**
 * Map the engine's polymorphic one-shot sync results into {@link SyncAction}s.
 *
 * `syncPath` returns one of four shapes and the legacy two-arg path returns a
 * `PullResult`; this module normalizes each into the view's `SetSingle` /
 * `SetPages` vocabulary so the handler wiring stays declarative:
 *
 * - `SyncResult` (single file) → `SetSingle` (pushed/pulled/noop)
 * - `PullResult` (legacy `<page> <file>`) → `SetSingle` (pulled)
 * - `TreeSyncResult` (directory tree) → `SetPages` (TreeOp → outcome rows)
 * - `BatchResult<SyncResult>` (recursive batch) → `SetPages` (per-file rows)
 *
 * @module
 */

import type { BatchResult } from '../../batch.ts'
import type { SyncResult } from '../../sync.ts'
import type { TreeOp, TreeSyncResult } from '../../tree.ts'
import type { SyncAction, SyncPageOutcome, SyncPageRow } from './schema.ts'

/** Any shape a one-shot sync handler can hand to the view normalizer. */
export type SyncEngineResult =
  | SyncResult
  | TreeSyncResult
  | BatchResult<SyncResult>
  | { readonly path: string; readonly pageId: string; readonly storage: string } // PullResult-ish

/** Map a tree reconcile op to a per-page row outcome. */
const treeOpOutcome = (op: TreeOp): SyncPageOutcome => {
  switch (op._tag) {
    case 'create':
      return 'created'
    case 'update':
      return 'updated'
    case 'move':
      return 'moved'
    case 'materialize':
      return 'materialized'
    case 'trash':
      return 'trashed'
    case 'trash_blocked':
      return 'blocked'
    case 'conflict':
      return 'conflict'
    case 'noop':
      return 'noop'
  }
}

/** Map one batch item to a per-page row (success → SyncResult tag, failure → error). */
const batchItemRow = (item: BatchResult<SyncResult>['items'][number]): SyncPageRow =>
  item._tag === 'success'
    ? { path: item.path, outcome: item.result._tag }
    : { path: item.path, outcome: 'error' }

/** True when the value is the engine `TreeSyncResult` envelope. */
const isTree = (result: SyncEngineResult): result is TreeSyncResult =>
  '_tag' in result && result._tag === 'tree'

/** True when the value is the engine `BatchResult` envelope. */
const isBatch = (result: SyncEngineResult): result is BatchResult<SyncResult> =>
  '_tag' in result && result._tag === 'batch'

/** True when the value is a single-page `SyncResult`. */
const isSyncResult = (result: SyncEngineResult): result is SyncResult =>
  '_tag' in result &&
  (result._tag === 'pushed' || result._tag === 'pulled' || result._tag === 'noop')

/** Normalize any one-shot engine result into the terminal {@link SyncAction}. */
export const syncResultAction = (result: SyncEngineResult): SyncAction => {
  if (isTree(result) === true) {
    return {
      _tag: 'SetPages',
      pages: result.ops.map((op) => ({ path: op.relPath, outcome: treeOpOutcome(op) })),
    }
  }
  if (isBatch(result) === true) {
    return { _tag: 'SetPages', pages: result.items.map(batchItemRow) }
  }
  if (isSyncResult(result) === true) {
    return { _tag: 'SetSingle', outcome: result._tag }
  }
  // Legacy two-arg pull (`PullResult`): no `_tag`, always a materialized pull.
  return { _tag: 'SetSingle', outcome: 'pulled' }
}

/**
 * Map a one-shot sync engine failure to a terminal {@link SyncAction}. A single
 * `NmdConflictError` renders as a `Conflict` (kept at exit 7 by the uncaught
 * propagation); everything else is a hard `Error`.
 */
export const syncErrorAction = (error: unknown): SyncAction => {
  const tag =
    typeof error === 'object' && error !== null && '_tag' in error
      ? (error as { readonly _tag?: unknown })._tag
      : undefined
  return tag === 'NmdConflictError'
    ? { _tag: 'SetSingle', outcome: 'conflict' }
    : { _tag: 'SetError', message: String(error) }
}
