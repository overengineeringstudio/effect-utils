/**
 * State/action/reducer for the `edit` command's output (the `/sk-cli-design`
 * `app/schema/view` triple, mirroring notion-cli's DiffOutput).
 *
 * The engine emits staged progress through the `ProgressReporter` seam; the
 * `progress-bridge` Layer turns each transition into an {@link EditAction}, and
 * this reducer folds them onto a visible {@link EditState} the {@link view}
 * renders through the active OutputMode. The terminal tag (`Success` /
 * `Conflict` / `Error`) is set from the engine's `EditResult` (`SetResult`) or a
 * caught failure (`SetError`).
 *
 * @module
 */

import { Schema } from 'effect'

import { ProblemItem, TaskItemSchema } from '@overeng/tui-react'

/** Engine stage ids (kept in sync with `ProgressStageId` in `progress.ts`). */
const StageId = Schema.Literal('observe', 'write-body', 'write-title', 'settle')

/**
 * `edit` UI state. `Running` accumulates the live stages + any warnings until a
 * terminal `SetResult`/`SetError` arrives; the terminal tags carry the stages so
 * the final render still shows the (now-settled) stage list.
 */
export const EditState = Schema.Union(
  Schema.TaggedStruct('Running', {
    page: Schema.String,
    stages: Schema.Array(TaskItemSchema),
    warnings: Schema.Array(ProblemItem),
  }),
  Schema.TaggedStruct('Success', {
    page: Schema.String,
    stages: Schema.Array(TaskItemSchema),
    warnings: Schema.Array(ProblemItem),
    /** `true` when the editor buffer was unchanged (a no-op push). */
    noChange: Schema.Boolean,
    titleWritten: Schema.optional(Schema.Boolean),
  }),
  Schema.TaggedStruct('Conflict', {
    page: Schema.String,
    stages: Schema.Array(TaskItemSchema),
    warnings: Schema.Array(ProblemItem),
    /** Durable `<page>.conflict.md` the engine relocated the rough draft to. */
    conflictPath: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('Error', {
    page: Schema.String,
    stages: Schema.Array(TaskItemSchema),
    warnings: Schema.Array(ProblemItem),
    message: Schema.String,
  }),
)
export type EditState = typeof EditState.Type

/**
 * Engine `EditResult` projected into the action schema (the CLI's
 * `editEditorPage` return shape, JSON-encodable for the seam).
 */
const EditResultPayload = Schema.Struct({
  outcome: Schema.Literal('pushed', 'noop', 'conflict'),
  conflictPath: Schema.optional(Schema.String),
  /** Surfaced only when known; drives the summary line's `+ title` hint. */
  titleWritten: Schema.optional(Schema.Boolean),
})

/** Actions the `edit` program dispatches (stage transitions, notes, terminal). */
export const EditAction = Schema.Union(
  Schema.TaggedStruct('StageActive', { id: StageId, label: Schema.String }),
  Schema.TaggedStruct('StageSucceed', {
    id: StageId,
    label: Schema.String,
    message: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('StageSkip', { id: StageId, label: Schema.String }),
  Schema.TaggedStruct('StageFail', { id: StageId, label: Schema.String }),
  Schema.TaggedStruct('Note', { message: Schema.String }),
  Schema.TaggedStruct('SetResult', { result: EditResultPayload }),
  Schema.TaggedStruct('SetError', { message: Schema.String }),
)
export type EditAction = typeof EditAction.Type

/** Initial state for an `edit <page>` run (before the first stage transition). */
export const initialEditState = (page: string): EditState => ({
  _tag: 'Running',
  page,
  stages: [],
  warnings: [],
})

/**
 * Map an engine progress note to a WARNING {@link ProblemItem} with an actionable
 * `fix:`. The conflict note names the durable `<page>.conflict.md`; the
 * auto-merge note just reports that the push absorbed an upstream change.
 */
const noteToProblem = (message: string): ProblemItem => {
  const conflictMatch = message.match(/conflict draft to (\S+?)(?:;|$)/u)
  if (conflictMatch !== null) {
    const path = conflictMatch[1] ?? '<page>.conflict.md'
    return {
      severity: 'warning',
      name: path,
      status: 'conflict',
      details: 'remote changed and overlaps your edit — nothing pushed',
      fixes: [`open ${path} to resolve, then re-run \`notion-md edit\``],
    }
  }
  return {
    severity: 'warning',
    name: 'auto-merge',
    status: 'merged',
    details: message,
    fixes: ['cat the page to confirm the merged result before further edits'],
  }
}

/**
 * Upsert a stage by id into the `TaskItem[]` (stage transitions arrive
 * `active → succeed/skip/fail`, so a later transition replaces the earlier one).
 * Append when first seen to preserve the engine's emission order.
 */
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

/** One stage row (the `TaskItem` inferred type the kit's `StageList` consumes). */
type StageItem = typeof TaskItemSchema.Type

/** Fold an {@link EditAction} onto the current {@link EditState}. */
export const editReducer = ({
  state,
  action,
}: {
  state: EditState
  action: EditAction
}): EditState => {
  switch (action._tag) {
    case 'StageActive':
      return {
        ...state,
        stages: upsertStage({
          stages: state.stages,
          next: {
            id: action.id,
            label: action.label,
            status: 'active',
          },
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
          next: {
            id: action.id,
            label: action.label,
            status: 'skipped',
          },
        }),
      }
    case 'StageFail':
      return {
        ...state,
        stages: upsertStage({
          stages: state.stages,
          next: {
            id: action.id,
            label: action.label,
            status: 'error',
          },
        }),
      }
    case 'Note':
      return { ...state, warnings: [...state.warnings, noteToProblem(action.message)] }
    case 'SetResult': {
      const base = { page: state.page, stages: state.stages, warnings: state.warnings } as const
      if (action.result.outcome === 'conflict') {
        return {
          _tag: 'Conflict',
          ...base,
          ...(action.result.conflictPath === undefined
            ? {}
            : { conflictPath: action.result.conflictPath }),
        }
      }
      return {
        _tag: 'Success',
        ...base,
        noChange: action.result.outcome === 'noop',
        ...(action.result.titleWritten === undefined
          ? {}
          : { titleWritten: action.result.titleWritten }),
      }
    }
    case 'SetError':
      return {
        _tag: 'Error',
        page: state.page,
        stages: state.stages,
        warnings: state.warnings,
        message: action.message,
      }
  }
}

/**
 * In-app exit-code view of the terminal state. This is the TUI app's notion of
 * the result, NOT a second process-exit path: the real exit code is owned by the
 * `runMain` teardown (`editorExitCode`, exit-codes.ts), which maps the engine's
 * `Exit`. The engine catches the conflict and returns a *success* `EditResult`
 * for `edit`, so a conflict process-exits 0 today; this mapper mirrors that
 * (only the engine's actual `Error` failure → 1) to avoid diverging from / double
 * mapping against the teardown.
 */
export const editExitCode = (state: EditState): number => (state._tag === 'Error' ? 1 : 0)
