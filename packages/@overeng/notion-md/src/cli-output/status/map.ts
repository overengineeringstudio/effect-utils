/**
 * Map the engine's polymorphic `status` results into the precomputed
 * {@link StatusResultPayload} the view renders (`sections` / `problems` /
 * `summary`).
 *
 * `statusPath` returns one of three shapes (and `statusMany` returns a batch):
 *
 * - `StatusResult` (single `.nmd` file) → one `state` section of change flags +
 *   an `unknown-blocks` section, a WARNING per drift / unresolved-blocks signal.
 * - `TreeSyncResult` (directory tree, `plan:true`) → a per-page `pages` section
 *   (one row per would-change op) + a WARNING per `conflict` / `trash_blocked`.
 * - `BatchResult<StatusResult>` (flat recursive batch) → a per-file `files`
 *   section + a WARNING per drifted/guarded/failed file.
 *
 * `status <dir>` routes through `syncTree({plan:true})`, so its rows describe
 * PROSPECTIVE would-change ops (a diff), not past-tense per-file drift — the
 * wording reflects that.
 *
 * @module
 */

import type { ProblemItem } from '@overeng/tui-react'

import type { BatchResult } from '../../batch.ts'
import type { StatusResult } from '../../sync.ts'
import type { TreeOp, TreeSyncResult } from '../../tree.ts'
import type { StatusResultPayload } from './schema.ts'

/** Any shape a `status` handler can hand to the view normalizer. */
export type StatusEngineResult = StatusResult | TreeSyncResult | BatchResult<StatusResult>

/** A detail section (the kit's shape; re-declared structurally to avoid the import churn). */
type Section = StatusResultPayload['sections'][number]

const MORE_THRESHOLD = 5

/** Build a truncating section: cap items at 5, surface the remainder as `+ N more`. */
const section = ({
  title,
  items,
}: {
  readonly title: string
  readonly items: readonly string[]
}): Section => ({
  title,
  items: items.slice(0, MORE_THRESHOLD),
  ...(items.length > MORE_THRESHOLD ? { more: items.length - MORE_THRESHOLD } : {}),
})

/**
 * Group unresolved unknown-block type names into `<kind> <count>` rows (sorted by
 * kind). `unresolvedUnknownBlocks` carries one entry per block INSTANCE, so the
 * same type can repeat; rendering raw instances would both duplicate rows and
 * collide React keys. The count carries the multiplicity the dedup would lose.
 */
const unknownBlockRows = (blocks: readonly string[]): readonly string[] => {
  const counts = new Map<string, number>()
  for (const block of blocks) counts.set(block, (counts.get(block) ?? 0) + 1)
  return [...counts.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([kind, n]) => `${kind} ${n}`)
}

// =============================================================================
// Single file (StatusResult)
// =============================================================================

/** Whether a single-file status carries any local-or-remote change. */
const isDirty = (status: StatusResult): boolean =>
  status.localChanged === true ||
  status.localPageMetadataChanged === true ||
  status.localPropertiesChanged === true ||
  status.remoteChanged === true

/** Map a single-file {@link StatusResult} into the view payload. */
const fileResult = (status: StatusResult): StatusResultPayload => {
  const blocks = status.unresolvedUnknownBlocks
  const problems: ProblemItem[] = []

  if (status.remoteChanged === true) {
    problems.push({
      severity: 'warning',
      name: status.path,
      status: 'remote-changed',
      details: 'the remote page changed since the last clean pull',
      fixes: [`notion-md sync ${status.path} to reconcile local and remote`],
    })
  }

  if (blocks.length > 0) {
    const kinds = [...new Set(blocks)].toSorted()
    problems.push({
      severity: 'warning',
      name: status.path,
      status: 'guarded',
      details: `page has ${blocks.length} unsupported Notion block${
        blocks.length === 1 ? '' : 's'
      } a body write could delete: ${kinds.join(', ')}`,
      context: 'unsupported blocks are preserved in .notion-md object refs',
      fixes: ['pull the latest page state, or model the unsupported blocks before writing'],
      skips: [`notion-md sync ${status.path} --allow-delete-unknown-blocks`],
    })
  }

  const stateItems = [
    `body ${status.localChanged === true ? 'changed' : 'clean'}`,
    `frontmatter ${status.localPageMetadataChanged === true ? 'changed' : 'clean'}`,
    `properties ${status.localPropertiesChanged === true ? 'changed' : 'clean'}`,
    `remote ${status.remoteChanged === true ? 'changed' : 'clean'}`,
    `unknown blocks ${blocks.length}`,
  ]

  const sections: Section[] = [section({ title: 'state', items: stateItems })]
  if (blocks.length > 0) {
    sections.push(section({ title: 'unknown-blocks', items: unknownBlockRows(blocks) }))
  }

  const summary = [
    '1 file',
    isDirty(status) === true ? 'drift' : 'in sync',
    ...(blocks.length > 0 ? [`${blocks.length} unresolved blocks`] : []),
  ]

  return { sections, problems, summary }
}

