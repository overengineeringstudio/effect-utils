/** State and actions for the `tui-stories render` command output */

import { Schema } from 'effect'

/**
 * Render output state — shows the rendered story content with context.
 *
 * Note: the command's own output mode (--output) is handled by outputModeLayer,
 * not tracked in this state. This state models the *content* being rendered.
 */
export const RenderState = Schema.Union(
  Schema.Struct({
    _tag: Schema.Literal('Rendering'),
    storyId: Schema.String,
    width: Schema.Number,
    timelineMode: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal('Complete'),
    storyId: Schema.String,
    width: Schema.Number,
    timelineMode: Schema.String,
    renderedLines: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.Literal('Error'),
    storyId: Schema.String,
    message: Schema.String,
  }),
)

export type RenderStateType = typeof RenderState.Type

/** Actions for the render output */
export const RenderAction = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal('SetState'), state: RenderState }),
)

export type RenderActionType = typeof RenderAction.Type

/** Reducer for render output state transitions */
export const renderReducer = ({
  action,
}: {
  state: RenderStateType
  action: RenderActionType
}): RenderStateType => {
  switch (action._tag) {
    case 'SetState':
      return action.state
  }
}
