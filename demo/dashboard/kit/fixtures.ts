/**
 * fixtures.ts — the single synthetic dataset for ALL explainers (axis D).
 *
 * SYNTHETIC ONLY. This is the one audited chokepoint enforcing CLAUDE.md's
 * "never commit private-repo data": every explainer projects a VIEW of the
 * data here; nothing is pulled from a real workspace.
 *
 * The option sets are ALIGNED to the canonical schema source of truth,
 * `demo/schema-iac/stage/tasks.notiondb.ts`:
 *   Status:   ['Todo', 'In Progress', 'Done']
 *   Priority: ['High', 'Medium', 'Low']   (colors: red / yellow / gray)
 * (The live hand-authored notion-sqlite.html used an ad-hoc "Urgent" for one
 *  row; the fixture normalizes it to the real `Priority` option set.)
 */

export type StatusName = 'Todo' | 'In Progress' | 'Done'
export type PriorityName = 'High' | 'Medium' | 'Low'

export const STATUS_OPTIONS = ['Todo', 'In Progress', 'Done'] as const satisfies readonly StatusName[]
export const PRIORITY_OPTIONS = ['High', 'Medium', 'Low'] as const satisfies readonly PriorityName[]

export interface Task {
  readonly name: string
  readonly status: StatusName
  readonly priority: PriorityName
  readonly team: string
}

/** The recurring "Tasks" rows — the local SQLite view (what `notion db track` pulls). */
export const TASKS = [
  { name: 'Fix flaky deploy pipeline', status: 'In Progress', priority: 'High', team: 'Platform' },
  { name: 'Ship onboarding revamp', status: 'Done', priority: 'Medium', team: 'Growth' },
  { name: 'Draft Q3 roadmap', status: 'Todo', priority: 'High', team: 'Product' },
  { name: 'Migrate auth service', status: 'In Progress', priority: 'High', team: 'Platform' },
  { name: 'Write incident postmortem', status: 'Todo', priority: 'Low', team: 'Platform' },
] as const satisfies readonly Task[]

/** The one row every "edit → sync" story mutates (In Progress → Done). */
export const EDITED_TASK = TASKS[0]

/** Stable labels reused across surfaces (page/db/workspace chrome). */
export const LABELS = {
  workspace: 'Acme',
  workspaceInitial: 'A',
  dbName: 'Tasks',
  dbEmoji: '✅',
  sqliteFile: 'a1b2c3d4.sqlite',
  notionMiniGridTitle: 'Launch Tasks',
} as const

/** Priority → Notion pill class suffix (`.pill-hi` / `.pill-md`; Low has no pill in the mini view). */
export const PRIORITY_PILL: Record<PriorityName, { cls: string; label: string }> = {
  High: { cls: 'pill-hi', label: 'High' },
  Medium: { cls: 'pill-md', label: 'Med' },
  Low: { cls: 'pill-md', label: 'Low' },
}

/**
 * Mock terminal output for the sqlite "edit a row with SQL" story.
 * Kept here so the SQL, the grid, and the confirmation never drift apart.
 */
export const SQLITE_STORY = {
  updateSet: `"Status"='Done'`,
  whereName: EDITED_TASK.name,
  rowsUpdated: '-- 1 row updated',
  syncCmd: 'notion db sync',
  pushing: '⟳ pushing 1 change…',
  applied: '1 change applied & verified in Notion',
} as const

/**
 * roadmap.nmd fixture (for the notion-md port). Mirrors `demo/md/stage/roadmap.nmd`
 * in spirit; kept synthetic + minimal here. Extend when md is ported (Phase 3).
 */
export const ROADMAP_NMD = `---
source: local
---

# Q3 Roadmap

## Pricing
Enterprise tier — $30 / seat
`
