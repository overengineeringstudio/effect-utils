/**
 * TaskRunner: Concurrent task execution with structured state management.
 *
 * Decouples task execution from output rendering, enabling:
 * - Concurrent task execution without interleaved logs
 * - Real-time status updates via SubscriptionRef
 * - Structured output for TUI rendering (opentui, etc.)
 *
 * @example
 * ```ts
 * import { TaskRunner, printFinalSummary } from '@overeng/utils/node'
 * import { Effect, Stream } from 'effect'
 *
 * const program = Effect.gen(function* () {
 *   const runner = yield* TaskRunner
 *
 *   // Register tasks upfront
 *   yield* runner.register({ id: 'build', name: 'Build project' })
 *   yield* runner.register({ id: 'test', name: 'Run tests' })
 *
 *   // Start render loop in background (optional)
 *   yield* runner.changes.pipe(
 *     Stream.debounce('50 millis'),
 *     Stream.runForEach(() =>
 *       Effect.gen(function* () {
 *         const output = yield* runner.render()
 *         process.stdout.write('\x1B[2J\x1B[H' + output + '\n')
 *       })
 *     ),
 *     Effect.fork
 *   )
 *
 *   // Run tasks concurrently
 *   yield* runner.runAll([
 *     runner.runTask({ id: 'build', command: 'npm', args: ['run', 'build'] }),
 *     runner.runTask({ id: 'test', command: 'npm', args: ['test'] }),
 *   ])
 *
 *   // Print summary and fail if any task failed
 *   yield* printFinalSummary
 * }).pipe(Effect.provide(TaskRunner.live))
 * ```
 *
 * @module
 */

