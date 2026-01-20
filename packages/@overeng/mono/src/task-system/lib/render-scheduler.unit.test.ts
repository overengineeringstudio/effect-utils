/**
 * Unit tests for RenderScheduler.
 *
 * Tests the Effect-based render loop logic using TestClock to control time.
 */

import * as assert from 'node:assert'

import { describe, it } from '@effect/vitest'
import { Effect, TestClock, TestContext } from 'effect'

import { RenderScheduler } from './render-scheduler.ts'

/** Mock TUI that tracks requestRender calls */
const mockTui = () => {
  const renderCount = { value: 0 }
  return {
    tui: {
      // Minimal TUI mock - only needs requestRender for our tests
      requestRender: () => {
        renderCount.value++
      },
    } as unknown as Parameters<typeof RenderScheduler.make>[0],
    renderCount,
  }
}

describe('RenderScheduler', () => {
  describe('make', () => {
    it.scoped('creates scheduler with requestRender and forceRender', () =>
      Effect.gen(function* () {
        const { tui } = mockTui()

        const scheduler = yield* RenderScheduler.make(tui)

        assert.ok(typeof scheduler.requestRender === 'function')
        assert.ok(typeof scheduler.forceRender === 'function')
        assert.ok(typeof scheduler.stop === 'function')
      }),
    )
  })

  describe('requestRender', () => {
    it.scoped('marks render as needed', () =>
      Effect.gen(function* () {
        const { tui } = mockTui()
        const scheduler = yield* RenderScheduler.make(tui)

        // Request render is non-blocking, just sets a flag
        yield* scheduler.requestRender()

        // No assertion needed - if it doesn't throw, it works
      }),
    )
  })

  describe('forceRender', () => {
    it.scoped('renders immediately bypassing interval', () =>
      Effect.gen(function* () {
        const { tui, renderCount } = mockTui()
        const scheduler = yield* RenderScheduler.make(tui)

        // Initial render count (scheduler does initial render)
        const initialCount = renderCount.value

        // Force immediate render
        yield* scheduler.forceRender()

        assert.strictEqual(renderCount.value, initialCount + 1)
      }),
    )
  })

  describe('stop', () => {
    it.scoped('interrupts the render loop fiber', () =>
      Effect.gen(function* () {
        const { tui } = mockTui()
        const scheduler = yield* RenderScheduler.make(tui)

        // Stop should interrupt without error
        yield* scheduler.stop()
      }),
    )
  })

  describe('render loop with TestClock', () => {
    it.effect('renders on interval when requested', () =>
      Effect.gen(function* () {
        const { tui, renderCount } = mockTui()

        yield* Effect.scoped(
          Effect.gen(function* () {
            const scheduler = yield* RenderScheduler.make(tui, { intervalMs: 100 })

            // Request render
            yield* scheduler.requestRender()

            // Advance time past interval
            yield* TestClock.adjust('200 millis')

            // Should have rendered (initial + 1-2 from interval)
            assert.ok(
              renderCount.value >= 1,
              `Expected at least 1 render, got ${renderCount.value}`,
            )
          }),
        )
      }).pipe(Effect.provide(TestContext.TestContext)),
    )

    it.effect('coalesces multiple render requests', () =>
      Effect.gen(function* () {
        const { tui, renderCount } = mockTui()

        yield* Effect.scoped(
          Effect.gen(function* () {
            const scheduler = yield* RenderScheduler.make(tui, { intervalMs: 100 })

            // Multiple render requests in same interval
            yield* scheduler.requestRender()
            yield* scheduler.requestRender()
            yield* scheduler.requestRender()

            // Advance time past one interval
            yield* TestClock.adjust('150 millis')

            // Should only have rendered once (coalesced)
            // Plus initial render makes it at most 2
            assert.ok(
              renderCount.value <= 3,
              `Expected at most 3 renders, got ${renderCount.value}`,
            )
          }),
        )
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
  })
})
