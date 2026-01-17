/**
 * Task graph execution with dependency resolution.
 *
 * Uses Effect.Graph for dependency management and FiberMap for
 * coordination, maximizing parallelism while respecting dependencies.
 *
 * Architecture (Queue-based for high concurrency):
 * - Task fibers emit events via Queue.offer (lock-free, no contention)
 * - Coordinator fiber dequeues events and updates mutable internal state
 * - Coordinator periodically snapshots state to SubscriptionRef for rendering
 * - Render fiber subscribes to SubscriptionRef changes
 *
 * This eliminates the SubscriptionRef contention that caused 96% overhead
 * when 20+ task fibers competed to update shared state.
 */

import { FileSystem } from '@effect/platform'
import {
  Chunk,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Graph,
  Option,
  Queue,
  Ref,
  Stream,
  SubscriptionRef,
} from 'effect'

import { CircularDependencyError, UnknownDependencyError } from '../errors.ts'
import type { TaskDef, TaskEvent, TaskSystemState } from './types.ts'
import {
  CommandInfo,
  TaskExecutionError,
  TaskState,
  TaskSystemState as TaskSystemStateClass,
} from './types.ts'

// =============================================================================
// State Reducer
// =============================================================================

/**
 * Reduce a TaskEvent into the current state.
 * This is a pure function that updates the task state based on events.
 */
export const reduceEvent = ({
  state,
  event,
}: {
  state: TaskSystemState
  event: TaskEvent<string>
}): TaskSystemState => {
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
        commandInfo: Option.none(),
        retryAttempt: 0,
        maxRetries: Option.none(),
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
          commandInfo: task.commandInfo,
          retryAttempt: task.retryAttempt,
          maxRetries: task.maxRetries,
        })
      }
      break
    }

    case 'retrying': {
      const task = tasks[event.taskId]
      if (task) {
        tasks[event.taskId] = new TaskState({
          id: task.id,
          name: task.name,
          status: 'running',
          stdout: task.stdout,
          stderr: task.stderr,
          startedAt: task.startedAt,
          completedAt: task.completedAt,
          error: task.error,
          commandInfo: task.commandInfo,
          retryAttempt: event.attempt,
          maxRetries: Option.some(event.maxAttempts),
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
          commandInfo: task.commandInfo,
          retryAttempt: task.retryAttempt,
          maxRetries: task.maxRetries,
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
          commandInfo: task.commandInfo,
          retryAttempt: task.retryAttempt,
          maxRetries: task.maxRetries,
        })
      }
      break
    }

    case 'completed': {
      const task = tasks[event.taskId]
      if (task) {
        const isSuccess = Exit.isSuccess(event.exit)

        // Extract command info on failure
        let commandInfo = Option.none<CommandInfo>()
        let exitCode = -1

        if (!isSuccess && Exit.isFailure(event.exit)) {
          // Try to extract exitCode from CommandError in the cause
          const causeString = String(event.exit.cause)
          const exitCodeMatch = causeString.match(/exit code (\d+)/)
          if (exitCodeMatch?.[1]) {
            exitCode = Number.parseInt(exitCodeMatch[1], 10)
          }

          // If we have command context from the event, populate commandInfo
          if (event.commandContext) {
            commandInfo = Option.some(
              new CommandInfo({
                command: event.commandContext.command,
                args: event.commandContext.args,
                cwd: event.commandContext.cwd,
                exitCode,
              }),
            )
          }
        }

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
          commandInfo,
          retryAttempt: task.retryAttempt,
          maxRetries: task.maxRetries,
        })
      }
      break
    }
  }

  return new TaskSystemStateClass({ tasks })
}

/**
 * Mutable state for the coordinator fiber.
 * Uses Map for O(1) lookups and mutations without immutable copying overhead.
 */
interface MutableTaskState {
  id: string
  name: string
  status: 'pending' | 'running' | 'success' | 'failed'
  stdout: string[]
  stderr: string[]
  startedAt: number | undefined
  completedAt: number | undefined
  error: string | undefined
  commandInfo:
    | { command: string; args: readonly string[]; cwd: string; exitCode: number }
    | undefined
  retryAttempt: number
  maxRetries: number | undefined
}

