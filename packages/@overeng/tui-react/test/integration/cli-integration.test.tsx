/**
 * Integration tests for Effect CLI integration.
 *
 * Tests the full flow of using createTuiApp with different output modes.
 */

import { Effect, Duration, Schema } from 'effect'
import React from 'react'
import { describe, test, expect, beforeEach, afterEach } from 'vitest'

import { createTuiApp, detectOutputMode, Box, Text, testModeLayer } from '../../src/mod.ts'

// =============================================================================
// Test State Schema (simulating a deploy command)
// =============================================================================

const DeployState = Schema.Union(
  Schema.TaggedStruct('Idle', {}),
  Schema.TaggedStruct('Validating', {
    logs: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct('Progress', {
    services: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: Schema.Literal('pending', 'deploying', 'healthy'),
      }),
    ),
    logs: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct('Complete', {
    services: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        result: Schema.Literal('updated', 'unchanged'),
        duration: Schema.Number,
      }),
    ),
    totalDuration: Schema.Number,
  }),
)

type DeployState = Schema.Schema.Type<typeof DeployState>

// =============================================================================
// Action Schema
// =============================================================================

const DeployAction = Schema.Union(
  Schema.TaggedStruct('StartValidation', { logs: Schema.Array(Schema.String) }),
  Schema.TaggedStruct('StartProgress', {
    services: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: Schema.Literal('pending', 'deploying', 'healthy'),
      }),
    ),
    logs: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct('UpdateService', {
    index: Schema.Number,
    status: Schema.Literal('pending', 'deploying', 'healthy'),
  }),
  Schema.TaggedStruct('Complete', {
    services: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        result: Schema.Literal('updated', 'unchanged'),
        duration: Schema.Number,
      }),
    ),
    totalDuration: Schema.Number,
  }),
)

type DeployAction = Schema.Schema.Type<typeof DeployAction>

// =============================================================================
// Reducer
// =============================================================================

const deployReducer = ({
  state,
  action,
}: {
  state: DeployState
  action: DeployAction
}): DeployState => {
  switch (action._tag) {
    case 'StartValidation':
      return { _tag: 'Validating', logs: action.logs }
    case 'StartProgress':
      return { _tag: 'Progress', services: action.services, logs: action.logs }
    case 'UpdateService':
      if (state._tag !== 'Progress') return state
      return {
        ...state,
        services: state.services.map((s, idx) =>
          idx === action.index ? { ...s, status: action.status } : s,
        ),
      }
    case 'Complete':
      return { _tag: 'Complete', services: action.services, totalDuration: action.totalDuration }
  }
}

// =============================================================================
// Test App
// =============================================================================

const DeployApp = createTuiApp({
  stateSchema: DeployState,
  actionSchema: DeployAction,
  initial: { _tag: 'Idle' } as DeployState,
  reducer: deployReducer,
})

// =============================================================================
// Test View Component (uses app-scoped hooks)
// =============================================================================

const DeployView = () => {
  const state = DeployApp.useState()

  if (state._tag === 'Idle') return null

  return (
    <Box flexDirection="column">
      {state._tag === 'Validating' && <Text>Validating...</Text>}
      {state._tag === 'Progress' && (
        <>
          <Text>
            Deploying {state.services.filter((s) => s.status === 'healthy').length}/
            {state.services.length}
          </Text>
          {state.services.map((s) => (
            <Text key={s.name}>
              {s.status === 'healthy' ? '✓' : s.status === 'deploying' ? '◐' : '○'} {s.name}
            </Text>
          ))}
        </>
      )}
      {state._tag === 'Complete' && (
        <Text color="green">
          ✓ Deployed {state.services.length} services in {state.totalDuration}ms
        </Text>
      )}
    </Box>
  )
}

// =============================================================================
// Test Command Logic
// =============================================================================

const runDeploy = (services: string[]) =>
  Effect.gen(function* () {
    const tui = yield* DeployApp.run(<DeployView />)
    const logs: string[] = []
    const startTime = Date.now()

    // Phase 1: Validating
    logs.push('Validating configuration...')
    tui.dispatch({ _tag: 'StartValidation', logs: [...logs] })
    yield* Effect.sleep(Duration.millis(10))

    // Phase 2: Progress
    logs.push('Starting deployment...')
    const serviceStates = services.map((name) => ({ name, status: 'pending' as const }))
    tui.dispatch({ _tag: 'StartProgress', services: serviceStates, logs: [...logs] })

    // Deploy each service
    for (let i = 0; i < services.length; i++) {
      tui.dispatch({ _tag: 'UpdateService', index: i, status: 'deploying' })
      yield* Effect.sleep(Duration.millis(10))
      tui.dispatch({ _tag: 'UpdateService', index: i, status: 'healthy' })
    }

    // Phase 3: Complete
    const totalDuration = Date.now() - startTime
    tui.dispatch({
      _tag: 'Complete',
      services: services.map((name) => ({ name, result: 'updated' as const, duration: 10 })),
      totalDuration,
    })

    return { success: true, totalDuration }
  }).pipe(Effect.scoped)

// =============================================================================
// Tests
// =============================================================================

describe('CLI Integration', () => {
  let originalLog: typeof console.log
  let capturedOutput: string[]

  beforeEach(() => {
    originalLog = console.log
    capturedOutput = []
    console.log = (msg: string) => {
      capturedOutput.push(msg)
    }
  })

  afterEach(() => {
    console.log = originalLog
  })

  test('json mode outputs complete state', async () => {
    const result = await runDeploy(['api', 'web']).pipe(
      Effect.provide(testModeLayer('json')),
      Effect.runPromise,
    )

    expect(result.success).toBe(true)
    expect(capturedOutput).toHaveLength(1)

    const output = JSON.parse(capturedOutput[0]!)
    expect(output._tag).toBe('Complete')
    expect(output.services).toHaveLength(2)
    expect(output.services[0].name).toBe('api')
    expect(output.services[1].name).toBe('web')
  })

  test('ndjson mode streams state changes', async () => {
    await runDeploy(['api']).pipe(
      Effect.provide(testModeLayer('ndjson')),
      Effect.runPromise,
    )

    // Should have multiple JSON outputs
    expect(capturedOutput.length).toBeGreaterThan(1)

    // All should be valid JSON
    const parsed = capturedOutput.map((line) => JSON.parse(line))

    // Should see state progression
    const tags = parsed.map((p) => p._tag)
    expect(tags).toContain('Idle')
    expect(tags).toContain('Complete')
  })

  test('pipe mode produces no output', async () => {
    await runDeploy(['api', 'web']).pipe(
      Effect.provide(testModeLayer('pipe')),
      Effect.runPromise,
    )

    expect(capturedOutput).toHaveLength(0)
  })

  test('detectOutputMode returns appropriate mode for environment', () => {
    // In test environment (non-TTY), detectOutputMode returns pipe mode
    const mode = detectOutputMode()
    expect(mode._tag).toBe('react')
    expect(mode.timing).toBe('final') // pipe is final
  })

  test('command result is returned correctly', async () => {
    const result = await runDeploy(['api', 'web', 'worker']).pipe(
      Effect.provide(testModeLayer('pipe')),
      Effect.runPromise,
    )

    expect(result.success).toBe(true)
    expect(result.totalDuration).toBeGreaterThan(0)
  })
})
