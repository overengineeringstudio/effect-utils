/**
 * Hello World - State and Action Schemas
 */

import { Schema } from 'effect'

// =============================================================================
// State Schema
// =============================================================================

export const DisplayingState = Schema.TaggedStruct('Displaying', {
  secondsRemaining: Schema.Number,
})

export const FinishedState = Schema.TaggedStruct('Finished', {
  message: Schema.String,
})

export const InterruptedState = Schema.TaggedStruct('Interrupted', {})

export const AppState = Schema.Union(DisplayingState, FinishedState, InterruptedState)

export type AppState = Schema.Schema.Type<typeof AppState>

// =============================================================================
// Action Schema
// =============================================================================

export const AppAction = Schema.Union(
  Schema.TaggedStruct('Tick', {}),
  Schema.TaggedStruct('Finish', {}),
  Schema.TaggedStruct('Interrupted', {}),
)

export type AppAction = Schema.Schema.Type<typeof AppAction>

// =============================================================================
// Reducer
// =============================================================================

export const appReducer = ({ state, action }: { state: AppState; action: AppAction }): AppState => {
  switch (action._tag) {
    case 'Tick': {
      if (state._tag !== 'Displaying') return state
      return { ...state, secondsRemaining: state.secondsRemaining - 1 }
    }
    case 'Finish': {
      if (state._tag !== 'Displaying') return state
      return { _tag: 'Finished', message: 'Demo completed successfully!' }
    }
    case 'Interrupted': {
      if (state._tag !== 'Displaying') return state
      return { _tag: 'Interrupted' }
    }
  }
}
