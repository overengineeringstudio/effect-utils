/**
 * Task graph execution with dependency resolution.
 *
 * Uses topological sorting to execute tasks in dependency order,
 * maximizing parallelism where possible.
 */

import { Effect, Exit, Fiber, Option, Stream, SubscriptionRef } from 'effect'

import type { TaskDef, TaskEvent, TaskGraphResult, TaskSystemState } from './types.ts'
import { TaskExecutionError, TaskState, TaskStatus, TaskSystemState as TaskSystemStateClass } from './types.ts'

// =============================================================================
// State Reducer
// =============================================================================

/**
 * Reduce a TaskEvent into the current state.
 * This is a pure function that updates the task state based on events.
 */
const reduceEvent = (state: TaskSystemState, event: TaskEvent<string>): TaskSystemState => {
  const tasks = { ...state.tasks }

  switch (event.type) {
    case 'registered':
      tasks[event.taskId] = new TaskState({
        id: event.taskId,
        name: event.name,
        status: 'pending',
        stdout: [],
        stderr: [],
        startedAt: Option.none(),
        completedAt: Option.none(),
        error: Option.none(),
      })
      break

    case 'started': {
      const task = tasks[event.taskId]
      if (task) {
        tasks[event.taskId] = new TaskState({
          id: task.id,
          name: task.name,
          status: 'running',
          stdout: task.stdout,
          stderr: task.stderr,
          startedAt: Option.some(event.timestamp),
          completedAt: task.completedAt,
          error: task.error,
        })
      }
      break
    }

    case 'stdout': {
      const task = tasks[event.taskId]
      if (task) {
        tasks[event.taskId] = new TaskState({
          id: task.id,
          name: task.name,
          status: task.status,
          stdout: [...task.stdout, event.chunk],
          stderr: task.stderr,
          startedAt: task.startedAt,
          completedAt: task.completedAt,
          error: task.error,
        })
      }
      break
    }

    case 'stderr': {
      const task = tasks[event.taskId]
      if (task) {
        tasks[event.taskId] = new TaskState({
          id: task.id,
          name: task.name,
          status: task.status,
          stdout: task.stdout,
          stderr: [...task.stderr, event.chunk],
          startedAt: task.startedAt,
          completedAt: task.completedAt,
          error: task.error,
        })
      }
      break
    }

    case 'completed': {
      const task = tasks[event.taskId]
      if (task) {
        const isSuccess = Exit.isSuccess(event.exit)
        tasks[event.taskId] = new TaskState({
          id: task.id,
          name: task.name,
          status: isSuccess ? 'success' : 'failed',
          stdout: task.stdout,
          stderr: task.stderr,
          startedAt: task.startedAt,
          completedAt: Option.some(event.timestamp),
          error: isSuccess ? Option.none() : Option.some(String(Exit.isFailure(event.exit) ? event.exit.cause : 'Unknown error')),
        })
      }
      break
    }
  }

  return new TaskSystemStateClass({ tasks })
}

// =============================================================================
// Topological Sort (Dependency Resolution)
// =============================================================================

/**
 * Topologically sort tasks by dependencies.
 * Returns tasks grouped by "levels" where each level can execute in parallel.
 *
 * Example:
 *   A (no deps), B (no deps), C (deps: A, B), D (deps: C)
 *   => [[A, B], [C], [D]]
 */
const topologicalSort = <TId extends string>(
  tasks: ReadonlyArray<TaskDef<TId, unknown, unknown, unknown>>,
): TId[][] => {
  const taskMap = new Map(tasks.map((t) => [t.id, t]))
  const inDegree = new Map<TId, number>()
  const children = new Map<TId, Set<TId>>()

  // Initialize in-degree and children
  for (const task of tasks) {
    inDegree.set(task.id, 0)
    children.set(task.id, new Set())
  }

  // Build dependency graph
  for (const task of tasks) {
    const deps = task.dependencies ?? []
    inDegree.set(task.id, deps.length)
    for (const dep of deps) {
      if (!children.has(dep as TId)) {
        children.set(dep as TId, new Set())
      }
      children.get(dep as TId)!.add(task.id)
    }
  }

  // Find all tasks with no dependencies (in-degree 0)
  const levels: TId[][] = []
  let currentLevel = Array.from(inDegree.entries())
    .filter(([_, degree]) => degree === 0)
    .map(([id]) => id)

  while (currentLevel.length > 0) {
    levels.push(currentLevel)

    const nextLevel: TId[] = []
    for (const taskId of currentLevel) {
      const childSet = children.get(taskId)
      if (childSet) {
        for (const child of childSet) {
          const newDegree = inDegree.get(child)! - 1
          inDegree.set(child, newDegree)
          if (newDegree === 0) {
            nextLevel.push(child)
          }
        }
      }
    }

    currentLevel = nextLevel
  }

  // Check for cycles
  const processedCount = levels.flat().length
  if (processedCount !== tasks.length) {
    throw new Error('Circular dependency detected in task graph')
  }

  return levels
}

// =============================================================================
// Task Executor
// =============================================================================

/**
 * Execute a single task, emitting events to the stream.
 *
 * Flow:
 * 1. Emit 'started' event
 * 2. Run eventStream (emits stdout/stderr events)
 * 3. Run effect if present
 * 4. Emit 'completed' event with exit result
 */