/**
 * Apply event to mutable state (O(1) mutation, no copying).
 * Used by coordinator fiber for efficient state updates.
 */
const applyEventToMutableState = (
  tasks: Map<string, MutableTaskState>,
  event: TaskEvent<string>,
): void => {
  switch (event.type) {
    case 'registered':
      tasks.set(event.taskId, {
        id: event.taskId,
        name: event.name,
        status: 'pending',
        stdout: [],
        stderr: [],
        startedAt: undefined,
        completedAt: undefined,
        error: undefined,
        commandInfo: undefined,
        retryAttempt: 0,
        maxRetries: undefined,
      })
      break

    case 'started': {
      const task = tasks.get(event.taskId)
      if (task) {
        task.status = 'running'
        task.startedAt = event.timestamp
      }
      break
    }

    case 'retrying': {
      const task = tasks.get(event.taskId)
      if (task) {
        task.status = 'running'
        task.retryAttempt = event.attempt
        task.maxRetries = event.maxAttempts
      }
      break
    }

    case 'stdout': {
      const task = tasks.get(event.taskId)
      if (task) {
        task.stdout.push(event.chunk)
      }
      break
    }

    case 'stderr': {
      const task = tasks.get(event.taskId)
      if (task) {
        task.stderr.push(event.chunk)
      }
      break
    }

    case 'completed': {
      const task = tasks.get(event.taskId)
      if (task) {
        const isSuccess = Exit.isSuccess(event.exit)
        task.status = isSuccess ? 'success' : 'failed'
        task.completedAt = event.timestamp

        if (!isSuccess && Exit.isFailure(event.exit)) {
          task.error = String(event.exit.cause)

          const causeString = String(event.exit.cause)
          const exitCodeMatch = causeString.match(/exit code (\d+)/)
          const exitCode = exitCodeMatch?.[1] ? Number.parseInt(exitCodeMatch[1], 10) : -1

          if (event.commandContext) {
            task.commandInfo = {
              command: event.commandContext.command,
              args: event.commandContext.args,
              cwd: event.commandContext.cwd,
              exitCode,
            }
          }
        } else {
          task.error = undefined
        }
      }
      break
    }
  }
}

/**
 * Snapshot mutable state to immutable TaskSystemState for rendering.
 */
