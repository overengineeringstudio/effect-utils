/**
 * Deploy CLI Logic
 *
 * Core deploy logic using createTuiApp for rendering.
 */

import { Duration, Effect } from 'effect'
import React from 'react'

import { createTuiApp } from '../../../src/mod.ts'
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

// =============================================================================
// TUI App Definition (exported for app-scoped hooks in view.tsx)
// =============================================================================

export const DeployApp = createTuiApp({
  stateSchema: DeployState,
  actionSchema: DeployAction,
  initial: { _tag: 'Idle' } as DeployState,
  reducer: deployReducer,
  interruptTimeout: 200,
})

// =============================================================================
// Helpers
// =============================================================================

const timestamp = () => new Date().toISOString().slice(11, 19)

// oxlint-disable-next-line overeng/named-args -- simple factory with defaults
const createLog = (level: LogEntry['level'], message: string, service?: string): LogEntry => ({
  timestamp: timestamp(),
  level,
  message,
  service,
})

// Helper to dispatch SetState action
// oxlint-disable-next-line overeng/named-args -- simple utility helper
const setState = (
  tui: ReturnType<typeof DeployApp.run> extends Effect.Effect<infer A, any, any> ? A : never,
  state: DeployState,
) => {
  tui.dispatch({ _tag: 'SetState', state })
}

// Helper to update service status
// oxlint-disable-next-line overeng/named-args -- simple utility helper
const updateService = (
  tui: ReturnType<typeof DeployApp.run> extends Effect.Effect<infer A, any, any> ? A : never,
  index: number,
  status: ServiceProgress['status'],
  message?: string,
) => {
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
      return Effect.fail(new Error(`Failed to pull image for ${service}`))
    }

    return Effect.void
  }).pipe(Effect.flatten)

const simulateStart = (service: string) =>
  Effect.gen(function* () {
    // Simulate starting container (200-400ms)
    yield* Effect.sleep(Duration.millis(200 + Math.random() * 200))

    // 3% chance of failure
    if (Math.random() < 0.03) {
      return Effect.fail(new Error(`Failed to start ${service}`))
    }

    return Effect.void
  }).pipe(Effect.flatten)

const simulateHealthcheck = (service: string) =>
  Effect.gen(function* () {
    // Simulate health check (400-800ms)
    yield* Effect.sleep(Duration.millis(400 + Math.random() * 400))

    // 2% chance of failure
    if (Math.random() < 0.02) {
      return Effect.fail(new Error(`Health check failed for ${service}`))
    }

    return Effect.void
  }).pipe(Effect.flatten)

// =============================================================================
// Main Deploy Function
// =============================================================================

export const runDeploy = (options: DeployOptions): Effect.Effect<DeployResult, never, any> =>
  Effect.gen(function* () {
    const { services, environment, dryRun = false } = options
    const tui = yield* DeployApp.run(<DeployView />)

    const logs: LogEntry[] = []
    // oxlint-disable-next-line overeng/named-args -- simple utility helper
    const log = (level: LogEntry['level'], message: string, service?: string) => {
      logs.push(createLog(level, message, service))
    }

    const startedAt = Date.now()

    // ===================
    // Phase 1: Validation
    // ===================
    log('info', `Starting deployment to ${environment}`)
    log('info', `Services: ${services.join(', ')}`)

    setState(tui, {
      _tag: 'Validating',
      environment,
      services,
      logs: [...logs],
    })

    yield* Effect.sleep(Duration.millis(500))
    log('info', 'Configuration validated')

    if (dryRun) {
      log('info', 'Dry run mode - skipping actual deployment')
      const results: ServiceResult[] = services.map((name) => ({
        name,
        result: 'unchanged' as const,
        duration: 0,
      }))

      setState(tui, {
        _tag: 'Complete',
        environment,
        services: results,
        logs: [...logs],
        startedAt,
        completedAt: Date.now(),
        totalDuration: Date.now() - startedAt,
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

    setState(tui, {
      _tag: 'Progress',
      environment,
      services: serviceStates,
      logs: [...logs],
      startedAt,
    })

    const results: ServiceResult[] = []
    let failed = false
    let failedService: string | undefined
    let failedError: string | undefined

    for (let i = 0; i < services.length; i++) {
      const service = services[i]!
      const serviceStart = Date.now()

      // Update to pulling
      log('info', 'Pulling image...', service)
      updateService(tui, i, 'pulling', 'Pulling image...')
      // Also update logs in state
      setState(tui, {
        ...(tui.getState() as Extract<DeployState, { _tag: 'Progress' }>),
        logs: [...logs],
      })

      const pullResult = yield* simulatePull(service).pipe(Effect.either)
      if (pullResult._tag === 'Left') {
        failed = true
        failedService = service
        failedError = pullResult.left.message
        log('error', pullResult.left.message, service)
        results.push({
          name: service,
          result: 'failed',
          duration: Date.now() - serviceStart,
          error: pullResult.left.message,
        })
        break
      }

      // Update to starting
      log('info', 'Starting container...', service)
      updateService(tui, i, 'starting', 'Starting...')
      setState(tui, {
        ...(tui.getState() as Extract<DeployState, { _tag: 'Progress' }>),
        logs: [...logs],
      })

      const startResult = yield* simulateStart(service).pipe(Effect.either)
      if (startResult._tag === 'Left') {
        failed = true
        failedService = service
        failedError = startResult.left.message
        log('error', startResult.left.message, service)
        results.push({
          name: service,
          result: 'failed',
          duration: Date.now() - serviceStart,
          error: startResult.left.message,
        })
        break
      }

      // Update to healthcheck
      log('info', 'Running health check...', service)
      updateService(tui, i, 'healthcheck', 'Health check...')
      setState(tui, {
        ...(tui.getState() as Extract<DeployState, { _tag: 'Progress' }>),
        logs: [...logs],
      })

      const healthResult = yield* simulateHealthcheck(service).pipe(Effect.either)
      if (healthResult._tag === 'Left') {
        failed = true
        failedService = service
        failedError = healthResult.left.message
        log('error', healthResult.left.message, service)
        results.push({
          name: service,
          result: 'failed',
          duration: Date.now() - serviceStart,
          error: healthResult.left.message,
        })
        break
      }

      // Success!
      log('info', 'Deployed successfully', service)
      updateService(tui, i, 'healthy', undefined)
      setState(tui, {
        ...(tui.getState() as Extract<DeployState, { _tag: 'Progress' }>),
        logs: [...logs],
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
      log('error', `Deployment failed: ${failedError}`)

      setState(tui, {
        _tag: 'Failed',
        environment,
        services: results,
        error: `Service "${failedService}" failed: ${failedError}`,
        logs: [...logs],
        startedAt,
        failedAt: Date.now(),
      })

      return {
        success: false,
        services: results,
        totalDuration: Date.now() - startedAt,
        error: failedError,
      }
    }

    const totalDuration = Date.now() - startedAt
    log('info', `Deployment complete in ${(totalDuration / 1000).toFixed(1)}s`)

    setState(tui, {
      _tag: 'Complete',
      environment,
      services: results,
      logs: [...logs],
      startedAt,
      completedAt: Date.now(),
      totalDuration,
    })

    return { success: true, services: results, totalDuration }
  }).pipe(Effect.scoped)
