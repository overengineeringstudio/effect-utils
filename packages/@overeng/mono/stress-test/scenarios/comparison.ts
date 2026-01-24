/**
 * Direct Comparison Scenario (Critical)
 *
 * Compares task system vs baseline using simulated workloads:
 * 1. Baseline: Pure Effect fiber scheduling (no task system)
 * 2. Task System without renderer (coordination overhead only)
 * 3. Task System with renderer (full overhead)
 *
 * This proves whether the overhead is from Effect, coordination, or rendering.
 */

import { NodeContext } from '@effect/platform-node'
import { Effect, Logger, LogLevel, Queue } from 'effect'

import { task } from '../../src/task-system/api.ts'
import { runTaskGraph } from '../../src/task-system/graph.ts'
import { piTuiInlineRenderer } from '../../src/task-system/renderers/pi-tui-inline.ts'
import { timer } from '../metrics.ts'

/** Configuration for comparison benchmark */
export interface ComparisonConfig {
  taskCount: number
  eventsPerSecond: number
  durationSeconds: number
  concurrency: number
}

const defaultConfig: ComparisonConfig = {
  taskCount: 50,
  eventsPerSecond: 1000,
  durationSeconds: 10,
  concurrency: 8,
}

interface RunResult {
  elapsedMs: number
  totalEvents: number
  eventsPerSecond: number
}

/**
 * Mode 1: Pure Effect baseline (no task system at all)
 */
const runPureBaseline = (config: ComparisonConfig): Effect.Effect<RunResult> =>
  Effect.gen(function* () {
    const eventsPerTask = config.eventsPerSecond / config.taskCount
    const intervalMs = Math.max(1, Math.floor(1000 / eventsPerTask))

    const eventQueue = yield* Queue.unbounded<{
      taskId: string
      data: string
    }>()
    let totalEvents = 0

    const startTime = timer.now()
    const endTime = startTime + config.durationSeconds * 1000

    const simulateTask = (taskId: string) =>
      Effect.gen(function* () {
        while (timer.now() < endTime) {
          yield* Queue.offer(eventQueue, {
            taskId,
            data: `Event ${totalEvents}`,
          })
          totalEvents++
          yield* Effect.sleep(`${intervalMs} millis`)
        }
      })

    // Consumer that drains events
    const consumer = Effect.gen(function* () {
      while (timer.now() < endTime) {
        yield* Queue.poll(eventQueue)
        yield* Effect.yieldNow()
      }
    })

    const tasks = Array.from({ length: config.taskCount }, (_, i) => simulateTask(`task-${i}`))

    yield* Effect.all([...tasks, consumer], {
      concurrency: config.concurrency + 1,
    })

    const elapsedMs = timer.now() - startTime

    return {
      elapsedMs,
      totalEvents,
      eventsPerSecond: totalEvents / (elapsedMs / 1000),
    }
  })

/**
 * Mode 2: Task system without renderer
 */
const runTaskSystemNoRenderer = (config: ComparisonConfig): Effect.Effect<RunResult> =>
  Effect.gen(function* () {
    const eventsPerTask = config.eventsPerSecond / config.taskCount
    const intervalMs = Math.max(1, Math.floor(1000 / eventsPerTask))

    const endTime = timer.now() + config.durationSeconds * 1000

    const tasks = Array.from({ length: config.taskCount }, (_, i) =>
      task({
        id: `task-${i}`,
        name: `Task ${i}`,
        effect: Effect.gen(function* () {
          let eventCount = 0
          while (timer.now() < endTime) {
            yield* Effect.log(`Event ${eventCount}`)
            eventCount++
            yield* Effect.sleep(`${intervalMs} millis`)
          }
          return { eventCount }
        }),
      }),
    )

    let stateChanges = 0
    const startTime = timer.now()

    yield* runTaskGraph({
      tasks,
      options: {
        concurrency: config.concurrency,
        onStateChange: () =>
          Effect.sync(() => {
            stateChanges++
          }),
      },
    }).pipe(Logger.withMinimumLogLevel(LogLevel.None))

    const elapsedMs = timer.now() - startTime

    return {
      elapsedMs,
      totalEvents: stateChanges,
      eventsPerSecond: stateChanges / (elapsedMs / 1000),
    }
  })

/**
 * Mode 3: Task system with full renderer
 */
const runTaskSystemWithRenderer = (config: ComparisonConfig): Effect.Effect<RunResult> =>
  Effect.gen(function* () {
    const eventsPerTask = config.eventsPerSecond / config.taskCount
    const intervalMs = Math.max(1, Math.floor(1000 / eventsPerTask))

    const endTime = timer.now() + config.durationSeconds * 1000

    const tasks = Array.from({ length: config.taskCount }, (_, i) =>
      task({
        id: `task-${i}`,
        name: `Task ${i}`,
        effect: Effect.gen(function* () {
          let eventCount = 0
          while (timer.now() < endTime) {
            yield* Effect.log(`Event ${eventCount}`)
            eventCount++
            yield* Effect.sleep(`${intervalMs} millis`)
          }
          return { eventCount }
        }),
      }),
    )

    let stateChanges = 0
    const startTime = timer.now()
    const renderer = piTuiInlineRenderer()

    const result = yield* runTaskGraph({
      tasks,
      options: {
        concurrency: config.concurrency,
        onStateChange: (state) =>
          Effect.gen(function* () {
            stateChanges++
            yield* renderer.render(state)
          }),
      },
    }).pipe(Logger.withMinimumLogLevel(LogLevel.None))

    yield* renderer.renderFinal(result.state)

    const elapsedMs = timer.now() - startTime

    return {
      elapsedMs,
      totalEvents: stateChanges,
      eventsPerSecond: stateChanges / (elapsedMs / 1000),
    }
  })

