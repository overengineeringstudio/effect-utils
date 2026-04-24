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
import { Cause, Effect, Layer, Logger, Option } from 'effect'

import { createLogCapture } from './LogCapture.ts'
import { detectOutputMode, viewOutputStreamStdoutLayer } from './OutputMode.node.ts'
import type { OutputModeTag, ViewOutputStreamTag } from './OutputMode.tsx'
import {
  type OutputMode,
  tty,
  ci,
  ciPlain,
  log,
  altScreen,
  json,
  ndjson,
  layer,
  isJson,
  isReact,
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
 * - `auto` (default) - Auto-detect based on environment (TTY, CI, captured stdout)
 * - `tty` - Live output with animated spinners and colors
 * - `alt-screen` - Live output in alternate screen buffer (fullscreen TUI)
 * - `ci` - Live output with static spinners and colors
 * - `ci-plain` - Live output with static spinners, no colors
 * - `log` - Final output only, no colors (for log files)
 * - `json` - Final JSON output (raw state; exit code signals success/failure)
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
  Options.withDescription('Output mode: auto, tty, alt-screen, ci, ci-plain, log, json, ndjson'),
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
 * Behavior by mode type:
 * - **Progressive React modes** (`tty`, `ci`, `ci-plain`, `alt-screen`): Captures all
 *   Effect logs and console output to prevent TUI corruption. Captured logs are
 *   accessible via `useCapturedLogs()` in React components.
 * - **JSON modes** (`json`, `ndjson`): Redirects logs to stderr, keeping stdout
 *   clean for JSON data only.
 * - **Final React modes** (`log`): No log capture (single render at end).
 *
 * @example
 * ```typescript
 * // In command handler:
 * myProgram().pipe(Effect.provide(outputModeLayer(output)))
 * ```
 */
export const outputModeLayer = (value: OutputModeValue): Layer.Layer<OutputModeTag> => {
  const mode = value === 'auto' ? detectOutputMode() : modeMap[value]

  // For JSON modes, configure logger to write to stderr
  // This keeps stdout clean for JSON data only
  if (isJson(mode) === true) {
    return Layer.merge(layer(mode), stderrLoggerLayer)
  }

  // For progressive React modes, capture logs to prevent TUI corruption
  if (isReact(mode) === true && mode.timing === 'progressive') {
    return Layer.unwrapScoped(
      Effect.gen(function* () {
        const { handle, loggerLayer } = yield* createLogCapture()

        const modeWithCapture: OutputMode = {
          ...mode,
          capturedLogs: handle,
        }

        return Layer.merge(layer(modeWithCapture), loggerLayer)
      }),
    )
  }

  // Final React modes (log) -- no capture needed
  return layer(mode)
}

/**
 * Complete TUI runtime layer: combines the output mode with the default
 * `ViewOutputStreamTag` binding (stdout). This is what every entry point
 * except `runResult` should provide — `runResult` overrides the view stream
 * to stderr internally.
 *
 * Prefer this over `outputModeLayer` when wiring a CLI main — it gives you
 * both dependencies in one call. `runTuiMain` uses it internally.
 */
export const tuiRuntimeLayer = (
  value: OutputModeValue,
): Layer.Layer<OutputModeTag | ViewOutputStreamTag> =>
  Layer.merge(outputModeLayer(value), viewOutputStreamStdoutLayer)

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
   * Format an error cause for stderr output.
   *
   * - `Option.some(message)` — write message to stderr
   * - `Option.none()` — suppress this error entirely (exit code still reflects it)
   *
   * @default `defaultFormatError` (verbose with stack traces via `Cause.pretty`)
   *
   * @example Suppress errors already represented in JSON output:
   * ```typescript
   * formatError: (cause) =>
   *   Cause.failures(cause).pipe(chunk =>
   *     [...chunk].some(e => e._tag === 'SyncFailedError')
   *   ) ? Option.none()
   *     : defaultFormatError(cause)
   * ```
   */
  readonly formatError?: (cause: Cause.Cause<unknown>) => Option.Option<string>
}

/** Verbose error formatter — full stack traces via `Cause.pretty`. This is the default. */
export const defaultFormatError = (cause: Cause.Cause<unknown>): Option.Option<string> =>
  Option.some(Cause.pretty(cause, { renderErrorCause: true }))

/** Compact error formatter — just error messages, no stack traces. For machine/agent output. */
export const compactFormatError = (cause: Cause.Cause<unknown>): Option.Option<string> => {
  const messages: string[] = []
  for (const failure of Cause.failures(cause)) {
    messages.push(failure instanceof Error ? failure.message : String(failure))
  }
  for (const defect of Cause.defects(cause)) {
    messages.push(defect instanceof Error ? defect.message : String(defect))
  }
  return messages.length > 0 ? Option.some(messages.join('\n')) : Option.none()
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
 * - Customizable error formatting via `formatError` (verbose, compact, or custom)
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
 * // With compact errors (for agent-friendly CLIs):
 * Cli.Command.run(myCommand, { name: 'my-cli', version })(process.argv).pipe(
 *   Effect.scoped,
 *   Effect.provide(baseLayer),
 *   runTuiMain(NodeRuntime, { formatError: compactFormatError })
 * )
 * ```
 */
// Data-last (pipeable): runTuiMain(runtime) or runTuiMain(runtime, options)
export function runTuiMain(
  runtime: TuiRuntime,
  options?: RunTuiMainOptions,
): <E, A>(effect: Effect.Effect<A, E>) => void
// Data-first: runTuiMain(runtime, effect) or runTuiMain(runtime, effect, options)
export function runTuiMain<E, A>(
  runtime: TuiRuntime,
  effect: Effect.Effect<A, E>,
  options?: RunTuiMainOptions,
): void
export function runTuiMain<E, A>(
  ...args: [
    runtime: TuiRuntime,
    effectOrOptions?: Effect.Effect<A, E> | RunTuiMainOptions,
    maybeOptions?: RunTuiMainOptions,
  ]
): ((effect: Effect.Effect<A, E>) => void) | void {
  const [runtime, effectOrOptions, maybeOptions] = args
  // Check if second argument is an Effect (data-first) or options/undefined (data-last)
  if (effectOrOptions !== undefined && Effect.isEffect(effectOrOptions) === true) {
    // Data-first: runTuiMain(runtime, effect, options?)
    return runTuiMainImpl({
      runtime,
      effect: effectOrOptions,
      options: maybeOptions,
    })
  }
  // Data-last: runTuiMain(runtime, options?) returns (effect) => void
  const options = effectOrOptions as RunTuiMainOptions | undefined
  return (effect: Effect.Effect<A, E>) => runTuiMainImpl({ runtime, effect, options })
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
  const formatError = options?.formatError ?? defaultFormatError

  effect.pipe(
    Effect.tapErrorCause((cause) =>
      Effect.sync(() => {
        const formatted = formatError(cause)
        if (Option.isSome(formatted) === true) {
          process.stderr.write(formatted.value + '\n')
        }
      }),
    ),
    runtime.runMain({
      disableErrorReporting: true,
      disablePrettyLogger: true,
    }),
  )
}