import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import type { PlatformError } from '@effect/platform/Error'
import * as Ansi from '@effect/printer-ansi/Ansi'
import * as AnsiDoc from '@effect/printer-ansi/AnsiDoc'
import * as Doc from '@effect/printer/Doc'
import {
  Chunk,
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect'

import { unicodeSymbols } from '@overeng/tui-core'
import { cmdStart } from './cmd.ts'
import { CurrentWorkingDirectory } from './workspace.ts'

/** Render an ANSI-annotated document to a string */
const renderAnsiDoc = (doc: Doc.Doc<Ansi.Ansi>): string => AnsiDoc.render(doc, { style: 'pretty' })

// -----------------------------------------------------------------------------
// Task State Schema
// -----------------------------------------------------------------------------

const TaskStatus = Schema.Literal('pending', 'running', 'success', 'failed')

/** Status of a task in the runner. */
export type TaskStatus = typeof TaskStatus.Type

/**
 * State of an individual task being executed by the TaskRunner.
 * Contains task metadata, execution status, and captured output.
 */
export class TaskState extends Schema.Class<TaskState>('TaskState')({
  /** Unique identifier for the task */
  id: Schema.String,
  /** Human-readable task name for display */
  name: Schema.String,
  /** Current execution status */
  status: TaskStatus,
  /** Buffered stdout lines captured during execution */
  stdout: Schema.Array(Schema.String),
  /** Buffered stderr lines captured during execution */
  stderr: Schema.Array(Schema.String),
  /** Start timestamp in milliseconds since epoch */
  startedAt: Schema.OptionFromNullOr(Schema.Number),
  /** Duration in milliseconds (set on completion) */
  duration: Schema.OptionFromNullOr(Schema.Number),
  /** Error message if task failed */
  error: Schema.OptionFromNullOr(Schema.String),
}) {}

/**
 * Complete state of the TaskRunner, containing all registered tasks.
 */
export class TaskRunnerState extends Schema.Class<TaskRunnerState>('TaskRunnerState')({
  /** All registered tasks */
  tasks: Schema.Array(TaskState),
}) {}

const initialState = new TaskRunnerState({ tasks: [] })

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Error returned when one or more tasks failed during execution.
 * Contains the IDs of all failed tasks for inspection.
 */
export class TasksFailedError extends Schema.TaggedError<TasksFailedError>()('TasksFailedError', {
  /** IDs of all tasks that failed */
  failedTaskIds: Schema.Array(Schema.String),
  /** Human-readable error message */
  message: Schema.String,
}) {}

// -----------------------------------------------------------------------------
// TaskRunner Service
// -----------------------------------------------------------------------------

type TaskRunnerService = {
  /** Stream of state changes for rendering */
  readonly changes: SubscriptionRef.SubscriptionRef<TaskRunnerState>['changes']
  /** Get current snapshot of state */
  readonly get: Effect.Effect<TaskRunnerState>
  /** Register a task (sets to pending) */
  readonly register: (opts: { id: string; name: string }) => Effect.Effect<void>
  /** Run a command as a task, capturing output. Never fails - updates state only. */
  readonly runTask: (options: {
    id: string
    command: string
    args: string[]
    cwd?: string
    env?: Record<string, string>
  }) => Effect.Effect<
    void,
    PlatformError,
    CommandExecutor.CommandExecutor | CurrentWorkingDirectory
  >
  /** Run multiple tasks concurrently */
  readonly runAll: <E, R>(
    tasks: ReadonlyArray<Effect.Effect<void, E, R>>,
  ) => Effect.Effect<void, E, R>
  /** Render current state to string (for terminal output) */
  readonly render: () => Effect.Effect<string>
  /** Check if any tasks failed and return error if so */
  readonly checkForFailures: () => Effect.Effect<void, TasksFailedError>
}

/**
 * Service for running shell commands as tasks with structured state management.
 *
 * Key features:
 * - Tasks update state but never fail the Effect (use `checkForFailures` at the end)
 * - Output (stdout/stderr) is captured and buffered per-task
 * - State changes are available via SubscriptionRef for real-time rendering
 * - Built-in render function for terminal output
 */
export class TaskRunner extends Context.Tag('TaskRunner')<TaskRunner, TaskRunnerService>() {
  /**
   * Layer that provides a fresh TaskRunner instance.
   * Each layer creation starts with an empty task list.
   */
  static live = Layer.effect(
    TaskRunner,
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make(initialState)

      const updateTask = (opts: { id: string; update: (task: TaskState) => TaskState }) =>
        SubscriptionRef.update(
          ref,
          (state) =>
            new TaskRunnerState({
              tasks: state.tasks.map((t) => (t.id === opts.id ? opts.update(t) : t)),
            }),
        )

      const appendOutput = (opts: {
        id: string
        channel: 'stdout' | 'stderr'
        lines: readonly string[]
      }) =>
        updateTask({
          id: opts.id,
          update: (task) =>
            new TaskState({
              ...task,
              [opts.channel]: [...task[opts.channel], ...opts.lines],
            }),
        })

      const register: TaskRunnerService['register'] = (opts) =>
        SubscriptionRef.update(
          ref,
          (state) =>
            new TaskRunnerState({
              tasks: [
                ...state.tasks,
                new TaskState({
                  id: opts.id,
                  name: opts.name,
                  status: 'pending',
                  stdout: [],
                  stderr: [],
                  startedAt: Option.none(),
                  duration: Option.none(),
                  error: Option.none(),
                }),
              ],
            }),
        )

      const runTask: TaskRunnerService['runTask'] = Effect.fn('taskRunner/runTask')((options) =>
        Effect.gen(function* () {
          const startTime = Date.now()

          yield* updateTask({
            id: options.id,
            update: (task) =>
              new TaskState({
                ...task,
                status: 'running',
                startedAt: Option.some(startTime),
              }),
          })

          /** Run command with piped output, capturing into state */
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const cmdEffect = cmdStart([options.command, ...options.args], {
                stdout: 'pipe',
                stderr: 'pipe',
                ...(options.env ? { env: options.env } : {}),
              })

              /** Override CurrentWorkingDirectory if cwd is specified */
              const proc = yield* options.cwd
                ? cmdEffect.pipe(Effect.provideService(CurrentWorkingDirectory, options.cwd))
                : cmdEffect

              /** Consume stdout stream */
              const stdoutFiber = yield* proc.stdout.pipe(
                Stream.decodeText('utf8'),
                Stream.mapChunks((chunks) => {
                  const lines = Chunk.toReadonlyArray(chunks)
                    .join('')
                    .split('\n')
                    .filter((l) => l.length > 0)
                  return Chunk.fromIterable(lines)
                }),
                Stream.runForEach((line) =>
                  appendOutput({
                    id: options.id,
                    channel: 'stdout',
                    lines: [line],
                  }),
                ),
                Effect.fork,
              )

              /** Consume stderr stream */
              const stderrFiber = yield* proc.stderr.pipe(
                Stream.decodeText('utf8'),
                Stream.mapChunks((chunks) => {
                  const lines = Chunk.toReadonlyArray(chunks)
                    .join('')
                    .split('\n')
                    .filter((l) => l.length > 0)
                  return Chunk.fromIterable(lines)
                }),
                Stream.runForEach((line) =>
                  appendOutput({
                    id: options.id,
                    channel: 'stderr',
                    lines: [line],
                  }),
                ),
                Effect.fork,
              )

              const exitCode = yield* proc.exitCode

              yield* Fiber.interrupt(stdoutFiber)
              yield* Fiber.interrupt(stderrFiber)

              return exitCode
            }),
          )

          const endTime = Date.now()
          const duration = endTime - startTime

          if (result === 0) {
            yield* updateTask({
              id: options.id,
              update: (task) =>
                new TaskState({
                  ...task,
                  status: 'success',
                  duration: Option.some(duration),
                }),
            })
          } else {
            yield* updateTask({
              id: options.id,
              update: (task) =>
                new TaskState({
                  ...task,
                  status: 'failed',
                  duration: Option.some(duration),
                  error: Option.some(`Exit code: ${result}`),
                }),
            })
          }
        }),
      )

      const runAll: TaskRunnerService['runAll'] = (tasks) =>
        Effect.all(tasks, { concurrency: 'unbounded' }).pipe(Effect.asVoid)

      const checkForFailures: TaskRunnerService['checkForFailures'] = Effect.fnUntraced(
        function* () {
          const state = yield* SubscriptionRef.get(ref)
          const failed = state.tasks.filter((t) => t.status === 'failed')
          if (failed.length > 0) {
            return yield* new TasksFailedError({
              failedTaskIds: failed.map((t) => t.id),
              message: `${failed.length} task(s) failed`,
            })
          }
        },
      )

      const render: TaskRunnerService['render'] = () =>
        SubscriptionRef.get(ref).pipe(
          Effect.map((state) => {
            const docs: Doc.Doc<Ansi.Ansi>[] = []

            for (const task of state.tasks) {
              const statusStyle = {
                pending: Ansi.white,
                running: Ansi.cyan,
                success: Ansi.green,
                failed: Ansi.red,
              }[task.status]

              const statusIcon = {
                pending: unicodeSymbols.status.circle,
                running: '◐',
                success: unicodeSymbols.status.check,
                failed: unicodeSymbols.status.cross,
              }[task.status]

              const durationStr = Option.match(task.duration, {
                onNone: () => '',
                onSome: (d) => ` (${(d / 1000).toFixed(1)}s)`,
              })

              const taskLine = Doc.cat(
                Doc.annotate(Doc.text(statusIcon), statusStyle),
                Doc.cat(Doc.text(` ${task.name}`), Doc.annotate(Doc.text(durationStr), Ansi.white)),
              )
              docs.push(taskLine)

              /** Show last few lines of output for running/failed tasks */
              if (task.status === 'running' || task.status === 'failed') {
                const recentOutput = [...task.stdout, ...task.stderr].slice(-3)
                for (const line of recentOutput) {
                  docs.push(Doc.annotate(Doc.text(`  │ ${line}`), Ansi.white))
                }
              }

              if (task.status === 'failed' && Option.isSome(task.error)) {
                docs.push(Doc.annotate(Doc.text(`  └ ${task.error.value}`), Ansi.red))
              }
            }

            return renderAnsiDoc(Doc.vsep(docs))
          }),
        )

      return {
        changes: ref.changes,
        get: SubscriptionRef.get(ref),
        register,
        runTask,
        runAll,
        render,
        checkForFailures,
      } satisfies TaskRunnerService
    }),
  )

  /**
   * Convenience method to register and run a task in one call.
   *
   * @example
   * ```ts
   * yield* TaskRunner.task({
   *   id: 'build',
   *   name: 'Build project',
   *   command: 'npm',
   *   args: ['run', 'build'],
   * })
   * ```
   */
  static task = Effect.fn('TaskRunner.task')(function* (options: {
    id: string
    name: string
    command: string
    args: string[]
    cwd?: string
    env?: Record<string, string>
  }) {
    const runner = yield* TaskRunner
    yield* runner.register({ id: options.id, name: options.name })
    yield* runner.runTask(options)
  })
}