// =============================================================================
// Directory tree (TreeSyncResult, plan:true)
// =============================================================================

/** Human label for a would-change tree op. */
const treeOpLabel = (op: TreeOp): string => {
  switch (op._tag) {
    case 'create':
      return 'create'
    case 'update':
      return 'update'
    case 'move':
      return 'move'
    case 'materialize':
      return 'materialize'
    case 'trash':
      return 'trash'
    case 'trash_blocked':
      return 'blocked'
    case 'conflict':
      return 'conflict'
    case 'noop':
      return 'in sync'
  }
}

/** A would-change op is a problem when it cannot proceed cleanly. */
const treeOpProblem = (op: TreeOp): ProblemItem | undefined => {
  switch (op._tag) {
    case 'conflict':
      return {
        severity: 'warning',
        name: op.relPath,
        status: 'conflict',
        details: 'local and remote both changed — a sync would not push this page',
        fixes: [`notion-md status ${op.relPath} to inspect the divergence`],
      }
    case 'trash_blocked':
      return {
        severity: 'warning',
        name: op.relPath,
        status: 'trash-blocked',
        details: 'page was removed locally but the remote trash is blocked',
        fixes: ['resolve the remote page state, then re-run plan/sync'],
      }
    default:
      return undefined
  }
}

/** Count tree ops by their display label, in op-emission order. */
const treeSummary = (ops: readonly TreeOp[]): readonly string[] => {
  const counts = new Map<string, number>()
  for (const op of ops) {
    const label = treeOpLabel(op)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const parts = [...counts.entries()].map(([label, n]) => `${n} ${label}`)
  return [`${ops.length} page${ops.length === 1 ? '' : 's'}`, ...parts]
}

/** Map a directory-tree status (`syncTree({plan:true})`) into the view payload. */
const treeResult = (result: TreeSyncResult): StatusResultPayload => {
  const rows = result.ops.map((op) => `${op.relPath}  ${treeOpLabel(op)}`)
  const problems = result.ops
    .map(treeOpProblem)
    .filter((problem): problem is ProblemItem => problem !== undefined)
  return {
    sections: rows.length > 0 ? [section({ title: 'pages', items: rows })] : [],
    problems,
    summary: treeSummary(result.ops),
  }
}

// =============================================================================
// Flat recursive batch (BatchResult<StatusResult>)
// =============================================================================

/** Map a flat recursive batch into the view payload (one row per file). */
const batchResult = (result: BatchResult<StatusResult>): StatusResultPayload => {
  const rows: string[] = []
  const problems: ProblemItem[] = []

  for (const item of result.items) {
    if (item._tag === 'error') {
      rows.push(`${item.path}  error`)
      problems.push({
        severity: 'warning',
        name: item.path,
        status: 'error',
        details: 'status check failed for this file',
        fixes: [`notion-md status ${item.path} to see the underlying error`],
      })
      continue
    }
    const status = item.result
    const blocks = status.unresolvedUnknownBlocks
    const label =
      blocks.length > 0
        ? 'guarded'
        : isDirty(status) === true
          ? status.remoteChanged === true
            ? 'remote changed'
            : 'local changed'
          : 'in sync'
    rows.push(`${item.path}  ${label}`)
    if (status.remoteChanged === true) {
      problems.push({
        severity: 'warning',
        name: item.path,
        status: 'remote-changed',
        details: 'the remote page changed since the last clean pull',
        fixes: [`notion-md sync ${item.path} to reconcile local and remote`],
      })
    }
    if (blocks.length > 0) {
      const kinds = [...new Set(blocks)].toSorted()
      problems.push({
        severity: 'warning',
        name: item.path,
        status: 'guarded',
        details: `${blocks.length} unsupported block${
          blocks.length === 1 ? '' : 's'
        } a body write could delete: ${kinds.join(', ')}`,
        skips: [`notion-md sync ${item.path} --allow-delete-unknown-blocks`],
        fixes: ['pull the latest page state, or model the unsupported blocks before writing'],
      })
    }
  }

  return {
    sections: rows.length > 0 ? [section({ title: 'files', items: rows })] : [],
    problems,
    summary: [
      `${result.total} file${result.total === 1 ? '' : 's'}`,
      ...(result.failed > 0 ? [`${result.failed} failed`] : []),
    ],
  }
}

// =============================================================================
// Dispatch
// =============================================================================

/** True when the value is the engine `TreeSyncResult` envelope. */
const isTree = (result: StatusEngineResult): result is TreeSyncResult =>
  '_tag' in result && result._tag === 'tree'

/** True when the value is the engine `BatchResult` envelope. */
const isBatch = (result: StatusEngineResult): result is BatchResult<StatusResult> =>
  '_tag' in result && result._tag === 'batch'

/** Normalize any `status` engine result into the precomputed view payload. */
export const statusResultPayload = (result: StatusEngineResult): StatusResultPayload => {
  if (isTree(result) === true) return treeResult(result)
  if (isBatch(result) === true) return batchResult(result)
  return fileResult(result)
}
