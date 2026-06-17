/**
 * Map the engine's `plan` result (`TreeSyncResult`) into the precomputed
 * {@link PlanResultPayload} the view renders (`sections` / `problems` /
 * `summary`).
 *
 * `planPath` is directory-tree only (file targets are rejected pre-flight), so a
 * `plan` always carries a `TreeSyncResult` of would-change ops. The view groups
 * the ops by op-kind — one `DetailSection` per `create` / `update` / `move` /
 * `trash` / `materialize` / `noop` — so the diff reads as `create(N): …`. A
 * `trash_blocked` op is a WARNING (cannot trash); a `conflict` op is a CRITICAL
 * problem (a sync would refuse it). The summary is the op counts.
 *
 * @module
 */

import type { ProblemItem } from '@overeng/tui-react'

import type { TreeOp, TreeSyncResult } from '../../tree.ts'
import type { PlanResultPayload } from './schema.ts'

/** A detail section (the kit's shape). */
type Section = PlanResultPayload['sections'][number]

const MORE_THRESHOLD = 5

/** Op-kinds shown as grouped sections, in display order. */
const GROUP_ORDER: readonly TreeOp['_tag'][] = [
  'create',
  'update',
  'move',
  'materialize',
  'trash',
  'trash_blocked',
  'conflict',
  'noop',
]

/** Human section title for an op-kind. */
const groupTitle = (tag: TreeOp['_tag']): string =>
  tag === 'trash_blocked' ? 'trash-blocked' : tag

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

/** A blocked/conflicting op surfaces as a problem (everything else is a clean op). */
const opProblem = (op: TreeOp): ProblemItem | undefined => {
  switch (op._tag) {
    case 'conflict':
      return {
        severity: 'critical',
        name: op.relPath,
        status: 'conflict',
        details: 'local and remote both changed — a sync would refuse this page',
        fixes: [`notion-md status ${op.relPath} to inspect the divergence`],
      }
    case 'trash_blocked':
      return {
        severity: 'warning',
        name: op.relPath,
        status: 'trash-blocked',
        details: 'page was removed locally but the remote trash is blocked',
        fixes: ['resolve the remote page state, then re-run plan'],
      }
    default:
      return undefined
  }
}

/** Group ops by `_tag` into one truncating section per op-kind (display order). */
const groupedSections = (ops: readonly TreeOp[]): readonly Section[] => {
  const byTag = new Map<TreeOp['_tag'], string[]>()
  for (const op of ops) {
    const rows = byTag.get(op._tag) ?? []
    rows.push(op.relPath)
    byTag.set(op._tag, rows)
  }
  return GROUP_ORDER.filter((tag) => (byTag.get(tag)?.length ?? 0) > 0).map((tag) =>
    section({ title: groupTitle(tag), items: byTag.get(tag) ?? [] }),
  )
}

/** Op counts as the dimmed `·`-joined summary line (`N ops · X create · …`). */
const summary = (ops: readonly TreeOp[]): readonly string[] => {
  const counts = new Map<TreeOp['_tag'], number>()
  for (const op of ops) counts.set(op._tag, (counts.get(op._tag) ?? 0) + 1)
  const parts = GROUP_ORDER.filter((tag) => (counts.get(tag) ?? 0) > 0).map(
    (tag) => `${counts.get(tag) ?? 0} ${groupTitle(tag)}`,
  )
  return [`${ops.length} op${ops.length === 1 ? '' : 's'}`, ...parts]
}

/** Normalize a `plan` engine result into the precomputed view payload. */
export const planResultPayload = (result: TreeSyncResult): PlanResultPayload => ({
  sections: groupedSections(result.ops),
  problems: result.ops
    .map(opProblem)
    .filter((problem): problem is ProblemItem => problem !== undefined),
  summary: summary(result.ops),
})
