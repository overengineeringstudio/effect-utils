/**
 * Vitest reporter that publishes an atomic story-gate result before Vitest
 * begins shutting down its Vite and browser resources.
 *
 * @module
 */

import { renameSync, writeFileSync } from 'node:fs'

import type { Reporter } from 'vitest/reporters'

type TestModules = Parameters<NonNullable<Reporter['onTestRunEnd']>>[0]

/** Environment variable naming the atomic JSON report destination. */
export const storyGateReportEnvVar = 'OVERENG_STORY_GATE_REPORT'

/** Stream marker emitted only after the atomic JSON report is durable. */
export const storyGateRunCompleteMarker = '[story-gate-run] complete'

interface StoryGateReporterAssertion {
  readonly fullName: string
  readonly title: string
  readonly status: string
  readonly failureMessages: readonly string[]
}

interface StoryGateReporterResult {
  readonly name: string
  readonly assertionResults: readonly StoryGateReporterAssertion[]
}

/** Minimal report shape consumed by the derived-baseline runner. */
export interface StoryGateReporterOutput {
  readonly testResults: readonly StoryGateReporterResult[]
}

export const storyGateReporterOutput = (testModules: TestModules): StoryGateReporterOutput => ({
  testResults: testModules.map((module) => ({
    name: module.moduleId,
    assertionResults: [...module.children.allTests()].map((test) => {
      const result = test.result()
      return {
        fullName: test.name,
        title: test.name,
        status: result.state,
        failureMessages:
          result.errors?.map((error) => error.stack ?? error.message ?? JSON.stringify(error)) ??
          [],
      }
    }),
  })),
})

const requiredReportPath = (): string => {
  const path = process.env[storyGateReportEnvVar]
  if (path === undefined || path === '') {
    throw new Error(`[story-gate] ${storyGateReportEnvVar} is not set`)
  }
  return path
}

/** Reporter completion is the child protocol boundary; process close is not. */
class StoryGateCompletionReporter implements Reporter {
  onTestRunEnd(testModules: TestModules): void {
    const reportPath = requiredReportPath()
    const temporaryPath = `${reportPath}.${process.pid}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(storyGateReporterOutput(testModules)))
    renameSync(temporaryPath, reportPath)
    process.stdout.write(`${storyGateRunCompleteMarker}\n`)
  }
}

export default StoryGateCompletionReporter
