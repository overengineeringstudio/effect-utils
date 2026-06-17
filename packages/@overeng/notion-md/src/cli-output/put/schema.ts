/**
 * State/action/reducer for the `put` command's output (the `/sk-cli-design`
 * `app/schema/view` triple, mirroring the `edit` triple).
 *
 * The engine emits staged progress through the `ProgressReporter` seam; the
 * `progress-bridge` Layer turns each transition into a {@link PutAction}, and
 * this reducer folds them onto a visible {@link PutState} the {@link PutView}
 * renders through the active OutputMode. The terminal tag (`Success` / `Partial`
 * / `Conflict` / `Error`) is set from the engine's `PutResult` (`SetResult`) or a
 * caught failure (`SetPartial` / `SetConflict` / `SetError`).
 *
 * `Partial` is the distinguishing state: a `put` can land the body write yet fail
 * the title write (`NmdPartialWriteError`, exit 10) — neither a clean success nor
 * a clean error. It renders the `write-title` row as `✗` plus a WARNING with an
 * actionable `fix:`.
 *
 * @module
 */

import { Schema } from 'effect'

import { ProblemItem, TaskItemSchema } from '@overeng/tui-react'

/** Engine stage ids the `put` write path emits (subset of `ProgressStageId`). */
const StageId = Schema.Literal('observe', 'write-body', 'write-title', 'settle')

/**
 * `put` UI state. `Running` accumulates the live stages + any warnings until a
 * terminal action arrives; the terminal tags carry the stages so the final
 * render still shows the (now-settled) stage list.
 */
export const PutState = Schema.Union(
  Schema.TaggedStruct('Running', {
    page: Schema.String,
    stages: Schema.Array(TaskItemSchema),
    warnings: Schema.Array(ProblemItem),
  }),
  Schema.TaggedStruct('Success', {
    page: Schema.String,
    stages: Schema.Array(TaskItemSchema),
    warnings: Schema.Array(ProblemItem),
    /** `true` when the title surface was also written (drives the `· title` hint). */
    titleWritten: Schema.Boolean,
    /** `true` when the write bypassed the concurrency guard (`--force`). */
    forced: Schema.Boolean,
    /** New base hash to capture for the next guarded `put`. */
    baseHash: Schema.String,
  }),
  Schema.TaggedStruct('Partial', {
    page: Schema.String,
    stages: Schema.Array(TaskItemSchema),
    warnings: Schema.Array(ProblemItem),
    /** Which surfaces landed (body typically `true`, title `false`). */
    bodyWritten: Schema.Boolean,
    titleWritten: Schema.Boolean,
  }),
  Schema.TaggedStruct('Conflict', {
    page: Schema.String,
    stages: Schema.Array(TaskItemSchema),
    warnings: Schema.Array(ProblemItem),
  }),
  Schema.TaggedStruct('Error', {
    page: Schema.String,
    stages: Schema.Array(TaskItemSchema),
    warnings: Schema.Array(ProblemItem),
    message: Schema.String,
  }),
)
export type PutState = typeof PutState.Type

/**
 * Engine `PutResult` projected into the action schema (the CLI's `putEditorPage`
 * return shape, JSON-encodable for the seam).
 */
const PutResultPayload = Schema.Struct({
  bodyWritten: Schema.Boolean,
  titleWritten: Schema.Boolean,
  forced: Schema.Boolean,
  baseHash: Schema.String,
})

/** Actions the `put` program dispatches (stage transitions, notes, terminal). */
export const PutAction = Schema.Union(
  Schema.TaggedStruct('StageActive', { id: StageId, label: Schema.String }),
  Schema.TaggedStruct('StageSucceed', {
    id: StageId,
    label: Schema.String,
    message: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('StageSkip', { id: StageId, label: Schema.String }),
  Schema.TaggedStruct('StageFail', { id: StageId, label: Schema.String }),
  Schema.TaggedStruct('Note', { message: Schema.String }),
  Schema.TaggedStruct('SetResult', { result: PutResultPayload }),
  Schema.TaggedStruct('SetPartial', {
    bodyWritten: Schema.Boolean,
    titleWritten: Schema.Boolean,
  }),
  Schema.TaggedStruct('SetConflict', { message: Schema.String }),
  Schema.TaggedStruct('SetError', { message: Schema.String }),
)
export type PutAction = typeof PutAction.Type

/** Initial state for a `put <page>` run (before the first stage transition). */
export const initialPutState = (page: string): PutState => ({
  _tag: 'Running',
  page,
  stages: [],
  warnings: [],
})

/** One stage row (the `TaskItem` inferred type the kit's `StageList` consumes). */
type StageItem = typeof TaskItemSchema.Type

/**
 * Upsert a stage by id into the `TaskItem[]` (transitions arrive
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

/**
 * Force the `write-title` row to `error` for the {@link PutState.Partial} render:
 * the engine fails the title write *after* the body lands, but the bridge may not
 * have seen a `StageFail` for it (the failure is mapped before the stage emit on
 * some paths), so the reducer pins it here to guarantee the `✗` row.
 */
const markTitleFailed = (stages: readonly StageItem[]): readonly StageItem[] =>
  upsertStage({
    stages,
    next: { id: 'write-title', label: 'write-title', status: 'error' },
  })

/** Fold a {@link PutAction} onto the current {@link PutState}. */
export const putReducer = ({ state, action }: { state: PutState; action: PutAction }): PutState => {
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
            fixes: ['cat the page to confirm the merged result before further writes'],
          },
        ],
      }
    case 'SetResult':
      return {
        _tag: 'Success',
        page: state.page,
        stages: state.stages,
        warnings: state.warnings,
        titleWritten: action.result.titleWritten,
        forced: action.result.forced,
        baseHash: action.result.baseHash,
      }
    case 'SetPartial':
      return {
        _tag: 'Partial',
        page: state.page,
        stages: markTitleFailed(state.stages),
        warnings: [
          ...state.warnings,
          {
            severity: 'warning',
            name: state.page,
            status: 'partial-write',
            details: 'body written but title write failed — the page has a stale base hash',
            fixes: [
              `notion-md cat ${state.page} to capture the new base hash`,
              `notion-md put ${state.page} --base-hash <new-hash from cat>`,
            ],
          },
        ],
        bodyWritten: action.bodyWritten,
        titleWritten: action.titleWritten,
      }
    case 'SetConflict':
      return {
        _tag: 'Conflict',
        page: state.page,
        stages: state.stages,
        warnings: [
          ...state.warnings,
          {
            severity: 'warning',
            name: state.page,
            status: 'conflict',
            details: action.message,
            fixes: [
              `notion-md cat ${state.page} to capture the current base hash, then re-run put`,
              `notion-md put ${state.page} --force to override the concurrency guard`,
            ],
          },
        ],
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
 * In-app exit-code view of the terminal state. This is NOT a second process-exit
 * path: the real exit code is owned by the `runMain` teardown (`editorExitCode`,
 * exit-codes.ts), which maps the engine's `Exit`. `put`'s engine errors propagate
 * UNCAUGHT, so the teardown maps `NmdConflictError`→7, `NmdPartialWriteError`→10,
 * `NmdPostPushGateError`→9, `NmdInvalidDocumentError`→5, others→1. This mapper
 * mirrors that contract for headless JSON consumers reading the state, so the two
 * never diverge.
 */
export const putExitCode = (state: PutState): number => {
  switch (state._tag) {
    case 'Running':
    case 'Success':
      return 0
    case 'Conflict':
      return 7
    case 'Partial':
      return 10
    case 'Error':
      return 1
  }
}
