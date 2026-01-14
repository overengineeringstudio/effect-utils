/**
 * Task graph execution with dependency resolution.
 *
 * Uses Effect.Graph for dependency management and FiberMap for
 * coordination, maximizing parallelism while respecting dependencies.
 */

import { Deferred, Effect, Exit, Fiber, FiberMap, Graph, Option, Stream, SubscriptionRef } from 'effect'

import type { TaskDef, TaskEvent, TaskGraphResult, TaskSystemState } from './types.ts'
import { TaskExecutionError, TaskState, TaskSystemState as TaskSystemStateClass } from './types.ts'

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
          error: isSuccess
            ? Option.none()
            : Option.some(String(Exit.isFailure(event.exit) ? event.exit.cause : 'Unknown error')),
        })
      }
      break
    }
  }

  return new TaskSystemStateClass({ tasks })
}

// =============================================================================
// Graph Building (Effect.Graph)
// =============================================================================

/**
 * Build Effect.Graph from task definitions.
 * Returns graph and mapping from task ID to node index.
 *
 * Validates:
 * - No circular dependencies
 * - All dependencies exist
 */
const buildTaskGraph = <TId extends string>(
  tasks: ReadonlyArray<TaskDef<TId, unknown, unknown, unknown>>,
): Effect.Effect<
  { graph: Graph.Graph<TaskDef<TId, unknown, unknown, unknown>, void>; idToIndex: Map<TId, number> },
  Error
> =>
  Effect.gen(function* () {
    const idToIndex = new Map<TId, number>()

    // Build graph with Effect.Graph
    const graph = yield* Effect.try({
      try: () =>
        Graph.directed<TaskDef<TId, unknown, unknown, unknown>, void>((mutable) => {
          // Add all tasks as nodes
          for (const task of tasks) {
            const nodeIndex = Graph.addNode(mutable, task)
            idToIndex.set(task.id, nodeIndex)
          }

          // Add dependency edges
          for (const task of tasks) {
            const targetIndex = idToIndex.get(task.id)!
            const deps = task.dependencies ?? []
            for (const depId of deps) {
              const sourceIndex = idToIndex.get(depId as TId)
              if (sourceIndex === undefined) {
                throw new Error(`Unknown dependency: ${depId}`)
              }
              Graph.addEdge(mutable, sourceIndex, targetIndex, undefined)
            }
          }
        }),
      catch: (error) => error as Error,
    })

    // Validate no cycles
    if (!Graph.isAcyclic(graph)) {
      return yield* Effect.fail(new Error('Circular dependency detected in task graph'))
    }

    return { graph, idToIndex }
  })

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
): Effect.Effect<void, unknown, R> =>
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
 * Uses FiberMap with scoped lifecycle for automatic cleanup.
 * Tasks execute with maximum parallelism while respecting dependencies.
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
): Effect.Effect<TaskGraphResult, Error, any> =>
  Effect.scoped(
    Effect.gen(function* () {
      // Widen task types for internal processing
      const wideTasks = widenTaskArray<TId>(tasks)

      // Build dependency graph
      const { graph, idToIndex } = yield* buildTaskGraph(wideTasks)

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

      // Create FiberMap for task coordination
      const fiberMap = yield* FiberMap.make<number, void, never>()
      const completionMap = new Map<number, Deferred.Deferred<void, Error>>()

      // Create completion deferreds for all tasks
      for (const [nodeIndex] of graph.nodes) {
        const deferred = yield* Deferred.make<void, Error>()
        completionMap.set(nodeIndex, deferred)
      }

      // Fork all tasks with dependency coordination
      for (const [nodeIndex, task] of graph.nodes) {
        // Get dependency node indices
        const depIndices = Array.from(Graph.neighborsDirected(graph, nodeIndex, 'incoming'))

        yield* FiberMap.run(
          fiberMap,
          nodeIndex,
          Effect.gen(function* () {
            // Wait for all dependencies to complete
            const depDeferreds = depIndices.map((idx) => completionMap.get(idx)!)
            if (depDeferreds.length > 0) {
              yield* Effect.all(depDeferreds.map((d) => Deferred.await(d)))
            }

            // Execute the task
            yield* executeTask(task, emit)

            // Signal completion to dependent tasks
            yield* Deferred.succeed(completionMap.get(nodeIndex)!, void 0)
          }).pipe(
            // If task fails, complete deferred with failure
            Effect.catchAll((error) =>
              Deferred.fail(completionMap.get(nodeIndex)!, error as Error),
            ),
          ),
        )
      }

      // Wait for all tasks to complete (or fail)
      yield* FiberMap.awaitEmpty(fiberMap)

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
    }),
  )

/**
 * Execute a task graph and fail if any task fails.
 * Throws TaskExecutionError with details of failed tasks.
 */
export const runTaskGraphOrFail = (
  tasks: ReadonlyArray<TaskDef<any, unknown, unknown, unknown>>,
  options?: {
    onStateChange?: (state: TaskSystemState) => Effect.Effect<void>
  },
): Effect.Effect<TaskGraphResult, TaskExecutionError | Error, any> =>
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
