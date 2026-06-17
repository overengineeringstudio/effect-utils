/**
 * State/action/reducer for the one-shot `sync` command's output (the
 * `/sk-cli-design` `app/schema/view` triple, mirroring `edit`/`put`).
 *
 * `sync` reconciles either a SINGLE `.nmd` file or a MULTI-page target (a
 * directory tree, or a flat recursive batch). These render differently:
 *
 * - **single page** — like `edit`: live stages (`observe`/`write-body`/…) + a
 *   single outcome. The bridge feeds the stage list directly.
 * - **multi page** — a per-page RESULT list (one row per page) plus a counts
 *   summary. Live stage interleaving is intentionally NOT rendered here: every
 *   page emits the same stage ids, so a shared live stage list would garble
 *   (the bridge keys stages by id). Rows come from the terminal engine result.
 *
 * The terminal tag (`Success` / `Conflict` / `Error`) is set from the engine's
 * normalized result (`SetSingle` / `SetPages`) or a caught failure (`SetError`).
 * The `--watch` path keeps its own ndjson renderer and never reaches this seam.
 *
 * @module
 */

import { Schema } from 'effect'

import { ProblemItem, TaskItemSchema } from '@overeng/tui-react'

/** Engine stage ids the single-page sync push path emits. */
const StageId = Schema.Literal('observe', 'write-body', 'write-title', 'settle')

/**
 * Normalized per-page outcome (one vocabulary spanning single `SyncResult`,
 * tree `TreeOp`, and batch `SyncResult`/failure). The engine surfaces three
 * different result shapes; the CLI handler maps each into this row so the view
 * stays simple.
 */
export const SyncPageOutcome = Schema.Literal(
  'pushed',
  'pulled',
  'noop',
  'created',
  'updated',
  'moved',
  'materialized',
  'trashed',
  'blocked',
  'conflict',
  'error',
)
export type SyncPageOutcome = typeof SyncPageOutcome.Type

/** One reconciled page in a multi-page sync. */
export const SyncPageRow = Schema.Struct({
  /** Page path (relPath for tree members, file path for batch). */
  path: Schema.String,
  outcome: SyncPageOutcome,
})
export type SyncPageRow = typeof SyncPageRow.Type

/**
 * `sync` UI state. `Running` accumulates live stages (single-page only) + any
 * warnings until a terminal action arrives. Terminal tags carry the (settled)
 * stages and/or the per-page rows so the final render is complete.
 */
export const SyncState = Schema.Union(
  Schema.TaggedStruct('Running', {
    target: Schema.String,
    stages: Schema.Array(TaskItemSchema),
    warnings: Schema.Array(ProblemItem),
  }),
  Schema.TaggedStruct('Success', {
    target: Schema.String,
    stages: Schema.Array(TaskItemSchema),
    warnings: Schema.Array(ProblemItem),
    /** Empty for single-page sync (the stages + summary carry the outcome). */
    pages: Schema.Array(SyncPageRow),
    /** `true` when the target is a multi-page tree/batch (drives per-page rows). */
    multi: Schema.Boolean,
  }),
  Schema.TaggedStruct('Conflict', {
    target: Schema.String,
    stages: Schema.Array(TaskItemSchema),
    warnings: Schema.Array(ProblemItem),
    pages: Schema.Array(SyncPageRow),
    multi: Schema.Boolean,
  }),
  Schema.TaggedStruct('Error', {
    target: Schema.String,
    stages: Schema.Array(TaskItemSchema),
    warnings: Schema.Array(ProblemItem),
    message: Schema.String,
  }),
)
export type SyncState = typeof SyncState.Type