/**
 * Run the full comparison
 */
export const runComparison = (userConfig: Partial<ComparisonConfig> = {}) =>
  Effect.gen(function* () {
    const config = { ...defaultConfig, ...userConfig }

    console.log('\n╔═════════════════════════════════════════════════════════════════╗')
    console.log(
      `║ COMPARISON: ${config.taskCount} tasks × ${config.eventsPerSecond} events/s × ${config.durationSeconds}s (simulated)`.padEnd(
        66,
      ) + '║',
    )
    console.log(`║ Concurrency: ${config.concurrency}`.padEnd(66) + '║')
    console.log('╠═════════════════════════════════════════════════════════════════╣')

    // Run baseline
    console.log('║ Running baseline (pure Effect)...'.padEnd(66) + '║')
    const baseline = yield* runPureBaseline(config)
    console.log(
      `║   ✓ Completed in ${(baseline.elapsedMs / 1000).toFixed(2)}s - ${baseline.totalEvents.toLocaleString()} events`.padEnd(
        66,
      ) + '║',
    )

    yield* Effect.sleep('500 millis')

    // Run task system without renderer
    console.log('║ Running task system (no renderer)...'.padEnd(66) + '║')
    const noRenderer = yield* runTaskSystemNoRenderer(config)
    const noRendererOverhead =
      ((noRenderer.elapsedMs - baseline.elapsedMs) / baseline.elapsedMs) * 100
    console.log(
      `║   ✓ Completed in ${(noRenderer.elapsedMs / 1000).toFixed(2)}s - overhead: ${noRendererOverhead.toFixed(1)}%`.padEnd(
        66,
      ) + '║',
    )

    yield* Effect.sleep('500 millis')

    // Run task system with renderer
    console.log('║ Running task system (with renderer)...'.padEnd(66) + '║')
    const withRenderer = yield* runTaskSystemWithRenderer(config)
    const withRendererOverhead =
      ((withRenderer.elapsedMs - baseline.elapsedMs) / baseline.elapsedMs) * 100
    console.log(
      `║   ✓ Completed in ${(withRenderer.elapsedMs / 1000).toFixed(2)}s - overhead: ${withRendererOverhead.toFixed(1)}%`.padEnd(
        66,
      ) + '║',
    )

    // Summary
    console.log('╠═════════════════════════════════════════════════════════════════╣')
    console.log('║ SUMMARY:'.padEnd(66) + '║')
    console.log(
      `║   Baseline:             ${(baseline.elapsedMs / 1000).toFixed(2)}s (reference)`.padEnd(
        66,
      ) + '║',
    )
    console.log(
      `║   Task System (no UI):  ${(noRenderer.elapsedMs / 1000).toFixed(2)}s (+${noRendererOverhead.toFixed(1)}% overhead)`.padEnd(
        66,
      ) + '║',
    )
    console.log(
      `║   Task System (full):   ${(withRenderer.elapsedMs / 1000).toFixed(2)}s (+${withRendererOverhead.toFixed(1)}% overhead)`.padEnd(
        66,
      ) + '║',
    )
    console.log('║'.padEnd(66) + '║')

    const coordOverhead = noRendererOverhead
    const renderOverhead = withRendererOverhead - noRendererOverhead

    console.log(`║   Coordination overhead: ${coordOverhead.toFixed(1)}%`.padEnd(66) + '║')
    console.log(`║   Rendering overhead:    ${renderOverhead.toFixed(1)}%`.padEnd(66) + '║')
    console.log(`║   TOTAL overhead:        ${withRendererOverhead.toFixed(1)}%`.padEnd(66) + '║')

    const target = 10
    const status = withRendererOverhead <= target ? '✓ PASS' : '✗ FAIL'
    console.log(`║   Target: <${target}% │ Status: ${status}`.padEnd(66) + '║')
    console.log('╚═════════════════════════════════════════════════════════════════╝')

    return {
      config,
      baseline,
      noRenderer: { ...noRenderer, overhead: noRendererOverhead },
      withRenderer: { ...withRenderer, overhead: withRendererOverhead },
      coordOverhead,
      renderOverhead,
      totalOverhead: withRendererOverhead,
      passed: withRendererOverhead <= target,
    }
  })

/** Standalone runner */
if (import.meta.main) {
  const main = Effect.gen(function* () {
    console.log('Running Comparison Scenario...')

    // Quick run for testing
    yield* runComparison({
      taskCount: 20,
      eventsPerSecond: 500,
      durationSeconds: 5,
    })
  }).pipe(Effect.provide(NodeContext.layer))

  Effect.runPromise(main).then(
    () => process.exit(0),
    (err) => {
      console.error(err)
      process.exit(1)
    },
  )
}
