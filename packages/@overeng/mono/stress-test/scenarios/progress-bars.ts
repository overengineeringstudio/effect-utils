/**
 * Progress Bars Scenario
 *
 * Tests rendering many animated progress bars with simulated progress updates.
 * Each bar updates at staggered intervals to test visual complexity.
 *
 * Tests: string width calculation, ANSI rendering, differential updates
 */

import { NodeContext } from '@effect/platform-node'
import { Effect, Logger, LogLevel } from 'effect'

import { task } from '../../src/task-system/api.ts'
import { runTaskGraph } from '../../src/task-system/graph.ts'
import { piTuiInlineRenderer } from '../../src/task-system/renderers/pi-tui-inline.ts'
import { MetricsTracker, timer } from '../metrics.ts'
import { renderMetricsLine } from '../reporters/live-metrics.ts'

export interface ProgressBarsConfig {
  barCount: number
  updateIntervalMs: number
  durationSeconds: number
  concurrency: number
  withRenderer: boolean
}

const defaultConfig: ProgressBarsConfig = {
  barCount: 50,
  updateIntervalMs: 50,
  durationSeconds: 15,
  concurrency: 8,
  withRenderer: true,
}

/**
 * Create simulated tasks that emit progress-style output
 */
const createProgressTasks = (config: ProgressBarsConfig) => {
  return Array.from({ length: config.barCount }, (_, i) => {
    const taskId = `progress-${i}`
    // Stagger update intervals slightly for realistic load
    const interval = config.updateIntervalMs + (i % 10) * 5

    return task({
      id: taskId,
      name: `Download ${i}`,
      effect: Effect.gen(function* () {
        const endTime = timer.now() + config.durationSeconds * 1000
        let progress = 0
        const totalSize = 100 + Math.random() * 400 // 100-500 MB simulated

        while (timer.now() < endTime && progress < 100) {
          // Simulate varying download speeds
          const speed = 1 + Math.random() * 5 // 1-6 MB/s
          progress = Math.min(100, progress + speed / (1000 / interval))

          const downloadedMB = (totalSize * progress) / 100
          const eta = progress > 0 ? (100 - progress) / (speed / (1000 / interval)) / 1000 : 0

          // Emit progress line
          yield* Effect.log(
            `[${progress.toFixed(0).padStart(3)}%] ` +
              `${downloadedMB.toFixed(1).padStart(6)}MB / ${totalSize.toFixed(1)}MB ` +
              `@ ${speed.toFixed(1)}MB/s ` +
              `ETA: ${eta.toFixed(0)}s`,
          )

          yield* Effect.sleep(`${interval} millis`)
        }

        return { taskId, finalProgress: progress }
      }),
    })
  })
}

/**
 * Run the progress-bars scenario
 */
export const runProgressBars = (userConfig: Partial<ProgressBarsConfig> = {}) =>
  Effect.gen(function* () {
    const config = { ...defaultConfig, ...userConfig }
    const metrics = new MetricsTracker()

    console.log('\n┌─────────────────────────────────────────────────────────┐')
    console.log(
      `│ PROGRESS BARS: ${config.barCount} bars × ${config.updateIntervalMs}ms interval × ${config.durationSeconds}s │`,
    )
    console.log(
      `│ Concurrency: ${config.concurrency} │ Renderer: ${config.withRenderer ? 'ON' : 'OFF'}`.padEnd(
        60,
      ) + '│',
    )
    console.log('├─────────────────────────────────────────────────────────┤')

    const tasks = createProgressTasks(config)
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
    console.log('Running Progress Bars Scenario...')

    // First run without renderer (baseline)
    console.log('\n=== Without Renderer ===')
    yield* runProgressBars({ withRenderer: false, durationSeconds: 5, barCount: 20 })

    yield* Effect.sleep('1 second')

    // Then with renderer
    console.log('\n=== With Renderer ===')
    yield* runProgressBars({ withRenderer: true, durationSeconds: 5, barCount: 20 })
  }).pipe(Effect.provide(NodeContext.layer))

  Effect.runPromise(main).then(
    () => process.exit(0),
    (err) => {
      console.error(err)
      process.exit(1)
    },
  )
}
