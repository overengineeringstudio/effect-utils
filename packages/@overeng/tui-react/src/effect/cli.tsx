/**
 * Effect CLI Integration
 *
 * Provides reusable CLI options for tui-react output modes.
 * Use the `--output` flag in your Effect CLI commands to control output format.
 *
 * @example
 * ```typescript
 * import { Command, Options } from "@effect/cli"
 * import { Effect } from "effect"
 * import { outputOption, outputModeLayer } from "@overeng/tui-react"
 *
 * const myCommand = Command.make("my-cmd", {
 *   name: Options.text("name"),
 *   output: outputOption,
 * }, ({ name, output }) =>
 *   myProgram(name).pipe(
 *     Effect.provide(outputModeLayer(output))
 *   )
 * )
 * ```
 *
 * @module
 */

import { Options } from '@effect/cli'
import { Cause, Effect, Layer, Logger } from 'effect'

import type { OutputModeTag } from './OutputMode.tsx'
import {
  type OutputMode,
  tty,
  ci,
  ciPlain,
  pipe,
  log,
  altScreen,
  json,
  ndjson,
  detectOutputMode,
  layer,
  isJson,
} from './OutputMode.tsx'

// =============================================================================
// Output Mode Values
// =============================================================================

/**
 * Valid values for the `--output` flag.
 */
export const OUTPUT_MODE_VALUES = [
  'auto',
  'tty',
  'alt-screen',
  'ci',
  'ci-plain',
  'pipe',
  'log',
  'json',
  'ndjson',
] as const

/**
 * Type for the `--output` flag value.
 */
export type OutputModeValue = (typeof OUTPUT_MODE_VALUES)[number]

// =============================================================================
// CLI Option
// =============================================================================

/**
 * `--output` / `-o` flag for controlling output mode.
 *
 * Available modes:
 * - `auto` (default) - Auto-detect based on environment (TTY, CI, pipe)
 * - `tty` - Live output with animated spinners and colors
 * - `alt-screen` - Live output in alternate screen buffer (fullscreen TUI)
 * - `ci` - Live output with static spinners and colors
 * - `ci-plain` - Live output with static spinners, no colors
 * - `pipe` - Final output only with colors (for piping)
 * - `log` - Final output only, no colors (for log files)
 * - `json` - Final JSON output
 * - `ndjson` - Live streaming JSON output (newline-delimited)
 *
 * @example
 * ```typescript
 * const myCommand = Command.make("cmd", {
 *   output: outputOption,
 * }, ({ output }) =>
 *   myProgram().pipe(Effect.provide(outputModeLayer(output)))
 * )
 * ```
 */
export const outputOption = Options.choice('output', OUTPUT_MODE_VALUES).pipe(
  Options.withAlias('o'),
  Options.withDescription(
    'Output mode: auto, tty, alt-screen, ci, ci-plain, pipe, log, json, ndjson',
  ),
  Options.withDefault('auto' as OutputModeValue),
)

// =============================================================================
// Layer Helper
// =============================================================================

/**
 * Map from flag value to OutputMode preset.
 */
const modeMap: Record<Exclude<OutputModeValue, 'auto'>, OutputMode> = {
  tty: tty,
  'alt-screen': altScreen,
  ci: ci,
  'ci-plain': ciPlain,
  pipe: pipe,
  log: log,
  json: json,
  ndjson: ndjson,
}

/**
 * Create a logger layer that writes to stderr.
 *
 * This is used in JSON modes to ensure all log output goes to stderr,
 * keeping stdout clean for JSON data only.
 */
const stderrLoggerLayer: Layer.Layer<never> = Logger.replace(
  Logger.defaultLogger,
  Logger.prettyLogger().pipe(Logger.withConsoleError),
)

/**
 * Create an OutputMode layer from the `--output` flag value.
 *
 * For JSON modes (`json`, `ndjson`), this also configures the logger to write
 * to stderr instead of stdout, ensuring stdout contains only JSON data.
 * This follows the principle: "stdout = data, stderr = diagnostics".
 *
 * @example
 * ```typescript
 * // In command handler:
 * myProgram().pipe(Effect.provide(outputModeLayer(output)))
 * ```
 *
 * @example
 * ```typescript
 * // Explicit mode:
 * outputModeLayer('json')  // JSON output (logs go to stderr)
 * outputModeLayer('tty')   // Animated terminal (logs go to stdout)
 * outputModeLayer('auto')  // Auto-detect from environment
 * ```
 */
export const outputModeLayer = (value: OutputModeValue): Layer.Layer<OutputModeTag> => {
  const mode = value === 'auto' ? detectOutputMode() : modeMap[value]
  const outputLayer = layer(mode)

  // For JSON modes, configure logger to write to stderr
  // This keeps stdout clean for JSON data only
  if (isJson(mode)) {
    return Layer.merge(outputLayer, stderrLoggerLayer)
  }

  return outputLayer
}

/**
 * Resolve an OutputModeValue to an OutputMode.
 *
 * Useful when you need the mode object directly rather than a layer.
 *
 * @example
 * ```typescript
 * const mode = resolveOutputMode('json')
 * if (isJson(mode)) {
 *   // Handle JSON mode
 * }
 * ```
 */
export const resolveOutputMode = (value: OutputModeValue): OutputMode => {
  if (value === 'auto') {
    return detectOutputMode()
  }
  return modeMap[value]
}

