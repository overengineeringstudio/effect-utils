/**
 * State/action/reducer for the read-only `plan` command's output (the
 * `/sk-cli-design` `app/schema/view` triple).
 *
 * Like `status`, `plan` is **stage-less**: it dry-runs a directory-tree reconcile
 * and prints the create/update/move/trash/noop diff — no staged write progress,
 * no `ProgressReporter` bridge, no exit-code dance. The state is a THIN
 * `Success{sections, problems, summary} | Error{message}` shape; the handler
 * computes the payload from the engine's `TreeSyncResult` (see `map.ts`) and
 * dispatches a single `SetResult`. Failures propagate UNCAUGHT (the `runMain`
 * teardown owns the real exit code).
 *
 * @module
 */

import { Schema } from 'effect'

import { DetailSection, ProblemItem } from '@overeng/tui-react'

/**
 * `plan` UI state. The initial state is an empty `Success` (the view renders just
 * the context header until the engine's `SetResult` lands — the intended
 * transient, mirroring sync's empty-target placeholder).
 */
export const PlanState = Schema.Union(
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
export type PlanState = typeof PlanState.Type

/** Precomputed result payload (the `map.ts` projection of the `TreeSyncResult`). */
export const PlanResultPayload = Schema.Struct({
  sections: Schema.Array(DetailSection),
  problems: Schema.Array(ProblemItem),
  summary: Schema.Array(Schema.String),
})
export type PlanResultPayload = typeof PlanResultPayload.Type

/** Actions the `plan` program dispatches (seed target, then a terminal action). */
export const PlanAction = Schema.Union(
  /** Seed the real target (the cached app starts with an empty placeholder). */
  Schema.TaggedStruct('SetTarget', { target: Schema.String }),
  Schema.TaggedStruct('SetResult', { result: PlanResultPayload }),
  Schema.TaggedStruct('SetError', { message: Schema.String }),
)
export type PlanAction = typeof PlanAction.Type

/** Initial state for a `plan <target>` run (before the diff lands). */
export const initialPlanState = (target: string): PlanState => ({
  _tag: 'Success',
  target,
  sections: [],
  problems: [],
  summary: [],
})

/** Fold a {@link PlanAction} onto the current {@link PlanState}. */
export const planReducer = ({
  state,
  action,
}: {
  state: PlanState
  action: PlanAction
}): PlanState => {
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
 * In-app exit-code view of the terminal state. `plan` is a read-only dry run: a
 * diff (even one with blocked/conflict ops) is exit 0 (reported problems, not a
 * process failure); only a caught hard failure is exit 1. The real exit code is
 * owned by the `runMain` teardown — this mirrors it for headless JSON consumers.
 */
export const planExitCode = (state: PlanState): number => (state._tag === 'Success' ? 0 : 1)
