/**
 * Rapid Events Scenario
 *
 * Stress tests the event accumulation bottleneck by simulating many tasks
 * each emitting events at high frequency.
 *
 * Expected to expose O(n²) array copy overhead in reduceEvent.
 */

import { NodeContext } from '@effect/platform-node'
import { Effect, Logger, LogLevel } from 'effect'

import { task } from '../../src/task-system/api.ts'
import { runTaskGraph } from '../../src/task-system/graph.ts'
import { piTuiInlineRenderer } from '../../src/task-system/renderers/pi-tui-inline.ts'
import { MetricsTracker, timer } from '../metrics.ts'
import { renderMetricsLine } from '../reporters/live-metrics.ts'

/** Configuration for rapid events stress test scenario */
export interface RapidEventsConfig {
  taskCount: number
  eventsPerSecond: number
  durationSeconds: number
  concurrency: number
  withRenderer: boolean
}

const defaultConfig: RapidEventsConfig = {
  taskCount: 50,
  eventsPerSecond: 100,
  durationSeconds: 10,
  concurrency: 8,
  withRenderer: true,
}

/**
 * Create simulated tasks that emit events via Effect.log (captured as output)
 */
const createSimulatedTasks = (config: RapidEventsConfig) => {
  const eventsPerTask = config.eventsPerSecond / config.taskCount
  const intervalMs = Math.max(1, Math.floor(1000 / eventsPerTask))

  return Array.from({ length: config.taskCount }, (_, i) => {
    const taskId = `sim-${i}`

    return task({
      id: taskId,
      name: `Simulated Task ${i}`,
      effect: Effect.gen(function* () {
        const endTime = timer.now() + config.durationSeconds * 1000
        let eventCount = 0

        while (timer.now() < endTime) {
          // Emit output that gets captured as stdout
          yield* Effect.log(`[${taskId}] Event ${eventCount}: ${Date.now()}`)
          eventCount++
          yield* Effect.sleep(`${intervalMs} millis`)
        }

        return { taskId, eventCount }
      }),
    })
  })
}

/**
 * Run the rapid-events scenario
 */
export const runRapidEvents = (userConfig: Partial<RapidEventsConfig> = {}) =>
  Effect.gen(function* () {
    const config = { ...defaultConfig, ...userConfig }
    const metrics = new MetricsTracker()

    console.log('\n┌─────────────────────────────────────────────────────────┐')
    console.log(
      `│ RAPID EVENTS: ${config.taskCount} tasks × ${config.eventsPerSecond} events/s × ${config.durationSeconds}s │`,
    )
    console.log(
      `│ Concurrency: ${config.concurrency} │ Renderer: ${config.withRenderer ? 'ON' : 'OFF'}`.padEnd(
        60,
      ) + '│',
    )
    console.log('├─────────────────────────────────────────────────────────┤')

    const tasks = createSimulatedTasks(config)
    const startTime = timer.now()

    let stateChangeCount = 0
    let renderCount = 0
    let lastMetricsUpdate = startTime

    const renderer = config.withRenderer ? piTuiInlineRenderer() : null

    const result = yield* runTaskGraph({
      tasks,
      options: {
        concurrency: config.concurrency,
        onStateChange: (state) =>
          Effect.gen(function* () {
            const updateStart = timer.now()
            stateChangeCount++
            metrics.recordEvent()

            if (renderer) {
              const renderStart = timer.now()
              yield* renderer.render(state)
              metrics.recordRender(timer.now() - renderStart)
              renderCount++
            }

            metrics.recordStateUpdate(timer.now() - updateStart)
            metrics.endFrame()
            metrics.startFrame()

            // Update metrics display periodically
            const now = timer.now()
            if (now - lastMetricsUpdate > 500) {
              metrics.tick()
              const m = metrics.getMetrics()
              process.stdout.write(`\r${renderMetricsLine(m)}`)
              lastMetricsUpdate = now
            }
          }),
      },
    }).pipe(Logger.withMinimumLogLevel(LogLevel.None))

    if (renderer) {
      yield* renderer.renderFinal(result.state)
    }

    const elapsedMs = timer.now() - startTime
    const finalMetrics = metrics.getMetrics()

    console.log('\n├─────────────────────────────────────────────────────────┤')
    console.log(`│ RESULTS:`.padEnd(60) + '│')
    console.log(`│   Elapsed: ${(elapsedMs / 1000).toFixed(2)}s`.padEnd(60) + '│')
    console.log(`│   State changes: ${stateChangeCount.toLocaleString()}`.padEnd(60) + '│')
    console.log(`│   Render calls: ${renderCount.toLocaleString()}`.padEnd(60) + '│')
    console.log(
      `│   Success: ${result.successCount}, Failed: ${result.failureCount}`.padEnd(60) + '│',
    )
    console.log(
      `│   Avg state update: ${finalMetrics.stateUpdateTimeMs.toFixed(2)}ms`.padEnd(60) + '│',
    )
    console.log(`│   Avg render time: ${finalMetrics.renderTimeMs.toFixed(2)}ms`.padEnd(60) + '│')
    console.log(`│   Peak memory: ${finalMetrics.memoryMB.toFixed(1)}MB`.padEnd(60) + '│')
    console.log('└─────────────────────────────────────────────────────────┘')

    return {
      config,
      elapsedMs,
      stateChangeCount,
      renderCount,
      finalMetrics,
      result,
    }
  })

/** Standalone runner */
if (import.meta.main) {
  const main = Effect.gen(function* () {
    console.log('Running Rapid Events Scenario...')

    // First run without renderer (baseline)
    console.log('\n=== Without Renderer ===')
    yield* runRapidEvents({ withRenderer: false, durationSeconds: 5 })

    yield* Effect.sleep('1 second')

    // Then with renderer
    console.log('\n=== With Renderer ===')
    yield* runRapidEvents({ withRenderer: true, durationSeconds: 5 })
  }).pipe(Effect.provide(NodeContext.layer))

  Effect.runPromise(main).then(
    () => process.exit(0),
    (err) => {
      console.error(err)
      process.exit(1)
    },
  )
}
