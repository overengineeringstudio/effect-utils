#!/usr/bin/env bun
/**
 * Task System Benchmark Suite
 *
 * Run: bun packages/@overeng/mono/stress-test/run.ts [scenario] [options]
 *
 * Scenarios:
 *   comparison     - Compare baseline vs task system (default)
 *   rapid-events   - High-frequency event stress test
 *   progress-bars  - Visual complexity test
 *   all            - Run all scenarios
 *
 * Options:
 *   --tasks N      - Number of tasks (default: 50)
 *   --events N     - Events per second (default: 1000)
 *   --duration N   - Duration in seconds (default: 10)
 *   --concurrency N - Concurrency limit (default: 8)
 *   --quick        - Quick test (5s, fewer tasks)
 */

import { NodeContext } from '@effect/platform-node'
import { Effect } from 'effect'

import { runComparison } from './scenarios/comparison.ts'
import { runProgressBars } from './scenarios/progress-bars.ts'
import { runRapidEvents } from './scenarios/rapid-events.ts'

const parseArgs = () => {
  const args = process.argv.slice(2)
  const scenario = args.find((a) => !a.startsWith('--')) ?? 'comparison'

  const getArg = (name: string, defaultValue: number): number => {
    const idx = args.findIndex((a) => a === `--${name}`)
    if (idx >= 0 && args[idx + 1]) {
      return parseInt(args[idx + 1], 10)
    }
    return defaultValue
  }

  const quick = args.includes('--quick')

  return {
    scenario,
    taskCount: quick ? 20 : getArg('tasks', 50),
    eventsPerSecond: quick ? 500 : getArg('events', 1000),
    durationSeconds: quick ? 5 : getArg('duration', 10),
    concurrency: getArg('concurrency', 8),
    quick,
  }
}

const printUsage = () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║               TASK SYSTEM BENCHMARK SUITE                         ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║  Usage: bun bench/run.ts [scenario] [options]                     ║
║                                                                   ║
║  Scenarios:                                                       ║
║    comparison     Compare baseline vs task system (default)       ║
║    rapid-events   High-frequency event stress test                ║
║    progress-bars  Visual complexity test                          ║
║    all            Run all scenarios                               ║
║                                                                   ║
║  Options:                                                         ║
║    --tasks N      Number of tasks (default: 50)                   ║
║    --events N     Events per second (default: 1000)               ║
║    --duration N   Duration in seconds (default: 10)               ║
║    --concurrency N Concurrency limit (default: 8)                 ║
║    --quick        Quick test (5s, fewer tasks)                    ║
║                                                                   ║
║  Examples:                                                        ║
║    bun bench/run.ts                      # Quick comparison       ║
║    bun bench/run.ts comparison --quick   # Quick comparison       ║
║    bun bench/run.ts rapid-events         # Event stress test      ║
║    bun bench/run.ts all --duration 30    # Full suite, 30s each   ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
`)
}

const main = Effect.gen(function* () {
  const config = parseArgs()

  if (config.scenario === 'help' || config.scenario === '--help') {
    printUsage()
    return
  }

  console.log('\n╔═══════════════════════════════════════════════════════════════════╗')
  console.log('║               TASK SYSTEM BENCHMARK SUITE                         ║')
  console.log('╠═══════════════════════════════════════════════════════════════════╣')
  console.log(`║  Scenario: ${config.scenario.padEnd(54)}║`)
  console.log(`║  Tasks: ${config.taskCount} │ Events/s: ${config.eventsPerSecond} │ Duration: ${config.durationSeconds}s │ Concurrency: ${config.concurrency}`.padEnd(68) + '║')
  console.log('╚═══════════════════════════════════════════════════════════════════╝')

  const baseConfig = {
    taskCount: config.taskCount,
    eventsPerSecond: config.eventsPerSecond,
    durationSeconds: config.durationSeconds,
    concurrency: config.concurrency,
  }

  switch (config.scenario) {
    case 'comparison':
      yield* runComparison(baseConfig)
      break

    case 'rapid-events':
      yield* runRapidEvents({
        ...baseConfig,
        withRenderer: false,
      })
      yield* Effect.sleep('1 second')
      yield* runRapidEvents({
        ...baseConfig,
        withRenderer: true,
      })
      break

    case 'progress-bars':
      yield* runProgressBars({
        barCount: config.taskCount,
        updateIntervalMs: Math.floor(1000 / (config.eventsPerSecond / config.taskCount)),
        durationSeconds: config.durationSeconds,
        concurrency: config.concurrency,
        withRenderer: false,
      })
      yield* Effect.sleep('1 second')
      yield* runProgressBars({
        barCount: config.taskCount,
        updateIntervalMs: Math.floor(1000 / (config.eventsPerSecond / config.taskCount)),
        durationSeconds: config.durationSeconds,
        concurrency: config.concurrency,
        withRenderer: true,
      })
      break

    case 'all':
      console.log('\n═══ Running all scenarios ═══\n')

      console.log('\n─── Comparison ───')
      yield* runComparison(baseConfig)

      yield* Effect.sleep('2 seconds')

      console.log('\n─── Rapid Events ───')
      yield* runRapidEvents({ ...baseConfig, withRenderer: true })

      yield* Effect.sleep('2 seconds')

      console.log('\n─── Progress Bars ───')
      yield* runProgressBars({
        barCount: config.taskCount,
        updateIntervalMs: 50,
        durationSeconds: config.durationSeconds,
        concurrency: config.concurrency,
        withRenderer: true,
      })

      console.log('\n═══ All scenarios complete ═══')
      break

    default:
      console.error(`Unknown scenario: ${config.scenario}`)
      printUsage()
      process.exit(1)
  }

  console.log('\nBenchmark complete.')
}).pipe(Effect.provide(NodeContext.layer))

Effect.runPromise(main).then(
  () => process.exit(0),
  (err) => {
    console.error('Benchmark failed:', err)
    process.exit(1)
  },
)
