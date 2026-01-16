/**
 * Command execution with output capture and event streaming.
 *
 * Commands are executed with piped stdout/stderr, and output is streamed
 * as TaskEvents. This allows renderers to show live progress.
 */

import * as Command from '@effect/platform/Command'
import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import type { PlatformError } from '@effect/platform/Error'
import { Chunk, Effect, Logger, Metric, Stream } from 'effect'

import type { TaskEvent } from './types.ts'

// =============================================================================
// Command Specification
// =============================================================================

/** Specification for a shell command task */
export interface CommandSpec {
  /** Command to execute (e.g., 'bun', 'tsc') */
  readonly cmd: string
  /** Command arguments */
  readonly args: readonly string[]
  /** Working directory (defaults to current directory) */
  readonly cwd?: string
  /** Environment variables */
  readonly env?: Record<string, string>
}

/** Error returned when a command fails */
export class CommandError extends Error {
  readonly _tag = 'CommandError'
  readonly command: string
  readonly args: readonly string[]
  readonly exitCode: number
  readonly stderr?: string

  constructor({
    command,
    args,
    exitCode,
    stderr,
  }: {
    command: string
    args: readonly string[]
    exitCode: number
    stderr?: string
  }) {
    super(`Command '${command} ${args.join(' ')}' failed with exit code ${exitCode}`)
    this.command = command
    this.args = args
    this.exitCode = exitCode
    if (stderr !== undefined) {
      this.stderr = stderr
    }
  }
}

// =============================================================================
// Metrics
// =============================================================================

/** Track stdout/stderr buffer sizes to monitor memory usage */
export const bufferSizeMetric = Metric.counter('task_buffer_size_bytes', {
  description: 'Total bytes buffered in stdout/stderr across all tasks',
})

// =============================================================================
// Console Capture (Optional)
// =============================================================================

/**
 * Console capture configuration.
 * When enabled, intercepts console.log/warn/error and emits as stdout/stderr events.
 */
export interface ConsoleCapture {
  /** Capture console.log as stdout events */
  readonly captureLog?: boolean
  /** Capture console.warn as stderr events */
  readonly captureWarn?: boolean
  /** Capture console.error as stderr events */
  readonly captureError?: boolean
}

// Store original console methods
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
}

/**
 * Install console interceptors that emit events to a stream.
 * Returns cleanup function to restore original console.
 */
export const installConsoleCapture = <TId extends string>({
  taskId,
  config,
  emit,
}: {
  taskId: TId
  config: ConsoleCapture
  emit: (event: TaskEvent<TId>) => void
}): (() => void) => {
  if (config.captureLog) {
    console.log = (...args: unknown[]) => {
      const message = args.map((a) => String(a)).join(' ')
      emit({ type: 'stdout', taskId, chunk: message })
      originalConsole.log(...args)
    }
  }

  if (config.captureWarn) {
    console.warn = (...args: unknown[]) => {
      const message = args.map((a) => String(a)).join(' ')
      emit({ type: 'stderr', taskId, chunk: message })
      originalConsole.warn(...args)
    }
  }

  if (config.captureError) {
    console.error = (...args: unknown[]) => {
      const message = args.map((a) => String(a)).join(' ')
      emit({ type: 'stderr', taskId, chunk: message })
      originalConsole.error(...args)
    }
  }

  // Return cleanup function
  return () => {
    console.log = originalConsole.log
    console.warn = originalConsole.warn
    console.error = originalConsole.error
  }
}

// =============================================================================
// Custom Logger for Effect.log Capture
// =============================================================================

/**
 * Create a custom logger that captures Effect.log messages and emits them as events.
 * This logger replaces the default Effect logger during task execution.
 */
export const makeTaskLogger = <TId extends string>({
  taskId,
  emit,
}: {
  taskId: TId
  emit: (event: TaskEvent<TId>) => void
}): Logger.Logger<string, void> =>
  Logger.make(({ logLevel, message }) => {
    // Emit based on log level
    if (logLevel._tag === 'Error' || logLevel._tag === 'Fatal') {
      emit({ type: 'stderr', taskId, chunk: message })
    } else {
      emit({ type: 'stdout', taskId, chunk: message })
    }
  })

// =============================================================================
// Command Execution
// =============================================================================

/**
 * Execute a command and stream output as events.
 *
 * Returns a stream of TaskEvents (stdout, stderr chunks).
 * Fails with CommandError if command exits with non-zero code.
 */
