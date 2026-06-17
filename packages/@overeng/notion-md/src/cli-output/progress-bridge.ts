import { Effect, Layer } from 'effect'

import { ProgressReporter, type ProgressReporterShape, type ProgressStageId } from '../progress.ts'

/**
 * The stage/note action subset every command reducer (`edit` / `put` / `sync`)
 * understands. The bridge only ever dispatches these tags; the terminal
 * `SetResult`/`SetError`/… tags are dispatched directly by each command handler,
 * so the bridge stays command-agnostic.
 */
export type ProgressAction =
  | { readonly _tag: 'StageActive'; readonly id: ProgressStageId; readonly label: string }
  | {
      readonly _tag: 'StageSucceed'
      readonly id: ProgressStageId
      readonly label: string
      readonly message?: string
    }
  | { readonly _tag: 'StageSkip'; readonly id: ProgressStageId; readonly label: string }
  | { readonly _tag: 'StageFail'; readonly id: ProgressStageId; readonly label: string }
  | { readonly _tag: 'Note'; readonly message: string }

/**
 * Bridge the engine's render seam (`ProgressReporter`, R45) onto a TUI app's
 * `dispatch`: each staged transition becomes a {@link ProgressAction} the command
 * reducer folds into the visible state, replacing the old direct-to-stderr line
 * renderer.
 *
 * The Layer closes over the `run` handler's `tui.dispatch`, so the engine stays
 * render-agnostic (it only sees the `ProgressReporter` Tag) and the OutputMode
 * seam decides how the resulting state is shown (TTY/CI/log/json). Every method
 * is a pure `Effect.sync` over `dispatch`; the `emit` helper in `progress.ts`
 * already swallows any failure/defect, so a dispatch glitch can never change the
 * result or exit code (R45).
 *
 * Generic over the action type so the same bridge drives `edit`, `put`, and
 * `sync` — each reducer accepts the shared {@link ProgressAction} subset.
 */
export const progressReporterTui = <A extends ProgressAction>(
  dispatch: (action: A) => void,
): Layer.Layer<ProgressReporter> =>
  Layer.succeed(ProgressReporter, {
    stageActive: (stage) =>
      Effect.sync(() => dispatch({ _tag: 'StageActive', id: stage.id, label: stage.label } as A)),
    stageSucceed: (stage) =>
      Effect.sync(() =>
        dispatch({
          _tag: 'StageSucceed',
          id: stage.id,
          label: stage.label,
          ...(stage.message === undefined ? {} : { message: stage.message }),
        } as A),
      ),
    stageSkip: (stage) =>
      Effect.sync(() => dispatch({ _tag: 'StageSkip', id: stage.id, label: stage.label } as A)),
    stageFail: (stage) =>
      Effect.sync(() => dispatch({ _tag: 'StageFail', id: stage.id, label: stage.label } as A)),
    note: (message) => Effect.sync(() => dispatch({ _tag: 'Note', message } as A)),
  } satisfies ProgressReporterShape)
