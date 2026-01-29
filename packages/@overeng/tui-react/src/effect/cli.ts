/**
 * Effect CLI Integration
 *
 * Provides reusable CLI options for tui-react output modes.
 * Use these options in your Effect CLI commands to get consistent
 * `--json`, `--stream`, and `--visual` flags across all CLI tools.
 *
 * @example
 * ```typescript
 * import { Command, Options } from "@effect/cli"
 * import { Effect } from "effect"
 * import { outputModeOptions, outputModeLayerFromFlags } from "@overeng/tui-react"
 *
 * const myCommand = Command.make("my-cmd", {
 *   name: Options.text("name"),
 *   ...outputModeOptions,  // Adds --json, --stream, --visual flags
 * }, (args) =>
 *   myProgram(args.name).pipe(
 *     Effect.provide(outputModeLayerFromFlags(args))
 *   )
 * )
 * ```
 *
 * @module
 */

import { Options } from '@effect/cli'
import { Layer } from 'effect'

import { OutputModeTag, fromFlags, fromFlagsWithTTY } from './OutputMode.ts'

// =============================================================================
// Common CLI Options
// =============================================================================

/**
 * `--json` / `-j` flag for JSON output mode.
 *
 * When enabled, output is rendered as JSON instead of visual terminal UI.
 * Combined with `--stream`, produces NDJSON (newline-delimited JSON).
 */
export const jsonOption = Options.boolean('json').pipe(
  Options.withAlias('j'),
  Options.withDescription('Output as JSON instead of visual rendering'),
  Options.withDefault(false),
)

/**
 * `--stream` flag for streaming JSON output (NDJSON).
 *
 * When enabled along with `--json`, outputs each state change as a
 * separate JSON line (newline-delimited JSON / NDJSON format).
 *
 * Without `--json`, this flag has no effect.
 */
export const streamOption = Options.boolean('stream').pipe(
  Options.withDescription('Stream JSON output (NDJSON) - requires --json'),
  Options.withDefault(false),
)

/**
 * `--visual` flag for forcing visual output mode.
 *
 * When enabled, forces progressive-visual mode regardless of TTY detection.
 * Useful for debugging in non-TTY environments or CI.
 *
 * Can also be set via `TUI_VISUAL=1` environment variable.
 * Flag takes precedence over env var.
 */
export const visualOption = Options.boolean('visual').pipe(
  Options.withDescription('Force visual output mode (ignores TTY detection)'),
  Options.withDefault(false),
)

/**
 * Combined output mode options object.
 *
 * Spread this into your command options to add `--json`, `--stream`, and `--visual` flags:
 *
 * @example
 * ```typescript
 * const myCommand = Command.make("cmd", {
 *   myOption: Options.text("my-option"),
 *   ...outputModeOptions,
 * }, handler)
 * ```
 */
export const outputModeOptions = {
  json: jsonOption,
  stream: streamOption,
  visual: visualOption,
} as const

/**
 * Type for the parsed output mode flags.
 */
export interface OutputModeFlags {
  readonly json: boolean
  readonly stream: boolean
  readonly visual: boolean
}

// =============================================================================
// Layer Helpers
// =============================================================================

/**
 * Create an OutputMode layer from parsed CLI flags.
 *
 * Uses `fromFlags` which maps:
 * - `json=false` -> `progressive-visual`
 * - `json=true, stream=false` -> `final-json`
 * - `json=true, stream=true` -> `progressive-json`
 *
 * @example
 * ```typescript
 * const layer = outputModeLayerFromFlags({ json: true, stream: false })
 * // Returns Layer for 'final-json' mode
 * ```
 */
export const outputModeLayerFromFlags = (flags: OutputModeFlags): Layer.Layer<OutputModeTag> =>
  Layer.succeed(OutputModeTag, fromFlags({ json: flags.json, stream: flags.stream }))

/**
 * Create an OutputMode layer from CLI flags with TTY detection.
 *
 * Priority (highest to lowest):
 * 1. `--json` flag (forces JSON mode)
 * 2. `--visual` flag (forces visual mode)
 * 3. `TUI_VISUAL=1` env var (forces visual mode)
 * 4. TTY detection (visual if TTY, JSON if not)
 *
 * This is useful for commands that should output JSON when piped,
 * but can be forced to visual mode for debugging.
 */
export const outputModeLayerFromFlagsWithTTY = (
  flags: OutputModeFlags,
): Layer.Layer<OutputModeTag> => Layer.succeed(OutputModeTag, fromFlagsWithTTY(flags))