export const executeCommand = <TId extends string>({
  taskId,
  spec,
}: {
  taskId: TId
  spec: CommandSpec
}): Stream.Stream<TaskEvent<TId>, CommandError | PlatformError, CommandExecutor.CommandExecutor> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      // Build command
      const command = Command.make(spec.cmd, ...spec.args)

      const configuredCommand = command.pipe(
        spec.cwd ? Command.workingDirectory(spec.cwd) : (c) => c,
        spec.env ? Command.env(spec.env) : (c) => c,
        Command.stdout('pipe'),
        Command.stderr('pipe'),
      )

      // Start command (requires Scope)
      const proc = yield* Command.start(configuredCommand)

      // Create streams for stdout and stderr
      const stdoutStream = proc.stdout.pipe(
        Stream.decodeText('utf8'),
        Stream.mapChunksEffect((chunks) =>
          Effect.gen(function* () {
            // Split by lines and filter empty
            const lines = Chunk.toReadonlyArray(chunks)
              .join('')
              .split('\n')
              .filter((line) => line.length > 0)

            // Track buffer size metric
            const totalBytes = lines.reduce((sum, line) => sum + line.length, 0)
            yield* Metric.incrementBy(bufferSizeMetric, totalBytes)

            return Chunk.fromIterable(
              lines.map(
                (chunk): TaskEvent<TId> => ({
                  type: 'stdout',
                  taskId,
                  chunk,
                }),
              ),
            )
          }),
        ),
      )

      const stderrStream = proc.stderr.pipe(
        Stream.decodeText('utf8'),
        Stream.mapChunksEffect((chunks) =>
          Effect.gen(function* () {
            const lines = Chunk.toReadonlyArray(chunks)
              .join('')
              .split('\n')
              .filter((line) => line.length > 0)

            const totalBytes = lines.reduce((sum, line) => sum + line.length, 0)
            yield* Metric.incrementBy(bufferSizeMetric, totalBytes)

            return Chunk.fromIterable(
              lines.map(
                (chunk): TaskEvent<TId> => ({
                  type: 'stderr',
                  taskId,
                  chunk,
                }),
              ),
            )
          }),
        ),
      )

      // Merge stdout and stderr streams
      const outputStream = Stream.merge(stdoutStream, stderrStream)

      // Append exit code check after all output
      // We use flatMap to avoid emitting undefined - either emit empty or fail
      const streamWithExitCheck = outputStream.pipe(
        Stream.concat(
          Stream.flatMap(
            Stream.fromEffect(
              Effect.gen(function* () {
                const exitCode = yield* proc.exitCode

                // Fail if command exited with non-zero code
                if (exitCode !== 0) {
                  return yield* Effect.fail(
                    new CommandError({ command: spec.cmd, args: spec.args, exitCode }),
                  )
                }
              }),
            ),
            () => Stream.empty, // Map undefined to empty stream
          ),
        ),
      )

      return streamWithExitCheck
    }),
  )

/**
 * Wait for command to complete and check exit code.
 * Used as the effect for command tasks (output is captured by eventStream).
 *
 * Fails with CommandError if the command exits with non-zero code.
 */
export const checkCommandExit = (
  spec: CommandSpec,
): Effect.Effect<void, CommandError | PlatformError, CommandExecutor.CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const command = Command.make(spec.cmd, ...spec.args)

      const configuredCommand = command.pipe(
        spec.cwd ? Command.workingDirectory(spec.cwd) : (c) => c,
        spec.env ? Command.env(spec.env) : (c) => c,
        Command.stdout('inherit'), // Don't capture - handled by eventStream
        Command.stderr('inherit'), // Don't capture - handled by eventStream
      )

      const proc = yield* Command.start(configuredCommand)
      const exitCode = yield* proc.exitCode

      if (exitCode !== 0) {
        return yield* Effect.fail(
          new CommandError({ command: spec.cmd, args: spec.args, exitCode }),
        )
      }
    }),
  )

/**
 * Execute a command as an Effect (no event streaming).
 * Collects all output and returns on completion.
 *
 * Fails with CommandError if the command exits with non-zero code.
 */
export const runCommand = (
  spec: CommandSpec,
): Effect.Effect<
  { stdout: string; stderr: string },
  CommandError | PlatformError,
  CommandExecutor.CommandExecutor
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const command = Command.make(spec.cmd, ...spec.args)

      const configuredCommand = command.pipe(
        spec.cwd ? Command.workingDirectory(spec.cwd) : (c) => c,
        spec.env ? Command.env(spec.env) : (c) => c,
        Command.stdout('pipe'),
        Command.stderr('pipe'),
      )

      const proc = yield* Command.start(configuredCommand)

      const [stdout, stderr] = yield* Effect.all([
        proc.stdout.pipe(Stream.decodeText('utf8'), Stream.runCollect),
        proc.stderr.pipe(Stream.decodeText('utf8'), Stream.runCollect),
      ])

      const exitCode = yield* proc.exitCode

      const stdoutText = Array.from(stdout).join('')
      const stderrText = Array.from(stderr).join('')

      if (exitCode !== 0) {
        return yield* Effect.fail(
          new CommandError({ command: spec.cmd, args: spec.args, exitCode, stderr: stderrText }),
        )
      }

      return { stdout: stdoutText, stderr: stderrText }
    }),
  )
