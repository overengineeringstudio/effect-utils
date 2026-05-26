/**
 * Tests for CLI entrypoint helpers.
 */

import { Effect, Exit } from 'effect'
import { describe, expect, test } from 'vitest'

import { runTuiMain, type TuiRuntime } from '../../src/effect/cli.tsx'

describe('runTuiMain', () => {
  test('sets exit code 130 for interrupt-only failures', async () => {
    let captured: Effect.Effect<unknown, unknown> | undefined
    const runtime: TuiRuntime = {
      runMain:
        () =>
        <E, A>(effect: Effect.Effect<A, E>) => {
          captured = effect
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
