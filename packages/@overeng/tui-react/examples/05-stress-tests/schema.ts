/**
 * Rapid Updates Stress Test - State and Action Schemas
 */

import { Schema } from 'effect'

// =============================================================================
// State Schema
// =============================================================================

export const RunningState = Schema.Struct({
  _tag: Schema.Literal('Running'),
  frame: Schema.Number,
  startTime: Schema.Number,
  fps: Schema.Number,
  progress: Schema.Number,
})

export const FinishedState = Schema.Struct({
  _tag: Schema.Literal('Finished'),
  totalFrames: Schema.Number,
  averageFps: Schema.Number,
  duration: Schema.Number,
})

export const InterruptedState = Schema.Struct({
  _tag: Schema.Literal('Interrupted'),
  frame: Schema.Number,
  fps: Schema.Number,
  progress: Schema.Number,
})

export const StressTestState = Schema.Union(RunningState, FinishedState, InterruptedState)

export type StressTestState = Schema.Schema.Type<typeof StressTestState>

// =============================================================================
// Action Schema
// =============================================================================

export const StressTestAction = Schema.Union(
  Schema.TaggedStruct('Tick', {}),
  Schema.TaggedStruct('Finish', {}),
  Schema.TaggedStruct('Interrupted', {}),
)

export type StressTestAction = Schema.Schema.Type<typeof StressTestAction>

// =============================================================================
// Reducer Factory (needs duration)
// =============================================================================

export const createStressTestReducer =
  (durationMs: number) =>
  ({ state, action }: { state: StressTestState; action: StressTestAction }): StressTestState => {
    switch (action._tag) {
      case 'Tick': {
        if (state._tag !== 'Running') return state
        const frame = state.frame + 1
        const elapsed = Date.now() - state.startTime
        const fps = frame > 0 ? Math.round((frame / elapsed) * 1000) : 0
        const progress = Math.min(100, Math.round((elapsed / durationMs) * 100))
        return { ...state, frame, fps, progress }
      }

      case 'Finish': {
        if (state._tag !== 'Running') return state
        const elapsed = Date.now() - state.startTime
        return {
          _tag: 'Finished',
          totalFrames: state.frame,
          averageFps: state.frame > 0 ? Math.round((state.frame / elapsed) * 1000) : 0,
          duration: elapsed,
        }
      }

      case 'Interrupted': {
        if (state._tag !== 'Running') return state
        return {
          _tag: 'Interrupted',
          frame: state.frame,
          fps: state.fps,
          progress: state.progress,
        }
      }
    }
  }

// Simple reducer for Storybook (uses fixed duration)
export const stressTestReducer = createStressTestReducer(5000)
