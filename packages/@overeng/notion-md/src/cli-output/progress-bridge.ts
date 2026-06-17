import { Effect, Layer } from 'effect'

import { ProgressReporter, type ProgressReporterShape } from '../progress.ts'
import type { EditAction } from './edit/schema.ts'

/**
 * Bridge the engine's render seam (`ProgressReporter`, R45) onto a TUI app's
 * `dispatch`: each staged transition becomes an `EditAction` the `edit` reducer
 * folds into the visible state, replacing the old direct-to-stderr line renderer.
 *
 * The Layer closes over the `run` handler's `tui.dispatch`, so the engine stays
 * render-agnostic (it only sees the `ProgressReporter` Tag) and the OutputMode
 * seam decides how the resulting state is shown (TTY/CI/log/json). Every method
 * is a pure `Effect.sync` over `dispatch`; the `emit` helper in `progress.ts`
 * already swallows any failure/defect, so a dispatch glitch can never change the
 * `EditResult` or exit code (R45).
 */
export const progressReporterTui = (
  dispatch: (action: EditAction) => void,
): Layer.Layer<ProgressReporter> =>
  Layer.succeed(ProgressReporter, {
    stageActive: (stage) =>
      Effect.sync(() => dispatch({ _tag: 'StageActive', id: stage.id, label: stage.label })),
    stageSucceed: (stage) =>
      Effect.sync(() =>
        dispatch({
          _tag: 'StageSucceed',
          id: stage.id,
          label: stage.label,
          ...(stage.message === undefined ? {} : { message: stage.message }),
        }),
      ),
    stageSkip: (stage) =>
      Effect.sync(() => dispatch({ _tag: 'StageSkip', id: stage.id, label: stage.label })),
    stageFail: (stage) =>
      Effect.sync(() => dispatch({ _tag: 'StageFail', id: stage.id, label: stage.label })),
    note: (message) => Effect.sync(() => dispatch({ _tag: 'Note', message })),
  } satisfies ProgressReporterShape)
