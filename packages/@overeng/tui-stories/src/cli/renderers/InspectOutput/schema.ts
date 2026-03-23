/** State and actions for the `tui-stories inspect` command output */

import { Schema } from 'effect'

const ArgInfo = Schema.Struct({
  name: Schema.String,
  controlType: Schema.String,
  description: Schema.optional(Schema.String),
  defaultValue: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Schema.String)),
  conditional: Schema.optional(Schema.String),
})

/** Schema for the `tui-stories inspect` output state */
export const InspectState = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  name: Schema.String,
  filePath: Schema.String,
  args: Schema.Array(ArgInfo),
  hasTimeline: Schema.Boolean,
  timelineEventCount: Schema.Number,
})

export type InspectStateType = typeof InspectState.Type

/** Actions dispatched to update inspect output state */
export const InspectAction = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal('SetState'), state: InspectState }),
)

export type InspectActionType = typeof InspectAction.Type

/** Reducer for inspect output state transitions */
export const inspectReducer = ({
  action,
}: {
  state: InspectStateType
  action: InspectActionType
}): InspectStateType => {
  switch (action._tag) {
    case 'SetState':
      return action.state
  }
}