/** Actions the `sync` program dispatches (stage transitions, notes, terminal). */
export const SyncAction = Schema.Union(
  Schema.TaggedStruct('StageActive', { id: StageId, label: Schema.String }),
  Schema.TaggedStruct('StageSucceed', {
    id: StageId,
    label: Schema.String,
    message: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('StageSkip', { id: StageId, label: Schema.String }),
  Schema.TaggedStruct('StageFail', { id: StageId, label: Schema.String }),
  Schema.TaggedStruct('Note', { message: Schema.String }),
  /** Seed the real target (the cached app starts with an empty placeholder). */
  Schema.TaggedStruct('SetTarget', { target: Schema.String }),
  /** A single-page outcome (keeps the live stages, sets the terminal tag). */
  Schema.TaggedStruct('SetSingle', { outcome: SyncPageOutcome }),
  /** A multi-page (tree/batch) outcome — the per-page result rows. */
  Schema.TaggedStruct('SetPages', { pages: Schema.Array(SyncPageRow) }),
  Schema.TaggedStruct('SetError', { message: Schema.String }),
)
export type SyncAction = typeof SyncAction.Type

/** Initial state for a `sync <target>` run (before the first transition). */
export const initialSyncState = (target: string): SyncState => ({
  _tag: 'Running',
  target,
  stages: [],
  warnings: [],
})

/** One stage row (the `TaskItem` inferred type the kit's `StageList` consumes). */
type StageItem = typeof TaskItemSchema.Type

/** Upsert a stage by id (later transitions replace earlier ones for that id). */
const upsertStage = ({
  stages,
  next,
}: {
  readonly stages: readonly StageItem[]
  readonly next: StageItem
}): readonly StageItem[] => {
  const index = stages.findIndex((stage) => stage.id === next.id)
  if (index === -1) return [...stages, next]
  return stages.map((stage, i) => (i === index ? next : stage))
}

/** True when any row is an unreconciled conflict — drives the `Conflict` tag. */
const hasConflict = (pages: readonly SyncPageRow[]): boolean =>
  pages.some((page) => page.outcome === 'conflict')

/** Fold a {@link SyncAction} onto the current {@link SyncState}. */
export const syncReducer = ({
  state,
  action,
}: {
  state: SyncState
  action: SyncAction
}): SyncState => {
  switch (action._tag) {
    case 'StageActive':
      return {
        ...state,
        stages: upsertStage({
          stages: state.stages,
          next: { id: action.id, label: action.label, status: 'active' },
        }),
      }
    case 'StageSucceed':
      return {
        ...state,
        stages: upsertStage({
          stages: state.stages,
          next: {
            id: action.id,
            label: action.label,
            status: 'success',
            ...(action.message === undefined ? {} : { message: action.message }),
          },
        }),
      }
    case 'StageSkip':
      return {
        ...state,
        stages: upsertStage({
          stages: state.stages,
          next: { id: action.id, label: action.label, status: 'skipped' },
        }),
      }
    case 'StageFail':
      return {
        ...state,
        stages: upsertStage({
          stages: state.stages,
          next: { id: action.id, label: action.label, status: 'error' },
        }),
      }
    case 'Note':
      return {
        ...state,
        warnings: [
          ...state.warnings,
          {
            severity: 'warning',
            name: 'auto-merge',
            status: 'merged',
            details: action.message,
            fixes: ['re-run `notion-md status` to confirm the merged result'],
          },
        ],
      }
    case 'SetTarget':
      return { ...state, target: action.target }
    case 'SetSingle': {
      const base = {
        target: state.target,
        stages: state.stages,
        warnings: state.warnings,
        pages: [] as readonly SyncPageRow[],
        multi: false,
      } as const
      if (action.outcome === 'conflict') {
        return {
          _tag: 'Conflict',
          ...base,
          warnings: [
            ...state.warnings,
            {
              severity: 'warning',
              name: state.target,
              status: 'conflict',
              details: 'local and remote both changed — nothing pushed',
              fixes: [
                `notion-md status ${state.target} to inspect the divergence`,
                `notion-md sync ${state.target} --force to overwrite remote`,
              ],
            },
          ],
        }
      }
      return { _tag: 'Success', ...base }
    }
    case 'SetPages': {
      const base = {
        target: state.target,
        stages: [] as readonly StageItem[],
        warnings: state.warnings,
        pages: action.pages,
        multi: true,
      } as const
      if (hasConflict(action.pages) === true) {
        const conflicted = action.pages.filter((page) => page.outcome === 'conflict')
        return {
          _tag: 'Conflict',
          ...base,
          warnings: [
            ...state.warnings,
            ...conflicted.map(
              (page): ProblemItem => ({
                severity: 'warning',
                name: page.path,
                status: 'conflict',
                details: 'local and remote both changed — nothing pushed for this page',
                fixes: [`notion-md status ${page.path} to inspect the divergence`],
              }),
            ),
          ],
        }
      }
      return { _tag: 'Success', ...base }
    }
    case 'SetError':
      return {
        _tag: 'Error',
        target: state.target,
        stages: state.stages,
        warnings: state.warnings,
        message: action.message,
      }
  }
}

/**
 * In-app exit-code view of the terminal state. The real exit code is owned by the
 * `runMain` teardown (`editorExitCode`); one-shot sync errors propagate UNCAUGHT.
 * A tree/batch conflict does NOT fail the engine (it is a reported per-page
 * outcome), so a multi-page conflict stays exit 0 — this mapper mirrors that.
 */
export const syncExitCode = (state: SyncState): number => {
  switch (state._tag) {
    case 'Running':
    case 'Success':
      return 0
    case 'Conflict':
      // A single-page conflict raises `NmdConflictError` (exit 7); a multi-page
      // conflict is a reported outcome (exit 0). Mirror the engine's failure shape.
      return state.multi === true ? 0 : 7
    case 'Error':
      return 1
  }
}
