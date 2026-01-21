/**
 * JSON Mode Helpers for Effect-based CLIs
 *
 * Provides utilities for CLIs that support `--json` output mode.
 * Ensures that when JSON mode is enabled, only valid JSON is written to stdout
 * with no contamination from Effect's runtime error logging.
 */

import { Effect, Inspectable } from 'effect'
import { dual } from 'effect/Function'

/**
 * Format an unknown value for error messages.
 * Handles Error objects specially since Inspectable.format returns {} for them.
 */
const formatUnknown = (value: unknown): string => {
  if (value instanceof Error) {
    return String(value) // "Error: message" format
  }
  return Inspectable.format(value)
}

/**
 * Exit the process with the given code, ensuring stdout has flushed first.
 * This prevents output truncation when stdout is piped/redirected (non-TTY).
 *
 * Uses Effect.async to wait for stdout to drain before calling process.exit().
 */
export const exitWithCode = (code: number): Effect.Effect<never> =>
  Effect.async<never>(() => {
    // Set exit code first as a fallback
    process.exitCode = code
    // Write empty string with callback to ensure all prior writes have flushed
    process.stdout.write('', () => {
      process.exit(code)
    })
  })

/**
 * Output a JSON error object to stdout and exit with code 1.
 * This should be used instead of Effect.fail() in JSON mode error paths
 * to prevent Effect's runtime from logging additional output.
 *
 * Ensures stdout is flushed before exiting to prevent truncation in pipes.
 *
 * **Note:** This function hard-exits the process, which skips Effect finalizers
 * and scopes. This is an intentional tradeoff for ensuring clean JSON output
 * without any Effect runtime logging contamination.
 */
export const jsonError = (error: { error: string; message: string }): Effect.Effect<never> =>
  Effect.async<never>(() => {
    process.exitCode = 1
    // Write JSON with newline (like console.log) and exit after flush
    process.stdout.write(JSON.stringify(error) + '\n', () => {
      process.exit(1)
    })
  })

/**
 * Output a JSON success object to stdout.
 */
export const jsonOutput = <T>(data: T): Effect.Effect<void> =>
  Effect.sync(() => {
    console.log(JSON.stringify(data))
  })

/**
 * Wrap an effect to handle JSON mode properly.
 *
 * When `json=true`:
 * - Catches ALL typed failures and outputs them as JSON with `error: 'internal_error'`
 * - Catches ALL defects (unexpected errors) and outputs them as JSON
 * - Commands should still use `jsonError()` for specific error codes/messages,
 *   but this wrapper acts as a safety net for any unhandled errors
 *
 * When `json=false`:
 * - Passes the effect through unchanged
 *
 * **Note:** When json=true, this hard-exits the process on any failure, which skips
 * Effect finalizers and scopes. This is intentional to ensure clean JSON output.
 *
 * @example
 * ```ts
 * // Data-last (pipeable) - recommended
 * const myCommand = Cli.Command.make('cmd', { json: jsonOption }, ({ json }) =>
 *   Effect.gen(function* () {
 *     // Command implementation
 *     if (someError) {
 *       return yield* jsonError({ error: 'some_error', message: 'Details' })
 *     }
 *     if (json) {
 *       console.log(JSON.stringify({ result: 'success' }))
 *     } else {
 *       yield* Effect.log('Success!')
 *     }
 *   }).pipe(withJsonMode(json)),
 * )
 *
 * // Data-first
 * withJsonMode(myEffect, json)
 * ```
 */
export const withJsonMode: {
  // Data-last (pipeable)
  (json: boolean): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  // Data-first
  <A, E, R>(effect: Effect.Effect<A, E, R>, json: boolean): Effect.Effect<A, E, R>
} = dual(
  2,
  <A, E, R>(effect: Effect.Effect<A, E, R>, json: boolean): Effect.Effect<A, E, R> =>
    json
      ? (effect.pipe(
          // Catch typed failures (e.g., PlatformError, IO errors)
          Effect.catchAll((error) => {
            console.log(
              JSON.stringify({
                error: 'internal_error',
                message: formatUnknown(error),
              }),
            )
            return exitWithCode(1)
          }),
          // Catch defects (unexpected throws, Effect.die, etc.)
          Effect.catchAllDefect((defect) => {
            console.log(
              JSON.stringify({
                error: 'internal_error',
                message: formatUnknown(defect),
              }),
            )
            return exitWithCode(1)
          }),
        ) as Effect.Effect<A, E, R>)
      : effect,
)
