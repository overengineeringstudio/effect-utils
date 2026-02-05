/**
 * Deploy CLI Logic
 *
 * Core deploy logic using createTuiApp for rendering.
 */

import { Schema } from 'effect'
import { Duration, Effect } from 'effect'
import React from 'react'

import type { OutputModeTag, TuiAppApi } from '../../../src/mod.ts'
import { createTuiApp, run } from '../../../src/mod.ts'
import {
  DeployState,
  DeployAction,
  deployReducer,
  type DeployOptions,
  type DeployResult,
  type LogEntry,
  type ServiceProgress,
  type ServiceResult,
} from './schema.ts'
import { DeployView } from './view.tsx'

/** Tagged error type for deployment failures. */
export class DeployError extends Schema.TaggedError<DeployError>()('DeployError', {
  message: Schema.String,
}) {}

// =============================================================================
// TUI App Definition (exported for app-scoped hooks in view.tsx)
// =============================================================================

/** TuiApp instance for the deploy command with state schema, action schema, and reducer. */
export const DeployApp = createTuiApp({
  stateSchema: DeployState,
  actionSchema: DeployAction,
  initial: { _tag: 'Idle' } as DeployState,
  reducer: deployReducer,
})

// =============================================================================
// Helpers
// =============================================================================

const timestamp = () => new Date().toISOString().slice(11, 19)

const createLog = (entry: {
  level: LogEntry['level']
  message: string
  service?: string
}): LogEntry => ({
  timestamp: timestamp(),
  level: entry.level,
  message: entry.message,
  ...(entry.service !== undefined ? { service: entry.service } : {}),
})

// Helper to dispatch SetState action
const setState = ({
  tui,
  state,
}: {
  tui: TuiAppApi<DeployState, DeployAction>
  state: DeployState
}) => {
  tui.dispatch({ _tag: 'SetState', state })
}

// Helper to update service status
const updateService = ({
  tui,
  index,
  status,
  message,
}: {
  tui: TuiAppApi<DeployState, DeployAction>
  index: number
  status: ServiceProgress['status']
  message?: string
}) => {
  tui.dispatch({ _tag: 'UpdateServiceStatus', index, status, message })
}

// =============================================================================
// Simulated Deploy Steps
// =============================================================================

const simulatePull = (service: string) =>
  Effect.gen(function* () {
    // Simulate pulling image (300-600ms)
    yield* Effect.sleep(Duration.millis(300 + Math.random() * 300))

    // 5% chance of failure
    if (Math.random() < 0.05) {
      return yield* new DeployError({ message: `Failed to pull image for ${service}` })
    }
  })

const simulateStart = (service: string) =>
  Effect.gen(function* () {
    // Simulate starting container (200-400ms)
    yield* Effect.sleep(Duration.millis(200 + Math.random() * 200))

    // 3% chance of failure
    if (Math.random() < 0.03) {
      return yield* new DeployError({ message: `Failed to start ${service}` })
    }
  })

const simulateHealthcheck = (service: string) =>
  Effect.gen(function* () {
    // Simulate health check (400-800ms)
    yield* Effect.sleep(Duration.millis(400 + Math.random() * 400))

    // 2% chance of failure
    if (Math.random() < 0.02) {
      return yield* new DeployError({ message: `Health check failed for ${service}` })
    }
  })

// =============================================================================
// Main Deploy Function
// =============================================================================

