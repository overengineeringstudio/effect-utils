/**
 * Counter Example - State and Action Schemas
 */

import { Schema } from 'effect'

// =============================================================================
// State Schema
// =============================================================================

export const RunningState = Schema.TaggedStruct('Running', {
  count: Schema.Number,
  status: Schema.Literal('idle', 'loading'),
  history: Schema.Array(Schema.String),
})

export const CompleteState = Schema.TaggedStruct('Complete', {
  finalCount: Schema.Number,
  history: Schema.Array(Schema.String),
})

export const InterruptedState = Schema.TaggedStruct('Interrupted', {
  count: Schema.Number,
  history: Schema.Array(Schema.String),
})

export const CounterState = Schema.Union(RunningState, CompleteState, InterruptedState)

export type CounterState = typeof CounterState.Type

// =============================================================================
// Action Schema
// =============================================================================

export const CounterAction = Schema.Union(
  Schema.TaggedStruct('Increment', {}),
  Schema.TaggedStruct('Decrement', {}),
  Schema.TaggedStruct('SetLoading', {}),
  Schema.TaggedStruct('SetComplete', { message: Schema.String }),
  Schema.TaggedStruct('Interrupted', {}),
)

export type CounterAction = typeof CounterAction.Type

// =============================================================================
// Reducer
// =============================================================================

const timestamp = () => new Date().toISOString().slice(11, 19)

export const counterReducer = ({
  state,
  action,
}: {
  state: CounterState
  action: CounterAction
}): CounterState => {
  const addHistory = (entry: string) => {
    const history = state._tag === 'Running' ? state.history : []
    return [...history.slice(-4), `[${timestamp()}] ${entry}`]
  }

  switch (action._tag) {
    case 'Increment': {
      if (state._tag !== 'Running') return state
      return {
        ...state,
        count: state.count + 1,
        status: 'idle',
        history: addHistory(`Incremented to ${state.count + 1}`),
      }
    }
    case 'Decrement': {
      if (state._tag !== 'Running') return state
      return {
        ...state,
        count: state.count - 1,
        status: 'idle',
        history: addHistory(`Decremented to ${state.count - 1}`),
      }
    }
    case 'SetLoading': {
      if (state._tag !== 'Running') return state
      return { ...state, status: 'loading' }
    }
    case 'SetComplete': {
      if (state._tag !== 'Running') return state
      return {
        _tag: 'Complete',
        finalCount: state.count,
        history: addHistory(action.message),
      }
    }
    case 'Interrupted': {
      if (state._tag !== 'Running') return state
      return {
        _tag: 'Interrupted',
        count: state.count,
        history: addHistory('Interrupted by user'),
      }
    }
  }
}
