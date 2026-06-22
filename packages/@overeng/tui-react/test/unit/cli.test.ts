/**
 * Tests for CLI entrypoint helpers.
 */

import { Effect, Exit } from 'effect'
import { describe, expect, test } from 'vitest'

import { runTuiMain, type TuiRuntime } from '../../src/effect/cli.tsx'

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
