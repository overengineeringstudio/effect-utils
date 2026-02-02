/**
 * Rapid Updates Stress Test - State and Action Schemas
 */

import { Schema } from 'effect'

// =============================================================================
// State Schema
// =============================================================================

/** Schema for the running stress test state with frame count, FPS, and progress. */
export const RunningState = Schema.TaggedStruct('Running', {
  frame: Schema.Number,
  startTime: Schema.Number,
  fps: Schema.Number,
  progress: Schema.Number,
})

/** Schema for the finished stress test state with total frames, average FPS, and duration. */
export const FinishedState = Schema.TaggedStruct('Finished', {
  totalFrames: Schema.Number,
  averageFps: Schema.Number,
  duration: Schema.Number,
})

/** Schema for the interrupted stress test state preserving last frame, FPS, and progress. */
export const InterruptedState = Schema.TaggedStruct('Interrupted', {
  frame: Schema.Number,
  fps: Schema.Number,
  progress: Schema.Number,
})

/** Union schema of all stress test states. */
export const StressTestState = Schema.Union(RunningState, FinishedState, InterruptedState)

/** Inferred type for the stress test state union. */
export type StressTestState = Schema.Schema.Type<typeof StressTestState>

// =============================================================================
// Action Schema
// =============================================================================

/** Union schema of stress test actions (Tick, Finish, Interrupted). */
export const StressTestAction = Schema.Union(
  Schema.TaggedStruct('Tick', {}),
  Schema.TaggedStruct('Finish', {}),
  Schema.TaggedStruct('Interrupted', {}),
)

/** Inferred type for the stress test action union. */
export type StressTestAction = Schema.Schema.Type<typeof StressTestAction>

// =============================================================================
// Reducer Factory (needs duration)
// =============================================================================

/** Creates a stress test reducer parameterized by test duration in milliseconds. */
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
/** Pre-configured stress test reducer with a 5-second duration for Storybook use. */
export const stressTestReducer = createStressTestReducer(5000)
