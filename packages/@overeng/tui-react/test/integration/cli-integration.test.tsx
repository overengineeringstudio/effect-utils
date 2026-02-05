/**
 * Integration tests for Effect CLI integration.
 *
 * Tests the full flow of using createTuiApp with different output modes.
 */

import { it } from '@effect/vitest'
import { Effect, Duration, Schema } from 'effect'
import React from 'react'
import { describe, expect, beforeEach, afterEach } from 'vitest'

import {
  createTuiApp,
  run,
  useTuiAtomValue,
  detectOutputMode,
  Box,
  Text,
  testModeLayer,
} from '../../src/mod.tsx'

const parseJson = (json: string) =>
  Schema.decodeSync(
    Schema.parseJson(
      Schema.Record({
        key: Schema.String,
        value: Schema.Unknown,
      }),
    ),
  )(json)

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
  const state = useTuiAtomValue(DeployApp.stateAtom)

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
  run(
    DeployApp,
    (tui) =>
      Effect.gen(function* () {
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
      }),
    { view: <DeployView /> },
  )

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

  it.live('json mode outputs complete state with Success wrapper', () =>
    Effect.gen(function* () {
      const result = yield* runDeploy(['api', 'web'])

      expect(result.success).toBe(true)
      expect(capturedOutput).toHaveLength(1)

      const output = parseJson(capturedOutput[0]!) as {
        _tag: string
        value: { _tag: string; services: Array<{ name: string }> }
      }
      // State is a union (non-struct), so it's wrapped in Success with `value`
      expect(output._tag).toBe('Success')
      expect(output.value._tag).toBe('Complete')
      const services = output.value.services
      expect(services).toHaveLength(2)
      expect(services[0]!.name).toBe('api')
      expect(services[1]!.name).toBe('web')
    }).pipe(Effect.provide(testModeLayer('json'))),
  )

  it.live('ndjson mode streams state changes with final Success wrapper', () =>
    Effect.gen(function* () {
      yield* runDeploy(['api'])

      // Should have multiple JSON outputs (intermediate raw + final wrapped)
      expect(capturedOutput.length).toBeGreaterThan(1)

      // All should be valid JSON
      const parsed = capturedOutput.map(
        (line) => parseJson(line) as { _tag: string; value?: { _tag: string } },
      )

      // Intermediate lines should be raw state
      const intermediateTags = parsed.slice(0, -1).map((p) => p._tag)
      expect(intermediateTags).toContain('Idle')

      // Final line should be Success wrapper with Complete state
      const finalOutput = parsed[parsed.length - 1] as {
        _tag: string
        value: { _tag: string }
      }
      expect(finalOutput._tag).toBe('Success')
      expect(finalOutput.value._tag).toBe('Complete')
    }).pipe(Effect.provide(testModeLayer('ndjson'))),
  )

  it.live('pipe mode produces final output only', () =>
    Effect.gen(function* () {
      yield* runDeploy(['api', 'web'])

      // Pipe mode outputs the final rendered state (single output at end)
      expect(capturedOutput).toHaveLength(1)
      // Should contain the final "Deployed" message
      expect(capturedOutput[0]).toContain('Deployed')
    }).pipe(Effect.provide(testModeLayer('pipe'))),
  )

  it('detectOutputMode returns appropriate mode for environment', () => {
    // Clear agent env vars so we test the non-agent, non-TTY path
    const savedEnv: Record<string, string | undefined> = {}
    const agentVars = [
      'AGENT',
      'CLAUDE_PROJECT_DIR',
      'CLAUDECODE',
      'OPENCODE',
      'CLINE_ACTIVE',
      'CODEX_SANDBOX',
    ]
    for (const key of agentVars) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    try {
      // In non-TTY, non-agent environment, detectOutputMode returns pipe (react + final)
      const mode = detectOutputMode()
      expect(mode._tag).toBe('react')
      expect(mode.timing).toBe('final') // pipe is final
    } finally {
      for (const key of agentVars) {
        if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key]
        else delete process.env[key]
      }
    }
  })

  it.live('command result is returned correctly', () =>
    Effect.gen(function* () {
      const result = yield* runDeploy(['api', 'web', 'worker'])

      expect(result.success).toBe(true)
      expect(result.totalDuration).toBeGreaterThan(0)
    }).pipe(Effect.provide(testModeLayer('pipe'))),
  )
})
