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
import { Layer } from 'effect'

import {
  type OutputMode,
  OutputModeTag,
  tty,
  ci,
  pipe,
  log,
  fullscreen,
  json,
  ndjson,
  detectOutputMode,
  layer,
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
  'ci',
  'pipe',
  'log',
  'fullscreen',
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
 * - `tty` - Animated terminal UI with colors
 * - `ci` - Static terminal UI with colors (CI-friendly)
 * - `pipe` - Final output only with colors (for piping)
 * - `log` - Plain text output, no colors (for log files)
 * - `fullscreen` - Alternate screen mode with animation
 * - `json` - JSON output (final state only)
 * - `ndjson` - Streaming JSON output (newline-delimited)
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
    'Output mode: auto (default), tty, ci, pipe, log, fullscreen, json, ndjson',
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
  tty,
  ci,
  pipe,
  log,
  fullscreen,
  json,
  ndjson,
}

/**
 * Create an OutputMode layer from the `--output` flag value.
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
 * outputModeLayer('json')  // JSON output
 * outputModeLayer('tty')   // Animated terminal
 * outputModeLayer('auto')  // Auto-detect from environment
 * ```
 */
export const outputModeLayer = (value: OutputModeValue): Layer.Layer<OutputModeTag> => {
  if (value === 'auto') {
    return layer(detectOutputMode())
  }
  return layer(modeMap[value])
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