// =============================================================================
// CLI Main Runner
// =============================================================================

/**
 * Options for `runTuiMain`.
 */
export interface RunTuiMainOptions {
  /**
   * Filter function to determine which errors should be logged to stderr.
   * Return `true` to log the error, `false` to suppress it.
   *
   * This is useful for errors that are already represented in the command's
   * JSON output (like `SyncFailedError` in megarepo) - you can suppress the
   * stderr logging while still preserving the non-zero exit code.
   *
   * @default All errors are logged
   */
  readonly shouldLogError?: (error: unknown) => boolean
}

/**
 * Type for the NodeRuntime parameter required by `runTuiMain`.
 */
export interface TuiRuntime {
  readonly runMain: (options?: {
    readonly disableErrorReporting?: boolean
    readonly disablePrettyLogger?: boolean
  }) => <E, A>(effect: Effect.Effect<A, E>) => void
}

/**
 * Run a TUI CLI application as the main entry point.
 *
 * This helper wraps `NodeRuntime.runMain` with proper error handling for TUI apps:
 * - Errors are written to stderr (not stdout) to avoid polluting JSON output
 * - Uses `disableErrorReporting` to prevent `runMain` from logging to stdout
 * - Preserves exit codes from errors
 * - Optionally filter which errors get logged via `shouldLogError`
 *
 * Supports Effect's dual API pattern for flexible usage in pipe chains.
 *
 * @example
 * ```typescript
 * // Pipeable usage (recommended):
 * Cli.Command.run(myCommand, { name: 'my-cli', version })(process.argv).pipe(
 *   Effect.scoped,
 *   Effect.provide(baseLayer),
 *   runTuiMain(NodeRuntime)
 * )
 * ```
 *
 * @example
 * ```typescript
 * // Data-first usage:
 * runTuiMain(NodeRuntime, program)
 * ```
 *
 * @example
 * ```typescript
 * // With options:
 * Cli.Command.run(myCommand, { name: 'my-cli', version })(process.argv).pipe(
 *   Effect.scoped,
 *   Effect.provide(baseLayer),
 *   runTuiMain(NodeRuntime, { shouldLogError: (e) => e._tag !== 'MyExpectedError' })
 * )
 * ```
 */
export const runTuiMain: {
  // Data-last (pipeable): runTuiMain(runtime) or runTuiMain(runtime, options)
  (runtime: TuiRuntime, options?: RunTuiMainOptions): <E, A>(effect: Effect.Effect<A, E>) => void
  // Data-first: runTuiMain(runtime, effect) or runTuiMain(runtime, effect, options)
  <E, A>(runtime: TuiRuntime, effect: Effect.Effect<A, E>, options?: RunTuiMainOptions): void
} = ((...args: [TuiRuntime, ...Array<unknown>]) => {
  const [runtime, effectOrOptions, maybeOptions] = args
  // Check if second argument is an Effect (data-first) or options/undefined (data-last)
  if (effectOrOptions !== undefined && Effect.isEffect(effectOrOptions)) {
    // Data-first: runTuiMain(runtime, effect, options?)
    return runTuiMainImpl({
      runtime,
      effect: effectOrOptions as Effect.Effect<unknown, unknown>,
      options: maybeOptions as RunTuiMainOptions | undefined,
    })
  }
  // Data-last: runTuiMain(runtime, options?) returns (effect) => void
  const options = effectOrOptions as RunTuiMainOptions | undefined
  return <E, A>(effect: Effect.Effect<A, E>) => runTuiMainImpl({ runtime, effect, options })
}) as {
  (runtime: TuiRuntime, options?: RunTuiMainOptions): <E, A>(effect: Effect.Effect<A, E>) => void
  <E, A>(runtime: TuiRuntime, effect: Effect.Effect<A, E>, options?: RunTuiMainOptions): void
}

/** Internal implementation of runTuiMain */
const runTuiMainImpl = <E, A>({
  runtime,
  effect,
  options,
}: {
  runtime: TuiRuntime
  effect: Effect.Effect<A, E>
  options?: RunTuiMainOptions | undefined
}): void => {
  const shouldLogError = options?.shouldLogError ?? (() => true)

  effect.pipe(
    Effect.tapErrorCause((cause) =>
      Effect.sync(() => {
        // Check if cause has any loggable content:
        // 1. Typed failures (the E in Effect<A, E>) - filtered by shouldLogError
        // 2. Defects (crashes, thrown exceptions) - always logged
        // 3. Interruptions - always logged
        const failures = Cause.failures(cause)
        const hasLoggableFailure = failures.pipe((chunk) => {
          for (const error of chunk) {
            if (shouldLogError(error)) return true
          }
          return false
        })

        // Always log defects and interruptions - these are unexpected and need visibility
        const hasDefects = !Cause.defects(cause).pipe((chunk) => chunk.length === 0)
        const isInterrupted = Cause.isInterrupted(cause)

        if (hasLoggableFailure || hasDefects || isInterrupted) {
          const pretty = Cause.pretty(cause, { renderErrorCause: true })
          process.stderr.write(pretty + '\n')
        }
      }),
    ),
    runtime.runMain({
      disableErrorReporting: true,
      disablePrettyLogger: true,
    }),
  )
}
