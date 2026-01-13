/**
 * Public API for creating tasks.
 *
 * Provides a unified `task()` factory function that supports both
 * shell commands and arbitrary Effects.
 */

import { Effect, Stream } from 'effect'

import type { CommandSpec } from './execution.ts'
import { CommandError, executeCommand } from './execution.ts'
import type { TaskDef, TaskEvent } from './types.ts'

// =============================================================================
// Task Factory Overloads
// =============================================================================

/**
 * Create a command task that executes a shell command.
 *
 * @example
 * ```ts
 * task('install', 'Install dependencies', {
 *   cmd: 'bun',
 *   args: ['install'],
 * })
 * ```
 */
export function task<TId extends string>(
  id: TId,
  name: string,
  command: CommandSpec,
  options?: { dependencies?: ReadonlyArray<TId> },
): TaskDef<TId, void, CommandError | import('@effect/platform/Error').PlatformError, any>

/**
 * Create an effect task that runs arbitrary Effect code.
 *
 * @example
 * ```ts
 * task('notify', 'Send notification',
 *   Effect.gen(function* () {
 *     yield* sendSlackMessage('Build complete!')
 *   })
 * )
 * ```
 */
export function task<TId extends string, A, E, R>(
  id: TId,
  name: string,
  effect: Effect.Effect<A, E, R>,
  options?: { dependencies?: ReadonlyArray<TId> },
): TaskDef<TId, A, E, R>

/**
 * Implementation of task factory.
 * Determines if input is a command or effect and creates appropriate TaskDef.
 */
export function task<TId extends string>(
  id: TId,
  name: string,
  commandOrEffect: CommandSpec | Effect.Effect<any, any, any>,
  options?: { dependencies?: ReadonlyArray<TId> },
): TaskDef<TId, any, any, any> {
  // Check if it's a CommandSpec (has cmd property)
  const isCommand = (x: any): x is CommandSpec =>
    typeof x === 'object' && x !== null && 'cmd' in x && 'args' in x

  if (isCommand(commandOrEffect)) {
    // Command task - stream events with exit code checking
    const taskDef: TaskDef<TId, any, any, any> = {
      id,
      name,
      eventStream: (taskId) => executeCommand(taskId as TId, commandOrEffect),
      // No effect needed - exit code is checked in the stream
      ...(options?.dependencies !== undefined ? { dependencies: options.dependencies } : {}),
    }
    return taskDef
  }

  // Effect task - wrap in event stream (no stdout/stderr)
  const taskDef: TaskDef<TId, any, any, any> = {
    id,
    name,
    eventStream: (_taskId) => {
      // For effect tasks, we don't emit stdout/stderr events
      // The effect just runs and completes
      return Stream.empty
    },
    effect: commandOrEffect,
    ...(options?.dependencies !== undefined ? { dependencies: options.dependencies } : {}),
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
export const commandTask = <TId extends string>(
  id: TId,
  name: string,
  cmd: string,
  args: readonly string[],
  options?: {
    cwd?: string
    env?: Record<string, string>
    dependencies?: ReadonlyArray<TId>
  },
): TaskDef<TId, void, CommandError | import('@effect/platform/Error').PlatformError, any> => {
  const spec: CommandSpec = { cmd, args }
  if (options?.cwd) {
    ;(spec as any).cwd = options.cwd
  }
  if (options?.env) {
    ;(spec as any).env = options.env
  }
  return task(
    id,
    name,
    spec,
    options?.dependencies !== undefined ? { dependencies: options.dependencies } : undefined,
  )
}

/**
 * Create an effect task (explicit helper).
 * Useful when you want to be explicit about the task type.
 */
export const effectTask = <TId extends string, A, E, R>(
  id: TId,
  name: string,
  effect: Effect.Effect<A, E, R>,
  options?: { dependencies?: ReadonlyArray<TId> },
): TaskDef<TId, A, E, R> => task(id, name, effect, options)