const snapshotMutableState = (tasks: Map<string, MutableTaskState>): TaskSystemState => {
  const immutableTasks: Record<string, TaskState> = {}

  for (const [id, task] of tasks) {
    immutableTasks[id] = new TaskState({
      id: task.id,
      name: task.name,
      status: task.status,
      stdout: [...task.stdout],
      stderr: [...task.stderr],
      startedAt: task.startedAt !== undefined ? Option.some(task.startedAt) : Option.none(),
      completedAt: task.completedAt !== undefined ? Option.some(task.completedAt) : Option.none(),
      error: task.error !== undefined ? Option.some(task.error) : Option.none(),
      commandInfo:
        task.commandInfo !== undefined
          ? Option.some(
              new CommandInfo({
                command: task.commandInfo.command,
                args: task.commandInfo.args,
                cwd: task.commandInfo.cwd,
                exitCode: task.commandInfo.exitCode,
              }),
            )
          : Option.none(),
      retryAttempt: task.retryAttempt,
      maxRetries: task.maxRetries !== undefined ? Option.some(task.maxRetries) : Option.none(),
    })
  }

  return new TaskSystemStateClass({ tasks: immutableTasks })
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
const buildTaskGraph = Effect.fn('TaskGraph.buildTaskGraph')(function* <TId extends string>(
  tasks: ReadonlyArray<TaskDef<TId, unknown, unknown, unknown>>,
) {
  const idToIndex = new Map<TId, number>()

  // Collect validation errors during graph building
  let validationError: UnknownDependencyError | undefined

  // Build graph with Effect.Graph
  const graph = Graph.directed<TaskDef<TId, unknown, unknown, unknown>, void>((mutable) => {
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
          validationError = new UnknownDependencyError({
            dependencyId: depId as string,
            taskId: task.id,
          })
          return
        }
        Graph.addEdge(mutable, sourceIndex, targetIndex, undefined)
      }
    }
  })

  // Check for validation error from graph building
  if (validationError) {
    return yield* validationError
  }

  // Validate no cycles
  if (!Graph.isAcyclic(graph)) {
    return yield* new CircularDependencyError({})
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
 * 5. If failed and retry configured, emit 'retrying' and retry
 */
const executeTask = <TId extends string, A, E, R>({
  task,
  emit,
}: {
  task: TaskDef<TId, A, E, R>
  emit: (event: TaskEvent<TId>) => Effect.Effect<void>
}): Effect.Effect<void, unknown, R | FileSystem.FileSystem> => {
  const executeOnce = Effect.gen(function* () {
    const startTime = Date.now()

    // Collect stdout/stderr for log file persistence
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []

    // Wrapper emit that captures stdout/stderr for log file
    const emitWithCapture = (event: TaskEvent<TId>) => {
      if (event.type === 'stdout') {
        stdoutChunks.push(event.chunk)
      } else if (event.type === 'stderr') {
        stderrChunks.push(event.chunk)
      }
      return emit(event)
    }

    // Emit started event
    yield* emit({ type: 'started', taskId: task.id, timestamp: startTime })

    // For command tasks (no effect), just run the stream directly
    // For effect tasks, fork the stream and run effect separately
    let exit: Exit.Exit<unknown, unknown>

    if (task.effect) {
      // Effect task: fork stream and run effect
      const eventStreamFiber = yield* task.eventStream().pipe(
        Stream.runForEach((event) => emitWithCapture(event)),
        Effect.fork,
      )

      exit = yield* Effect.exit(task.effect)
      yield* Fiber.await(eventStreamFiber)
    } else {
      // Command task: run stream and capture exit
      // Process events as they arrive (even if stream fails)
      exit = yield* task.eventStream().pipe(
        Stream.runForEach((event) => {
          if (event !== undefined) {
            return emitWithCapture(event)
          }
          return Effect.void
        }),
        Effect.exit,
      )
    }

    const endTime = Date.now()

    // Emit completed event with commandContext if present
    yield* emit({
      type: 'completed',
      taskId: task.id,
      timestamp: endTime,
      exit,
      ...(task.commandContext !== undefined ? { commandContext: task.commandContext } : {}),
    })

    // Write log file if configured
    if (task.logFile) {
      const fs = yield* FileSystem.FileSystem
      const status = Exit.isSuccess(exit) ? 'success' : 'failed'
      const durationMs = endTime - startTime
      const durationSec = (durationMs / 1000).toFixed(1)

      const logContent = [
        `# Task: ${task.name}`,
        `# Status: ${status}`,
        `# Duration: ${durationSec}s`,
        `# Started: ${new Date(startTime).toISOString()}`,
        '',
        '--- stdout ---',
        stdoutChunks.join(''),
        '',
        '--- stderr ---',
        stderrChunks.join(''),
      ].join('\n')

      yield* fs.writeFileString(task.logFile, logContent).pipe(
        Effect.catchAll((error) => Effect.logWarning(`Failed to write log file ${task.logFile}: ${error}`)),
      )
    }

    return exit
  })

  /**
   * Custom retry wrapper that emits retry events.
   * Effect.retry doesn't give us hooks to emit events, so we implement manual retry loop.
   */
  const executeWithRetry = (attempt: number): Effect.Effect<void, unknown, R | FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(executeOnce)

      if (Exit.isSuccess(exit)) {
        return
      }

      // Task failed - check if we should retry
      if (task.retrySchedule && task.maxRetries && attempt < task.maxRetries) {
        // Emit retry event
        yield* emit({
          type: 'retrying',
          taskId: task.id,
          attempt: attempt + 1,
          maxAttempts: task.maxRetries + 1, // maxAttempts = initial + retries
          timestamp: Date.now(),
        })

        // Apply schedule delay
        yield* Effect.sleep(`${100 * Math.pow(2, attempt)} millis`) // Exponential backoff

        // Retry with incremented attempt
        return yield* executeWithRetry(attempt + 1)
      }

      // No more retries, fail with original error
      if (Exit.isFailure(exit)) {
        return yield* Effect.failCause(exit.cause)
      }
      return yield* Effect.die('Unknown error')
    })

  // Start retry loop if retry schedule configured
  if (task.retrySchedule && task.maxRetries) {
    return executeWithRetry(0)
  }

  return executeOnce.pipe(Effect.asVoid)
}

