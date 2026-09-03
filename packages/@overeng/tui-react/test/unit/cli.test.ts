/**
 * Tests for CLI entrypoint helpers.
 */

import { Effect, Exit } from 'effect'
import { describe, expect, test } from 'vitest'

import { outputModeLayer, runTuiMain, type TuiRuntime } from '../../src/effect/cli.tsx'

describe('runTuiMain', () => {
  test('sets exit code 130 for interrupt-only failures', async () => {
    // The interrupt path is fully handled inside `runTuiMain` (interrupt-only
    // cause → exitCode 130, completes as Success), so the effect handed to
    // `runMain` carries no failure in its error channel.
    let captured: Effect.Effect<unknown, never> | undefined
    const runtime: TuiRuntime = {
      runMain:
        () =>
        <E, A>(effect: Effect.Effect<A, E>) => {
          captured = effect as Effect.Effect<unknown, never>
        },
    }
    const previousExitCode = process.exitCode
    process.exitCode = undefined

    try {
      runTuiMain(runtime, Effect.interrupt)

      expect(captured).toBeDefined()
      const exit = await Effect.runPromiseExit(captured!)

      expect(Exit.isSuccess(exit)).toBe(true)
      expect(process.exitCode).toBe(130)
    } finally {
      process.exitCode = previousExitCode
    }
  })
})

describe('outputModeLayer json mode', () => {
  test('logs go to stderr only, with no stray undefined line', async () => {
    // `consolePretty` writes through the Effect `Console` service, which
    // defaults to the global console — so the two globals are the observation
    // point for the stdout/stderr split. Colors are off because vitest's
    // stdout is not a TTY, keeping the rendered line deterministic.
    const stdoutArgs: unknown[][] = []
    const stderrArgs: unknown[][] = []
    const originalLog = console.log
    const originalError = console.error
    console.log = (...args: unknown[]) => {
      stdoutArgs.push(args)
    }
    console.error = (...args: unknown[]) => {
      stderrArgs.push(args)
    }

    try {
      await Effect.runPromise(
        Effect.log('No active session').pipe(Effect.provide(outputModeLayer('json'))),
      )
    } finally {
      console.log = originalLog
      console.error = originalError
    }

    // stdout stays reserved for JSON data.
    expect(stdoutArgs).toEqual([])

    expect(stderrArgs).toHaveLength(1)
    const stderrLine = stderrArgs[0]!.map(String).join(' ')
    expect(stderrLine).toContain('No active session')
    // Wrapping the self-printing `consolePretty` in `Logger.withConsoleError`
    // used to pass its `void` result to `console.error`, logging `undefined`.
    expect(stderrArgs[0]).not.toContain(undefined)
    expect(stderrLine).not.toContain('undefined')
  })
})
