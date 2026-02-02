/**
 * Hello World - State and Action Schemas
 */

import { Schema } from 'effect'

// =============================================================================
// State Schema
// =============================================================================

/** Schema for the active display state with a countdown timer. */
export const DisplayingState = Schema.TaggedStruct('Displaying', {
  secondsRemaining: Schema.Number,
})

/** Schema for the finished state with a completion message. */
export const FinishedState = Schema.TaggedStruct('Finished', {
  message: Schema.String,
})

/** Schema for the interrupted state (user cancelled). */
export const InterruptedState = Schema.TaggedStruct('Interrupted', {})

/** Union schema of all hello world app states. */
export const AppState = Schema.Union(DisplayingState, FinishedState, InterruptedState)

/** Inferred type for the hello world app state union. */
export type AppState = Schema.Schema.Type<typeof AppState>

// =============================================================================
// Action Schema
// =============================================================================

/** Union schema of all hello world app actions (Tick, Finish, Interrupted). */
export const AppAction = Schema.Union(
  Schema.TaggedStruct('Tick', {}),
  Schema.TaggedStruct('Finish', {}),
  Schema.TaggedStruct('Interrupted', {}),
)

/** Inferred type for the hello world app action union. */
export type AppAction = Schema.Schema.Type<typeof AppAction>

// =============================================================================
// Reducer
// =============================================================================

/** Reducer that handles countdown ticks, finish, and interrupt actions. */
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
