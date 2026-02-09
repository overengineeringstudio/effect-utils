/**
 * DebugTest state schema
 *
 * Defines the state machine for the `otel debug test` command.
 * Shows step-by-step progress of the E2E smoke test.
 */

import { Schema } from 'effect'

// =============================================================================
// Types
// =============================================================================

/** A single test step with its status. */
export const TestStep = Schema.Struct({
  name: Schema.String,
  status: Schema.Literal('pending', 'running', 'passed', 'failed'),
  message: Schema.optional(Schema.String),
})

/** Type for a test step. */
export type TestStep = typeof TestStep.Type

// =============================================================================
// State
// =============================================================================

/** Running state — test steps in progress. */
export const TestRunningState = Schema.TaggedStruct('Running', {
  steps: Schema.Array(TestStep),
})

/** Complete state — all steps finished. */
export const TestCompleteState = Schema.TaggedStruct('Complete', {
  steps: Schema.Array(TestStep),
  allPassed: Schema.Boolean,
})

/** Discriminated union of all states. */
export const TestState = Schema.Union(TestRunningState, TestCompleteState)

/** Type for the test state. */
export type TestState = typeof TestState.Type

// =============================================================================
// Actions
// =============================================================================

/** Update steps. */
export const UpdateStepsAction = Schema.TaggedStruct('UpdateSteps', {
  steps: Schema.Array(TestStep),
})

/** Complete the test. */
export const CompleteAction = Schema.TaggedStruct('Complete', {
  steps: Schema.Array(TestStep),
  allPassed: Schema.Boolean,
})

/** Discriminated union of all actions. */
export const TestAction = Schema.Union(UpdateStepsAction, CompleteAction)

/** Type for the test action. */
export type TestAction = typeof TestAction.Type

// =============================================================================
// Reducer
// =============================================================================

/** Pure reducer for test state transitions. */
export const testReducer = (_input: { state: TestState; action: TestAction }): TestState => {
  const { action } = _input
  switch (action._tag) {
    case 'UpdateSteps':
      return { _tag: 'Running', steps: action.steps }
    case 'Complete':
      return { _tag: 'Complete', steps: action.steps, allPassed: action.allPassed }
  }
}

// =============================================================================
// Initial State
// =============================================================================

/** Create the initial test state with pending steps. */
export const createInitialTestState = (): TestState => ({
  _tag: 'Running',
  steps: [
    { name: 'Send test span to Collector', status: 'pending' },
    { name: 'Wait for ingestion', status: 'pending' },
    { name: 'Verify span in Tempo', status: 'pending' },
    { name: 'Verify via Grafana TraceQL', status: 'pending' },
  ],
})