/** Runs a simulated multi-service deployment with validation, progress tracking, and error handling. */
export const runDeploy = (
  options: DeployOptions,
): Effect.Effect<DeployResult, never, OutputModeTag> =>
  run(
    DeployApp,
    (tui) =>
      Effect.gen(function* () {
        const { services, environment, dryRun = false } = options

        const logs: LogEntry[] = []
        const log = (entry: { level: LogEntry['level']; message: string; service?: string }) => {
          logs.push(createLog(entry))
        }

        const startedAt = Date.now()

        // ===================
        // Phase 1: Validation
        // ===================
        log({ level: 'info', message: `Starting deployment to ${environment}` })
        log({ level: 'info', message: `Services: ${services.join(', ')}` })

        setState({
          tui,
          state: {
            _tag: 'Validating',
            environment,
            services,
            logs: [...logs],
          },
        })

        yield* Effect.sleep(Duration.millis(500))
        log({ level: 'info', message: 'Configuration validated' })

        if (dryRun) {
          log({ level: 'info', message: 'Dry run mode - skipping actual deployment' })
          const results: ServiceResult[] = services.map((name) => ({
            name,
            result: 'unchanged' as const,
            duration: 0,
          }))

          setState({
            tui,
            state: {
              _tag: 'Complete',
              environment,
              services: results,
              logs: [...logs],
              startedAt,
              completedAt: Date.now(),
              totalDuration: Date.now() - startedAt,
            },
          })

          return { success: true, services: results, totalDuration: Date.now() - startedAt }
        }

        // ===================
        // Phase 2: Deploy
        // ===================
        const serviceStates: ServiceProgress[] = services.map((name) => ({
          name,
          status: 'pending' as const,
        }))

        setState({
          tui,
          state: {
            _tag: 'Progress',
            environment,
            services: serviceStates,
            logs: [...logs],
            startedAt,
          },
        })

        const results: ServiceResult[] = []
        let failed = false
        let failedService: string | undefined
        let failedError: string | undefined

        for (let i = 0; i < services.length; i++) {
          const service = services[i]!
          const serviceStart = Date.now()

          // Update to pulling
          log({ level: 'info', message: 'Pulling image...', service })
          updateService({ tui, index: i, status: 'pulling', message: 'Pulling image...' })
          // Also update logs in state
          setState({
            tui,
            state: {
              ...(tui.getState() as Extract<DeployState, { _tag: 'Progress' }>),
              logs: [...logs],
            },
          })

          const pullResult = yield* simulatePull(service).pipe(Effect.either)
          if (pullResult._tag === 'Left') {
            failed = true
            failedService = service
            failedError = pullResult.left.message
            log({ level: 'error', message: pullResult.left.message, service })
            results.push({
              name: service,
              result: 'failed',
              duration: Date.now() - serviceStart,
              error: pullResult.left.message,
            })
            break
          }

          // Update to starting
          log({ level: 'info', message: 'Starting container...', service })
          updateService({ tui, index: i, status: 'starting', message: 'Starting...' })
          setState({
            tui,
            state: {
              ...(tui.getState() as Extract<DeployState, { _tag: 'Progress' }>),
              logs: [...logs],
            },
          })

          const startResult = yield* simulateStart(service).pipe(Effect.either)
          if (startResult._tag === 'Left') {
            failed = true
            failedService = service
            failedError = startResult.left.message
            log({ level: 'error', message: startResult.left.message, service })
            results.push({
              name: service,
              result: 'failed',
              duration: Date.now() - serviceStart,
              error: startResult.left.message,
            })
            break
          }

          // Update to healthcheck
          log({ level: 'info', message: 'Running health check...', service })
          updateService({ tui, index: i, status: 'healthcheck', message: 'Health check...' })
          setState({
            tui,
            state: {
              ...(tui.getState() as Extract<DeployState, { _tag: 'Progress' }>),
              logs: [...logs],
            },
          })

          const healthResult = yield* simulateHealthcheck(service).pipe(Effect.either)
          if (healthResult._tag === 'Left') {
            failed = true
            failedService = service
            failedError = healthResult.left.message
            log({ level: 'error', message: healthResult.left.message, service })
            results.push({
              name: service,
              result: 'failed',
              duration: Date.now() - serviceStart,
              error: healthResult.left.message,
            })
            break
          }

          // Success!
          log({ level: 'info', message: 'Deployed successfully', service })
          updateService({ tui, index: i, status: 'healthy' })
          setState({
            tui,
            state: {
              ...(tui.getState() as Extract<DeployState, { _tag: 'Progress' }>),
              logs: [...logs],
            },
          })

          results.push({
            name: service,
            result: 'updated',
            duration: Date.now() - serviceStart,
          })
        }

        // ===================
        // Phase 3: Complete or Failed
        // ===================
        if (failed) {
          log({ level: 'error', message: `Deployment failed: ${failedError}` })

          setState({
            tui,
            state: {
              _tag: 'Failed',
              environment,
              services: results,
              error: `Service "${failedService}" failed: ${failedError}`,
              logs: [...logs],
              startedAt,
              failedAt: Date.now(),
            },
          })

          return {
            success: false,
            services: results,
            totalDuration: Date.now() - startedAt,
            error: failedError,
          }
        }

        const totalDuration = Date.now() - startedAt
        log({
          level: 'info',
          message: `Deployment complete in ${(totalDuration / 1000).toFixed(1)}s`,
        })

        setState({
          tui,
          state: {
            _tag: 'Complete',
            environment,
            services: results,
            logs: [...logs],
            startedAt,
            completedAt: Date.now(),
            totalDuration,
          },
        })

        return { success: true, services: results, totalDuration }
      }),
    { view: <DeployView stateAtom={DeployApp.stateAtom} /> },
  )
