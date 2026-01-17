/**
 * Public API for creating tasks.
 *
 * Provides a unified `task()` factory function that supports both
 * shell commands and arbitrary Effects.
 */

import type { CommandExecutor } from '@effect/platform/CommandExecutor'
import type { PlatformError } from '@effect/platform/Error'
import type { Effect, Schedule } from 'effect'
import { Stream } from 'effect'

import type { CommandError, CommandSpec } from './execution.ts'
import { executeCommand } from './execution.ts'
import type { TaskDef } from './types.ts'

// =============================================================================
// Type Guards
// =============================================================================

/** Check if the input is a CommandSpec (has cmd and args properties) */
const isCommand = (x: unknown): x is CommandSpec =>
  typeof x === 'object' && x !== null && 'cmd' in x && 'args' in x

// =============================================================================
// Task Factory Overloads
// =============================================================================

/**
 * Create a command task that executes a shell command.
 *
 * @example
 * ```ts
 * task({
 *   id: 'install',
 *   name: 'Install dependencies',
 *   command: { cmd: 'bun', args: ['install'] },
 * })
 * ```
 */
export function task<TId extends string>(args: {
  id: TId
  name: string
  command: CommandSpec
  options?: {
    dependencies?: ReadonlyArray<TId>
    retrySchedule?: Schedule.Schedule<unknown, unknown, never>
    // TODO get rid of this as it's already covered by retrySchedule
    maxRetries?: number
    /** Path to log file for persisting task output after completion */
    logFile?: string
  }
}): TaskDef<TId, void, CommandError | PlatformError, CommandExecutor>

/**
 * Create an effect task that runs arbitrary Effect code.
 *
 * @example
 * ```ts
 * task({
 *   id: 'notify',
 *   name: 'Send notification',
 *   effect: Effect.gen(function* () {
 *     yield* sendSlackMessage('Build complete!')
 *   }),
 * })
 * ```
 */
export function task<TId extends string, A, E, R>(args: {
  id: TId
  name: string
  effect: Effect.Effect<A, E, R>
  options?: {
    dependencies?: ReadonlyArray<TId>
    retrySchedule?: Schedule.Schedule<unknown, unknown, never>
    // TODO get rid of this as it's already covered by retrySchedule
    maxRetries?: number
    /** Path to log file for persisting task output after completion */
    logFile?: string
  }
}): TaskDef<TId, A, E, R>

/**
 * Implementation of task factory.
 * Determines if input is a command or effect and creates appropriate TaskDef.
 *
 * Note: The implementation uses unknown for the Effect type parameters to support
 * both command and effect overloads. Type safety is maintained by the overload signatures.
 */
export function task<TId extends string, A, E, R>({
  id,
  name,
  command,
  effect,
  options,
}: {
  id: TId
  name: string
  command?: CommandSpec
  effect?: Effect.Effect<A, E, R>
  options?: {
    dependencies?: ReadonlyArray<TId>
    retrySchedule?: Schedule.Schedule<unknown, unknown, never>
    maxRetries?: number
    logFile?: string
  }
}): TaskDef<TId, A, E, R> | TaskDef<TId, void, CommandError | PlatformError, CommandExecutor> {
  const commandOrEffect = command ?? effect!
  if (isCommand(commandOrEffect)) {
    // Command task - stream events with exit code checking
    const taskDef: TaskDef<TId, void, CommandError | PlatformError, CommandExecutor> = {
      id,
      name,
      // Capture id in closure - executeCommand uses it to create TaskEvent<TId>
      eventStream: () => executeCommand({ taskId: id, spec: commandOrEffect }),
      // No effect needed - exit code is checked in the stream
      // Capture command context for failure reporting
      commandContext: {
        command: commandOrEffect.cmd,
        args: [...commandOrEffect.args],
        cwd: commandOrEffect.cwd ?? process.cwd(),
      },
      ...(options?.dependencies !== undefined ? { dependencies: options.dependencies } : {}),
      ...(options?.retrySchedule !== undefined ? { retrySchedule: options.retrySchedule } : {}),
      ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options?.logFile !== undefined ? { logFile: options.logFile } : {}),
    }
    return taskDef
  }

  // Effect task - no event stream (no stdout/stderr)
  const taskDef: TaskDef<TId, A, E, R> = {
    id,
    name,
    eventStream: () => Stream.empty,
    effect: commandOrEffect,
    ...(options?.dependencies !== undefined ? { dependencies: options.dependencies } : {}),
    ...(options?.retrySchedule !== undefined ? { retrySchedule: options.retrySchedule } : {}),
    ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options?.logFile !== undefined ? { logFile: options.logFile } : {}),
  }
  return taskDef
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create a command task (explicit helper).
 * Useful when you want to be explicit about the task type.
 */
export const commandTask = <TId extends string>({
  id,
  name,
  cmd,
  args,
  options,
}: {
  id: TId
  name: string
  cmd: string
  args: readonly string[]
  options?: {
    cwd?: string
    env?: Record<string, string>
    dependencies?: ReadonlyArray<TId>
  }
}): TaskDef<TId, void, CommandError | PlatformError, CommandExecutor> => {
  const spec: CommandSpec = { cmd, args }
  if (options?.cwd) {
    ;(spec as { cwd?: string }).cwd = options.cwd
  }
  if (options?.env) {
    ;(spec as { env?: Record<string, string> }).env = options.env
  }
  if (options?.dependencies !== undefined) {
    return task({
      id,
      name,
      command: spec,
      options: { dependencies: options.dependencies },
    })
  }
  return task({
    id,
    name,
    command: spec,
  })
}

/**
 * Create an effect task (explicit helper).
 * Useful when you want to be explicit about the task type.
 */
export const effectTask = <TId extends string, A, E, R>({
  id,
  name,
  effect,
  options,
}: {
  id: TId
  name: string
  effect: Effect.Effect<A, E, R>
  options?: { dependencies?: ReadonlyArray<TId> }
}): TaskDef<TId, A, E, R> => {
  if (options?.dependencies !== undefined) {
    return task({ id, name, effect, options: { dependencies: options.dependencies } })
  }
  return task({ id, name, effect })
}

// =============================================================================
// Task Collection Utilities
// =============================================================================

/**
 * Create a tuple of tasks with preserved literal ID types.
 * This avoids the need for explicit type casts when combining heterogeneous tasks.
 *
 * @example
 * ```ts
 * const allTasks = tasks(
 *   task({ id: 'build', name: 'Build', command: { cmd: 'tsc', args: [] } }),
 *   task({ id: 'test', name: 'Test', effect: runTests() }),
 * )
 * // Type infers IDs as 'build' | 'test' union
 * ```
 */
export const tasks = <const T extends readonly TaskDef<string, unknown, unknown, unknown>[]>(
  ...defs: T
): T => defs

/** Extract the union of task IDs from a task tuple */
export type TaskIds<T extends readonly TaskDef<string, unknown, unknown, unknown>[]> =
  T[number]['id']