// =============================================================================
// Task Graph Runner
// =============================================================================

/**
 * Execute a graph of tasks with dependency resolution.
 *
 * Architecture (Queue-based for high concurrency):
 * - Task fibers emit events via Queue.offer (lock-free, no contention)
 * - Coordinator fiber dequeues events and updates mutable internal state
 * - Coordinator periodically snapshots state to SubscriptionRef for rendering
 * - Render fiber subscribes to SubscriptionRef changes
 *
 * This eliminates the SubscriptionRef contention that caused 96% overhead
 * when 20+ task fibers competed to update shared state.
 */
export const runTaskGraph = <TId extends string, R = never>({
  tasks,
  options,
}: {
  tasks: ReadonlyArray<TaskDef<any, unknown, unknown, R>>
  options?:
    | {
        onStateChange?: (state: TaskSystemState) => Effect.Effect<void>
        debounceMs?: number
        concurrency?: number
      }
    | undefined
}): Effect.Effect<
  {
    state: TaskSystemState
    successCount: number
    failureCount: number
    failedTaskIds: TId[]
  },
  Error,
  R | FileSystem.FileSystem
> => {
  const impl = Effect.gen(function* () {
    // Build dependency graph
    const { graph, idToIndex: _idToIndex } = yield* buildTaskGraph(tasks)

    // =========================================================================
    // Queue-based event collection (eliminates SubscriptionRef contention)
    // =========================================================================

    // Event queue: task fibers offer events here (lock-free MPSC)
    const eventQueue = yield* Queue.unbounded<TaskEvent<string>>()

    // Mutable state maintained by coordinator (no contention)
    const mutableTasks = new Map<string, MutableTaskState>()

    // SubscriptionRef for render subscription (only coordinator writes to this)
    const stateRef = yield* SubscriptionRef.make(new TaskSystemStateClass({ tasks: {} }))

    // Flag to signal coordinator to stop
    const coordinatorDone = yield* Ref.make(false)

    // Register all tasks in mutable state
    for (const task of tasks) {
      applyEventToMutableState(mutableTasks, {
        type: 'registered',
        taskId: task.id,
        name: task.name,
      })
    }

    // Initial state snapshot
    yield* SubscriptionRef.set(stateRef, snapshotMutableState(mutableTasks))

    // Event emitter: lock-free Queue.offer (no contention!)
    const emit = (event: TaskEvent<TId>) => Queue.offer(eventQueue, event)

    // =========================================================================
    // Coordinator fiber: dequeues events, updates state, snapshots for render
    // =========================================================================

    const snapshotIntervalMs = options?.debounceMs ?? 50

    const coordinatorFiber = yield* Effect.gen(function* () {
      let lastSnapshotTime = Date.now()

      while (true) {
        // Check if we're done
        const done = yield* Ref.get(coordinatorDone)
        if (done) {
          // Drain remaining events
          const remaining = yield* Queue.takeAll(eventQueue)
          for (const event of Chunk.toReadonlyArray(remaining)) {
            applyEventToMutableState(mutableTasks, event)
          }
          // Final snapshot
          yield* SubscriptionRef.set(stateRef, snapshotMutableState(mutableTasks))
          break
        }

        // Try to take events (non-blocking batch)
        const events = yield* Queue.takeAll(eventQueue)
        const eventArray = Chunk.toReadonlyArray(events)

        // Apply events to mutable state (O(1) per event, no copying)
        for (const event of eventArray) {
          applyEventToMutableState(mutableTasks, event)
        }

        // Snapshot to SubscriptionRef at regular intervals (for render)
        const now = Date.now()
        if (now - lastSnapshotTime >= snapshotIntervalMs || eventArray.length > 0) {
          yield* SubscriptionRef.set(stateRef, snapshotMutableState(mutableTasks))
          lastSnapshotTime = now
        }

        // Yield to other fibers, small sleep to avoid busy-waiting
        yield* Effect.sleep('10 millis')
      }
    }).pipe(Effect.fork)

    // =========================================================================
    // Render subscription (unchanged from original)
    // =========================================================================

    if (options?.onStateChange) {
      const throttleMs = options.debounceMs ?? 50

      yield* stateRef.changes.pipe(
        Stream.throttle({
          cost: () => 1,
          duration: `${throttleMs} millis`,
          units: 1,
          strategy: 'enforce',
        }),
        Stream.runForEach((state) => options.onStateChange!(state)),
        Effect.fork,
      )
    }

    // =========================================================================
    // Task execution (unchanged from original)
    // =========================================================================

    const fiberMap = yield* FiberMap.make<number, void, never>()
    const completionMap = new Map<number, Deferred.Deferred<void, Error>>()

    for (const [nodeIndex] of graph.nodes) {
      const deferred = yield* Deferred.make<void, Error>()
      completionMap.set(nodeIndex, deferred)
    }

    const taskEntries = Array.from(graph.nodes)
    yield* Effect.forEach(
      taskEntries,
      ([nodeIndex, task]) =>
        Effect.gen(function* () {
          const depIndices = Array.from(Graph.neighborsDirected(graph, nodeIndex, 'incoming'))

          yield* FiberMap.run(
            fiberMap,
            nodeIndex,
            Effect.gen(function* () {
              const depDeferreds = depIndices.map((idx) => completionMap.get(idx)!)
              if (depDeferreds.length > 0) {
                yield* Effect.all(depDeferreds.map((d) => Deferred.await(d)))
              }

              yield* executeTask({ task, emit })
              yield* Deferred.succeed(completionMap.get(nodeIndex)!, void 0)
            }).pipe(
              Effect.catchAll((error) =>
                Deferred.fail(completionMap.get(nodeIndex)!, error as Error),
              ),
            ),
          )
        }),
      { concurrency: options?.concurrency ?? 'unbounded' },
    )

    // Wait for all tasks to complete
    yield* FiberMap.awaitEmpty(fiberMap)

    // Signal coordinator to finish and wait for it
    yield* Ref.set(coordinatorDone, true)
    yield* Fiber.await(coordinatorFiber)

    // Get final state
    const finalState = yield* SubscriptionRef.get(stateRef)

    // Render final state
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
      failedTaskIds: failedTasks.map((t) => t.id as TId),
    }
  })

  return Effect.scoped(impl) as Effect.Effect<
    {
      state: TaskSystemState
      successCount: number
      failureCount: number
      failedTaskIds: TId[]
    },
    Error,
    R | FileSystem.FileSystem
  >
}

/**
 * Execute a task graph and fail if any task fails.
 * Throws TaskExecutionError with details of failed tasks.
 */
export const runTaskGraphOrFail = <R = never>({
  tasks,
  options,
}: {
  tasks: ReadonlyArray<TaskDef<any, unknown, unknown, R>>
  options?:
    | {
        onStateChange?: (state: TaskSystemState) => Effect.Effect<void>
        debounceMs?: number
        concurrency?: number
      }
    | undefined
}): Effect.Effect<
  {
    state: TaskSystemState
    successCount: number
    failureCount: number
    failedTaskIds: string[]
  },
  Error | TaskExecutionError,
  R | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const result = yield* runTaskGraph({ tasks, options })

    if (result.failureCount > 0) {
      return yield* new TaskExecutionError({
        failedTaskIds: result.failedTaskIds,
        message: `${result.failureCount} task(s) failed`,
      })
    }

    return result
  }).pipe(Effect.withSpan('TaskGraph.runTaskGraphOrFail'))
