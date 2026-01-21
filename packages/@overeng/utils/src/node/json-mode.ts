/**
 * JSON Mode Helpers for Effect-based CLIs
 *
 * Provides utilities for CLIs that support `--json` output mode.
 * Ensures that when JSON mode is enabled, only valid JSON is written to stdout
 * with no contamination from Effect's runtime error logging.
 */

import { Effect, Inspectable } from 'effect'

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
 * - Catches all defects (unexpected errors) and outputs them as JSON
 * - For expected errors, the command should use jsonError() directly
 *
 * @example
 * ```ts
 * const myCommand = Cli.Command.make('cmd', { json: jsonOption }, ({ json }) =>
 *   withJsonMode({
 *     json,
 *     effect: Effect.gen(function* () {
 *       // Command implementation
 *       if (someError) {
 *         return yield* jsonError({ error: 'some_error', message: 'Details' })
 *       }
 *       if (json) {
 *         console.log(JSON.stringify({ result: 'success' }))
 *       } else {
 *         yield* Effect.log('Success!')
 *       }
 *     }),
 *   }),
 * )
 * ```
 */
export const withJsonMode = <A, E, R>({
  json,
  effect,
}: {
  json: boolean
  effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R> =>
  json
    ? effect.pipe(
        Effect.catchAllDefect((defect) => {
          console.log(
            JSON.stringify({
              error: 'internal_error',
              message: Inspectable.formatUnknown(defect),
            }),
          )
          return exitWithCode(1)
        }),
      )
    : effect
