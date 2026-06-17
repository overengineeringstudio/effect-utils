/**
 * State/action/reducer for the read-only `status` command's output (the
 * `/sk-cli-design` `app/schema/view` triple).
 *
 * Unlike the write commands (`edit`/`put`/`sync`), `status` is **stage-less**: it
 * reads local-vs-remote state and reports a result — there is no staged write
 * progress, no `ProgressReporter` bridge, and no exit-code dance. The state is a
 * THIN `Success{sections, problems, summary} | Error{message}` shape. The handler
 * computes the (precomputed) `sections`/`problems`/`summary` from the engine's
 * polymorphic result (see `map.ts`) and dispatches a single `SetResult`; the
 * reducer just swaps it in. Failures propagate UNCAUGHT (the `runMain` teardown
 * owns the real exit code); the in-app `Error` tag exists only so a caught view
 * action can render a message and so the headless JSON state is complete.
 *
 * @module
 */

import { Schema } from 'effect'

import { DetailSection, ProblemItem } from '@overeng/tui-react'

/**
 * `status` UI state. The initial state is an empty `Success` (the view renders
 * just the context header until the engine's `SetResult` lands — the intended
 * transient, mirroring sync's empty-target placeholder).
 */
export const StatusState = Schema.Union(
  Schema.TaggedStruct('Success', {
    target: Schema.String,
    sections: Schema.Array(DetailSection),
    problems: Schema.Array(ProblemItem),
    summary: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct('Error', {
    target: Schema.String,
    message: Schema.String,
  }),
)
export type StatusState = typeof StatusState.Type

/** Precomputed result payload (the `map.ts` projection of the engine result). */
export const StatusResultPayload = Schema.Struct({
  sections: Schema.Array(DetailSection),
  problems: Schema.Array(ProblemItem),
  summary: Schema.Array(Schema.String),
})
export type StatusResultPayload = typeof StatusResultPayload.Type

/** Actions the `status` program dispatches (seed target, then a terminal action). */
export const StatusAction = Schema.Union(
  /** Seed the real target (the cached app starts with an empty placeholder). */
  Schema.TaggedStruct('SetTarget', { target: Schema.String }),
  Schema.TaggedStruct('SetResult', { result: StatusResultPayload }),
  Schema.TaggedStruct('SetError', { message: Schema.String }),
)
export type StatusAction = typeof StatusAction.Type

/** Initial state for a `status <target>` run (before the result lands). */
export const initialStatusState = (target: string): StatusState => ({
  _tag: 'Success',
  target,
  sections: [],
  problems: [],
  summary: [],
})

/** Fold a {@link StatusAction} onto the current {@link StatusState}. */
export const statusReducer = ({
  state,
  action,
}: {
  state: StatusState
  action: StatusAction
}): StatusState => {
  switch (action._tag) {
    case 'SetTarget':
      return { ...state, target: action.target }
    case 'SetResult':
      return {
        _tag: 'Success',
        target: state.target,
        sections: action.result.sections,
        problems: action.result.problems,
        summary: action.result.summary,
      }
    case 'SetError':
      return { _tag: 'Error', target: state.target, message: action.message }
  }
}

/**
 * In-app exit-code view of the terminal state. `status` is read-only: a clean or
 * drifted/guarded result is exit 0 (reported problems, not a process failure);
 * only a caught hard failure is exit 1. The real exit code is owned by the
 * `runMain` teardown — this mirrors it for headless JSON consumers.
 */
export const statusExitCode = (state: StatusState): number => (state._tag === 'Success' ? 0 : 1)
