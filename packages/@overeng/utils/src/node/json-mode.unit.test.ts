/**
 * Unit tests for JSON mode CLI helpers
 */

import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { afterEach, beforeEach, expect, vi } from 'vitest'

import { jsonOutput, withJsonMode } from './json-mode.ts'

describe('JSON mode helpers', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
  })

  describe('jsonOutput', () => {
    it.effect('outputs JSON to stdout', () =>
      Effect.gen(function* () {
        yield* jsonOutput({ foo: 'bar', count: 42 })

        expect(consoleLogSpy).toHaveBeenCalledOnce()
        expect(consoleLogSpy).toHaveBeenCalledWith('{"foo":"bar","count":42}')
      }),
    )

    it.effect('handles arrays', () =>
      Effect.gen(function* () {
        yield* jsonOutput([1, 2, 3])

        expect(consoleLogSpy).toHaveBeenCalledOnce()
        expect(consoleLogSpy).toHaveBeenCalledWith('[1,2,3]')
      }),
    )

    it.effect('handles nested objects', () =>
      Effect.gen(function* () {
        yield* jsonOutput({ nested: { deep: true } })

        expect(consoleLogSpy).toHaveBeenCalledOnce()
        expect(consoleLogSpy).toHaveBeenCalledWith('{"nested":{"deep":true}}')
      }),
    )
  })

  describe('withJsonMode', () => {
    it.effect('passes through effect when json=false', () =>
      Effect.gen(function* () {
        const result = yield* withJsonMode({
          json: false,
          effect: Effect.succeed('success'),
        })

        expect(result).toBe('success')
        expect(consoleLogSpy).not.toHaveBeenCalled()
      }),
    )

    it.effect('passes through successful effect when json=true', () =>
      Effect.gen(function* () {
        const result = yield* withJsonMode({
          json: true,
          effect: Effect.succeed('success'),
        })

        expect(result).toBe('success')
        expect(consoleLogSpy).not.toHaveBeenCalled()
      }),
    )

    // Using regular `it` because the effect exits on failure (uses Effect.async<never>)
    it('catches typed failures and outputs JSON error when json=true', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

      try {
        await Promise.race([
          Effect.runPromise(
            withJsonMode({
              json: true,
              effect: Effect.fail('typed error'),
            }),
          ).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 100)),
        ])
      } finally {
        exitSpy.mockRestore()
      }

      // Verify JSON error was output
      expect(consoleLogSpy).toHaveBeenCalledOnce()
      const output = consoleLogSpy.mock.calls[0]?.[0] as string
      const parsed = JSON.parse(output)
      expect(parsed.error).toBe('internal_error')
      expect(parsed.message).toContain('typed error')
      // Note: process.exit is called async after stdout flush - integration tests verify exit behavior
    })

    it.effect('lets typed failures propagate when json=false', () =>
      Effect.gen(function* () {
        const effect = withJsonMode({
          json: false,
          effect: Effect.fail('expected error'),
        })

        const result = yield* Effect.either(effect)

        expect(result._tag).toBe('Left')
        if (result._tag === 'Left') {
          expect(result.left).toBe('expected error')
        }
        expect(consoleLogSpy).not.toHaveBeenCalled()
      }),
    )

    // Using regular `it` because the effect exits on defect (uses Effect.async<never>)
    it('catches defects and outputs JSON error when json=true', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

      try {
        // Run the effect - JSON is output synchronously, then process.exit is called
        // after stdout flushes via the async callback
        await Promise.race([
          Effect.runPromise(
            withJsonMode({
              json: true,
              effect: Effect.die(new Error('unexpected crash')),
            }),
          ).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 100)),
        ])
      } finally {
        exitSpy.mockRestore()
      }

      // Verify JSON error was output
      expect(consoleLogSpy).toHaveBeenCalledOnce()
      const output = consoleLogSpy.mock.calls[0]?.[0] as string
      const parsed = JSON.parse(output)
      expect(parsed.error).toBe('internal_error')
      expect(parsed.message).toContain('unexpected crash')
      // Note: process.exit is called async after stdout flush - integration tests verify exit behavior
    })

    it.effect('lets defects propagate when json=false', () =>
      Effect.gen(function* () {
        const effect = withJsonMode({
          json: false,
          effect: Effect.die(new Error('unexpected crash')),
        })

        const result = yield* Effect.exit(effect)

        expect(result._tag).toBe('Failure')
        expect(consoleLogSpy).not.toHaveBeenCalled()
      }),
    )

    // Using regular `it` because the effect exits on defect (uses Effect.async<never>)
    it('formats non-Error defects correctly', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

      try {
        await Promise.race([
          Effect.runPromise(
            withJsonMode({
              json: true,
              effect: Effect.die('string defect'),
            }),
          ).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 100)),
        ])
      } finally {
        exitSpy.mockRestore()
      }

      expect(consoleLogSpy).toHaveBeenCalledOnce()
      const output = consoleLogSpy.mock.calls[0]?.[0] as string
      const parsed = JSON.parse(output)
      expect(parsed.error).toBe('internal_error')
      expect(parsed.message).toContain('string defect')
      // Note: process.exit is called async after stdout flush - integration tests verify exit behavior
    })
  })
})
