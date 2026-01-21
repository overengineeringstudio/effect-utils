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

    it.effect('does not catch expected failures (Effect.fail)', () =>
      Effect.gen(function* () {
        const effect = withJsonMode({
          json: true,
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

    it.effect('catches defects and outputs JSON error when json=true', () =>
      Effect.gen(function* () {
        // Mock process.exit to prevent test from exiting
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

        try {
          yield* withJsonMode({
            json: true,
            effect: Effect.die(new Error('unexpected crash')),
          })
        } finally {
          exitSpy.mockRestore()
        }

        // Verify JSON error was output
        expect(consoleLogSpy).toHaveBeenCalledOnce()
        const output = consoleLogSpy.mock.calls[0]?.[0] as string
        const parsed = JSON.parse(output)
        expect(parsed.error).toBe('internal_error')
        expect(parsed.message).toContain('unexpected crash')
        // Note: process.exit is called but timing makes it hard to assert in unit tests
        // The integration tests validate the full exit behavior
      }),
    )

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

    it.effect('formats non-Error defects correctly', () =>
      Effect.gen(function* () {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

        try {
          yield* withJsonMode({
            json: true,
            effect: Effect.die('string defect'),
          })
        } finally {
          exitSpy.mockRestore()
        }

        expect(consoleLogSpy).toHaveBeenCalledOnce()
        const output = consoleLogSpy.mock.calls[0]?.[0] as string
        const parsed = JSON.parse(output)
        expect(parsed.error).toBe('internal_error')
        expect(parsed.message).toContain('string defect')
      }),
    )
  })
})
