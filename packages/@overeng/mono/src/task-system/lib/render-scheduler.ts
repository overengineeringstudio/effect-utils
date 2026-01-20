/**
 * Effect-based render scheduler for pi-tui.
 *
 * Replaces pi-tui's process.nextTick-based requestRender() with an Effect-native
 * approach that works correctly within Effect's fiber scheduler.
 *
 * Features:
 * - Fixed interval rendering (default 80ms for smooth spinner animation)
 * - Coalesces multiple render requests into single render
 * - Properly yields to Effect scheduler
 */

import type { TUI } from '@mariozechner/pi-tui'
import { Effect, Fiber, Ref } from 'effect'

/**
 * Render scheduler configuration.
 */
export interface RenderSchedulerConfig {
  /** Render interval in milliseconds (default: 80ms for smooth animation) */
  readonly intervalMs?: number
}

/**
 * Render scheduler handle returned by make().
 */
export interface RenderScheduler {
  /** Request a render (will be coalesced with pending requests) */
  readonly requestRender: () => Effect.Effect<void>
  /** Force immediate render (bypasses coalescing) */
  readonly forceRender: () => Effect.Effect<void>
  /** Stop the render loop */
  readonly stop: () => Effect.Effect<void>
}

/**
 * Trigger a render via pi-tui's requestRender.
 *
 * Pi-tui's requestRender() schedules a render via process.nextTick.
 * The Node.js event loop processes these callbacks during Effect.sleep pauses,
 * which happen after each render loop iteration.
 *
 * Note: Effect.yieldNow() is NOT used here because it only yields to other
 * runnable Effect fibers, not to the Node.js event loop. Using Effect.sleep
 * in the main render loop properly yields to the event loop.
 */
const triggerRender = (tui: TUI): Effect.Effect<void> => Effect.sync(() => tui.requestRender())

/**
 * Create a render scheduler for a pi-tui TUI instance.
 *
 * The scheduler runs a background fiber that renders at a fixed interval.
 * Render requests are coalesced - if multiple requests come in during one
 * interval, only one render occurs.
 *
 * Usage:
 * ```ts
 * const scheduler = yield* RenderScheduler.make(tui, { intervalMs: 80 });
 * yield* scheduler.requestRender();
 * // ... later
 * yield* scheduler.stop();
 * ```
 */
export const make = Effect.fn('RenderScheduler/make')(function* (
  tui: TUI,
  config: RenderSchedulerConfig = {},
) {
  const intervalMs = config.intervalMs ?? 80

  // Track if render is needed
  const renderNeeded = yield* Ref.make(true) // Start with true for initial render

  // Render loop: check if render needed, render, wait interval
  const renderLoop = Effect.gen(function* () {
    const needed = yield* Ref.getAndSet(renderNeeded, false)
    if (needed) {
      yield* triggerRender(tui)
    }
    yield* Effect.sleep(`${intervalMs} millis`)
  }).pipe(Effect.forever)

  // Start render loop in background fiber
  const fiber = yield* Effect.fork(renderLoop)

  // Ensure fiber is interrupted when scope closes
  yield* Effect.addFinalizer(() => Fiber.interrupt(fiber))

  return {
    requestRender: () => Ref.set(renderNeeded, true),
    forceRender: Effect.fnUntraced(function* () {
      yield* Ref.set(renderNeeded, false)
      yield* triggerRender(tui)
    }),
    stop: () => Fiber.interrupt(fiber),
  } satisfies RenderScheduler
})

/**
 * RenderScheduler module.
 */
export const RenderScheduler = { make }