// -----------------------------------------------------------------------------
// Terminal Renderer
// -----------------------------------------------------------------------------

/**
 * Start a background render loop that clears and redraws on each state change.
 * For a proper TUI, replace with opentui/ink integration.
 *
 * @param options.refreshMs - Debounce interval in milliseconds (default: 100)
 */
export const renderLoop = Effect.fn('TaskRunner.renderLoop')(function* (options?: {
  refreshMs?: number
}) {
  const runner = yield* TaskRunner
  const refreshMs = options?.refreshMs ?? 100

  yield* runner.changes.pipe(
    Stream.debounce(refreshMs),
    Stream.runForEach(() =>
      Effect.gen(function* () {
        const output = yield* runner.render()
        /** Clear screen and move cursor to top */
        process.stdout.write('\x1B[2J\x1B[H')
        process.stdout.write(output + '\n')
      }),
    ),
    Effect.fork,
  )
})

/**
 * Print final summary of all tasks and fail if any task failed.
 * Shows detailed stderr output for failed tasks.
 *
 * This should be called at the end of task execution to:
 * 1. Display the final state of all tasks
 * 2. Show error details for failed tasks
 * 3. Return a `TasksFailedError` if any tasks failed
 */
export const printFinalSummary = Effect.gen(function* () {
  const runner = yield* TaskRunner
  const state = yield* runner.get

  const output = yield* runner.render()
  console.log('\n' + output)

  const failed = state.tasks.filter((t) => t.status === 'failed')
  const success = state.tasks.filter((t) => t.status === 'success')

  if (failed.length > 0) {
    const failedSummary = Doc.annotate(
      Doc.text(`\n✗ ${failed.length} task(s) failed`),
      Ansi.combine(Ansi.red, Ansi.bold),
    )
    console.log(renderAnsiDoc(failedSummary))

    for (const task of failed) {
      const header = Doc.annotate(
        Doc.text(`\n--- ${task.name} ---`),
        Ansi.combine(Ansi.red, Ansi.bold),
      )
      console.log(renderAnsiDoc(header))
      for (const line of task.stderr) {
        console.log(line)
      }
    }
  } else {
    const successSummary = Doc.annotate(
      Doc.text(`\n✓ All ${success.length} task(s) passed`),
      Ansi.combine(Ansi.green, Ansi.bold),
    )
    console.log(renderAnsiDoc(successSummary))
  }

  yield* runner.checkForFailures()
}).pipe(Effect.withSpan('TaskRunner.printFinalSummary'))
