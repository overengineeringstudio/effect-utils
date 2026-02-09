/**
 * Test fixtures for DebugTest stories
 *
 * Provides state factories and timeline for the `otel debug test` Storybook.
 *
 * @internal
 */

import type { TestAction, TestState, TestStep } from '../schema.ts'

// =============================================================================
// Step Names
// =============================================================================

/** The 4 E2E smoke test steps. */
const STEP_NAMES = [
  'Send test span to Collector',
  'Wait for ingestion',
  'Verify span in Tempo',
  'Verify via Grafana TraceQL',
] as const

// =============================================================================
// State Config
// =============================================================================

/** Configuration for creating a final test state. */
export interface TestStateConfig {
  /** Final status for each step. */
  steps: Array<{ status: 'passed' | 'failed'; message?: string }>
  /** Whether all steps passed. */
  allPassed: boolean
}

/** All steps pass config. */
export const allPassedConfig: TestStateConfig = {
  steps: [{ status: 'passed' }, { status: 'passed' }, { status: 'passed' }, { status: 'passed' }],
  allPassed: true,
}

/** Partial progress config (2 passed, 1 running, 1 pending). */
export const partialProgressConfig: TestStateConfig = {
  steps: [{ status: 'passed' }, { status: 'passed' }, { status: 'passed' }, { status: 'passed' }],
  allPassed: true,
}

/** Some steps failed config. */
export const someFailedConfig: TestStateConfig = {
  steps: [
    { status: 'passed' },
    { status: 'passed' },
    { status: 'failed', message: 'Span not found in Tempo after 30s timeout' },
    { status: 'failed', message: 'TraceQL query returned 0 results' },
  ],
  allPassed: false,
}

// =============================================================================
// State Factories
// =============================================================================

/** Initial running state with all steps pending. */
export const runningState = (): TestState => ({
  _tag: 'Running',
  steps: STEP_NAMES.map((name) => ({ name, status: 'pending' as const })),
})

/** Partial progress state - 2 passed, 1 running, 1 pending. */
export const partialProgressState = (): TestState => ({
  _tag: 'Running',
  steps: [
    { name: STEP_NAMES[0], status: 'passed' },
    { name: STEP_NAMES[1], status: 'passed' },
    { name: STEP_NAMES[2], status: 'running' },
    { name: STEP_NAMES[3], status: 'pending' },
  ],
})

/** Build a TestStep from config at index i. */
const buildStep = (_: { name: string; configStep: TestStateConfig['steps'][number] }): TestStep =>
  _.configStep.message !== undefined
    ? { name: _.name, status: _.configStep.status, message: _.configStep.message }
    : { name: _.name, status: _.configStep.status }

/** Create a complete state from config. */
export const createFinalState = (config: TestStateConfig): TestState => ({
  _tag: 'Complete',
  steps: STEP_NAMES.map((name, i) => buildStep({ name, configStep: config.steps[i]! })),
  allPassed: config.allPassed,
})

/** All steps passed complete state. */
export const allPassedState = (): TestState => createFinalState(allPassedConfig)

/** Some steps failed complete state. */
export const someFailedState = (): TestState => createFinalState(someFailedConfig)

// =============================================================================
// Timeline Factory
// =============================================================================

/** Step duration between timeline events in milliseconds. */
const STEP_DURATION = 600

/**
 * Build the steps array for a given point in the timeline.
 *
 * Steps before `currentIndex` get their final status from config,
 * the step at `currentIndex` is marked as 'running',
 * and steps after remain 'pending'.
 */
const buildSteps = (_: { config: TestStateConfig; currentIndex: number }): TestStep[] =>
  STEP_NAMES.map((name, i) => {
    if (i < _.currentIndex) {
      return buildStep({ name, configStep: _.config.steps[i]! })
    }
    if (i === _.currentIndex) {
      return { name, status: 'running' as const }
    }
    return { name, status: 'pending' as const }
  })

/**
 * Create a timeline that animates through each test step and ends at
 * the final state matching the static rendering.
 *
 * Timeline:
 * - at 600: Step 1 running
 * - at 1200: Step 1 done, step 2 running
 * - at 1800: Step 2 done, step 3 running
 * - at 2400: Step 3 done, step 4 running
 * - at 3000: Complete with final results
 */
export const createTimeline = (
  config: TestStateConfig,
): Array<{ at: number; action: TestAction }> => {
  const timeline: Array<{ at: number; action: TestAction }> = []

  // Animate through each step: set it to 'running', then advance
  for (let i = 0; i < STEP_NAMES.length; i++) {
    timeline.push({
      at: (i + 1) * STEP_DURATION,
      action: {
        _tag: 'UpdateSteps',
        steps: buildSteps({ config, currentIndex: i }),
      },
    })
  }

  // Final Complete action with all steps resolved
  timeline.push({
    at: (STEP_NAMES.length + 1) * STEP_DURATION,
    action: {
      _tag: 'Complete',
      steps: STEP_NAMES.map((name, i) => buildStep({ name, configStep: config.steps[i]! })),
      allPassed: config.allPassed,
    },
  })

  return timeline
}
