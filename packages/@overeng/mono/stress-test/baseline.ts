/**
 * Baseline: Pure Effect concurrent execution (no task system overhead)
 *
 * This provides the theoretical minimum overhead for concurrent task execution.
 * Compare this with task system to measure coordination/rendering overhead.
 */

import { Effect, Queue, Stream, SubscriptionRef } from 'effect'
import { timer } from './metrics.ts'

export interface SimulatedEvent {
  taskId: string
  type: 'stdout' | 'stderr' | 'progress'
  data: string
}

export interface BaselineConfig {
  taskCount: number
  eventsPerSecond: number
  durationSeconds: number
  concurrency: number
}

export interface BaselineResult {
  totalEvents: number
  elapsedMs: number
  eventsPerSecond: number
}

/**
 * Run baseline: pure Effect fibers emitting events to a queue
 * No task system, no rendering, just raw concurrent execution
 */
export const runBaseline = (config: BaselineConfig) =>
  Effect.gen(function* () {
    const { taskCount, eventsPerSecond, durationSeconds, concurrency } = config
    const eventsPerTask = eventsPerSecond / taskCount
    const intervalMs = 1000 / eventsPerTask
    const totalEvents = eventsPerSecond * durationSeconds

    const eventQueue = yield* Queue.unbounded<SimulatedEvent>()
    let eventCount = 0

    const startTime = timer.now()
    const endTime = startTime + durationSeconds * 1000

    /** Simulate a single task emitting events */
    const simulateTask = (taskId: string) =>
      Effect.gen(function* () {
        while (timer.now() < endTime) {
          yield* Queue.offer(eventQueue, {
            taskId,
            type: 'stdout',
            data: `Task ${taskId} output line ${eventCount}`,
          })
          eventCount++
          yield* Effect.sleep(`${Math.floor(intervalMs)} millis`)
        }
      })

    /** Consumer that drains events (simulates what renderer would do) */
    const consumer = Effect.gen(function* () {
      while (timer.now() < endTime) {
        const event = yield* Queue.poll(eventQueue)
        if (event._tag === 'Some') {
          // Just consume - no actual rendering
        }
        yield* Effect.yieldNow()
      }
    })

    // Run all tasks concurrently with consumer
    const tasks = Array.from({ length: taskCount }, (_, i) => simulateTask(`task-${i}`))

    yield* Effect.all([...tasks, consumer], { concurrency })

    const elapsedMs = timer.now() - startTime

    return {
      totalEvents: eventCount,
      elapsedMs,
      eventsPerSecond: eventCount / (elapsedMs / 1000),
    } satisfies BaselineResult
  })

/**
 * Run baseline with SubscriptionRef state updates (like task system)
 * This isolates state management overhead
 */
export const runBaselineWithState = (config: BaselineConfig) =>
  Effect.gen(function* () {
    const { taskCount, eventsPerSecond, durationSeconds, concurrency } = config
    const eventsPerTask = eventsPerSecond / taskCount
    const intervalMs = 1000 / eventsPerTask

    interface State {
      events: Map<string, string[]>
      totalCount: number
    }

    const stateRef = yield* SubscriptionRef.make<State>({
      events: new Map(),
      totalCount: 0,
    })

    let stateUpdateCount = 0
    let totalStateUpdateMs = 0

    const startTime = timer.now()
    const endTime = startTime + durationSeconds * 1000

    /** Simulate a single task updating state */
    const simulateTask = (taskId: string) =>
      Effect.gen(function* () {
        while (timer.now() < endTime) {
          const updateStart = timer.now()

          yield* SubscriptionRef.update(stateRef, (state) => {
            const taskEvents = state.events.get(taskId) ?? []
            const newEvents = new Map(state.events)
            newEvents.set(taskId, [...taskEvents, `line ${state.totalCount}`])
            return {
              events: newEvents,
              totalCount: state.totalCount + 1,
            }
          })

          totalStateUpdateMs += timer.now() - updateStart
          stateUpdateCount++

          yield* Effect.sleep(`${Math.floor(intervalMs)} millis`)
        }
      })

    /** Consumer that subscribes to state changes */
    const consumer = Stream.changes(stateRef).pipe(
      Stream.takeUntil(() => Effect.sync(() => timer.now() >= endTime)),
      Stream.runDrain,
    )

    const tasks = Array.from({ length: taskCount }, (_, i) => simulateTask(`task-${i}`))

    yield* Effect.all([...tasks, consumer], { concurrency })

    const finalState = yield* SubscriptionRef.get(stateRef)
    const elapsedMs = timer.now() - startTime

    return {
      totalEvents: finalState.totalCount,
      elapsedMs,
      eventsPerSecond: finalState.totalCount / (elapsedMs / 1000),
      stateUpdateCount,
      avgStateUpdateMs: totalStateUpdateMs / stateUpdateCount,
    }
  })
