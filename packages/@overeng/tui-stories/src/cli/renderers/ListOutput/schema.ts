/** State and actions for the `tui-stories list` command output */

import { Schema } from 'effect'

const StoryEntry = Schema.Struct({
  name: Schema.String,
  hasTimeline: Schema.Boolean,
  argCount: Schema.Number,
})

const StoryGroup = Schema.Struct({
  title: Schema.String,
  stories: Schema.Array(StoryEntry),
})

/** Schema for the `tui-stories list` output state */
export const ListState = Schema.Struct({
  groups: Schema.Array(StoryGroup),
  skippedCount: Schema.Number,
  packagePath: Schema.String,
})

export type ListStateType = typeof ListState.Type

/** Actions dispatched to update list output state */
export const ListAction = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal('SetState'), state: ListState }),
)

export type ListActionType = typeof ListAction.Type

/** Reducer for list output state transitions */
export const listReducer = ({
  action,
}: {
  state: ListStateType
  action: ListActionType
}): ListStateType => {
  switch (action._tag) {
    case 'SetState':
      return action.state
  }
}