const executeTask = <TId extends string, A, E, R>(
  task: TaskDef<TId, A, E, R>,
  emit: (event: TaskEvent<TId>) => Effect.Effect<void>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    // Emit started event
    yield* emit({ type: 'started', taskId: task.id, timestamp: Date.now() })

    // For command tasks (no effect), just run the stream directly
    // For effect tasks, fork the stream and run effect separately
    let exit: Exit.Exit<unknown, unknown>

    if (task.effect) {
      // Effect task: fork stream and run effect
      const eventStreamFiber = yield* task.eventStream(task.id).pipe(
        Stream.runForEach((event) => emit(event)),
        Effect.fork,
      )

      exit = yield* Effect.exit(task.effect)
      yield* Fiber.await(eventStreamFiber)
    } else {
      // Command task: run stream and capture exit
      // Process events as they arrive (even if stream fails)
      exit = yield* task.eventStream(task.id).pipe(
        Stream.runForEach((event) => {
          if (event !== undefined) {
            return emit(event as TaskEvent<TId>)
          }
          return Effect.void
        }),
        Effect.exit,
      )
    }

    // Emit completed event
    yield* emit({ type: 'completed', taskId: task.id, timestamp: Date.now(), exit })
  })

// =============================================================================
// Task Graph Runner
// =============================================================================

/**
 * Helper to widen task array types for graph execution.
 * This is needed because TypeScript's contravariance check on eventStream
 * is overly strict for our use case (we only call eventStream with exact task.id).
 */
const widenTaskArray = <TId extends string>(
  tasks: ReadonlyArray<TaskDef<any, unknown, unknown, unknown>>,
): ReadonlyArray<TaskDef<TId, unknown, unknown, unknown>> =>
  tasks as unknown as ReadonlyArray<TaskDef<TId, unknown, unknown, unknown>>

/**
 * Execute a graph of tasks with dependency resolution.
 *
 * Tasks are executed in topological order (respecting dependencies),
 * with maximum parallelism at each level.
 *
 * @param tasks - Array of task definitions
 * @param options - Configuration options
 * @param options.onStateChange - Callback for state updates (for rendering)
 * @param options.debounceMs - Debounce interval for state changes (default: 50ms)
 */
export const runTaskGraph = <TId extends string>(
  tasks: ReadonlyArray<TaskDef<any, unknown, unknown, unknown>>,
  options?: {
    onStateChange?: (state: TaskSystemState) => Effect.Effect<void>
    debounceMs?: number
  },
): Effect.Effect<TaskGraphResult, never, any> =>
  Effect.gen(function* () {
    // Widen task types for internal processing
    const wideTasks = widenTaskArray<TId>(tasks)

    // Create state ref
    const stateRef = yield* SubscriptionRef.make(new TaskSystemStateClass({ tasks: {} }))

    // Register all tasks
    for (const task of wideTasks) {
      yield* SubscriptionRef.update(stateRef, (state) =>
        reduceEvent(state, { type: 'registered', taskId: task.id, name: task.name }),
      )
    }

    // Event emitter
    const emit = (event: TaskEvent<TId>) =>
      SubscriptionRef.update(stateRef, (state) => reduceEvent(state, event))

    // Subscribe to state changes for rendering (if provided)
    // Debounce to avoid excessive rendering
    if (options?.onStateChange) {
      const debounceMs = options.debounceMs ?? 50

      yield* stateRef.changes.pipe(
        Stream.debounce(`${debounceMs} millis`),
        Stream.runForEach((state) => options.onStateChange!(state)),
        Effect.fork,
      )
    }

    // Topologically sort tasks
    const levels = topologicalSort(wideTasks)

    // Execute each level in sequence (levels are parallel-safe)
    for (const level of levels) {
      const levelTasks = level.map((taskId) => wideTasks.find((t) => t.id === taskId)!)

      // Execute all tasks in this level concurrently
      yield* Effect.all(
        levelTasks.map((task) => executeTask(task, emit)),
        { concurrency: 'unbounded' },
      )
    }

    // Get final state
    const finalState = yield* SubscriptionRef.get(stateRef)

    // Render final state (ensures last task list is displayed)
    if (options?.onStateChange) {
      yield* options.onStateChange(finalState)
    }

    // Compute result
    const taskStates = Object.values(finalState.tasks)
    const failedTasks = taskStates.filter((t) => t.status === 'failed')
    const successTasks = taskStates.filter((t) => t.status === 'success')

    return {
      state: finalState,
      successCount: successTasks.length,
      failureCount: failedTasks.length,
      failedTaskIds: failedTasks.map((t) => t.id),
    }
  })

/**
 * Execute a task graph and fail if any task fails.
 * Throws TaskExecutionError with details of failed tasks.
 */
export const runTaskGraphOrFail = <TId extends string>(
  tasks: ReadonlyArray<TaskDef<any, unknown, unknown, unknown>>,
  options?: {
    onStateChange?: (state: TaskSystemState) => Effect.Effect<void>
  },
): Effect.Effect<TaskGraphResult, TaskExecutionError, any> =>
  Effect.gen(function* () {
    const result = yield* runTaskGraph(tasks, options)

    if (result.failureCount > 0) {
      return yield* new TaskExecutionError({
        failedTaskIds: result.failedTaskIds,
        message: `${result.failureCount} task(s) failed`,
      })
    }

    return result
  })
