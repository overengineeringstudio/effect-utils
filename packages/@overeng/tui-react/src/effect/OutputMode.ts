/**
 * OutputMode Service
 *
 * Determines how command output is rendered:
 * - progressive-visual: Real-time React rendering to terminal
 * - final-visual: Single output at completion (non-TTY fallback)
 * - final-json: JSON output at completion
 * - progressive-json: NDJSON streaming
 *
 * @example
 * ```typescript
 * import { OutputMode } from '@overeng/tui-react'
 *
 * // Determine mode from CLI flags
 * const mode = OutputMode.fromFlags(json, stream)
 *
 * // Provide to command
 * runDeploy(services).pipe(
 *   Effect.provide(Layer.succeed(OutputMode, mode))
 * )
 * ```
 */

import { Context, Layer } from 'effect'

// =============================================================================
// Types
// =============================================================================

/**
 * Output mode variants.
 *
 * - `progressive-visual`: Real-time updates in terminal (React rendering, inline)
 * - `progressive-visual-alternate`: Full-screen alternate buffer mode (requires Bun + OpenTUI)
 * - `final-visual`: Single output at completion (for non-TTY)
 * - `final-json`: JSON output at completion
 * - `progressive-json`: NDJSON streaming
 */
export type OutputMode =
  | { readonly _tag: 'progressive-visual' }
  | { readonly _tag: 'progressive-visual-alternate' }
  | { readonly _tag: 'final-visual' }
  | { readonly _tag: 'final-json' }
  | { readonly _tag: 'progressive-json' }

// =============================================================================
// Constructors
// =============================================================================

/**
 * Create progressive-visual mode.
 * Real-time React rendering to terminal (inline mode).
 */
export const progressiveVisual: OutputMode = { _tag: 'progressive-visual' }

/**
 * Create progressive-visual-alternate mode.
 * Full-screen alternate buffer mode using OpenTUI.
 *
 * **Note:** Requires Bun runtime and OpenTUI packages.
 * Falls back to progressive-visual (inline) if not available.
 */
export const progressiveVisualAlternate: OutputMode = { _tag: 'progressive-visual-alternate' }

/**
 * Create final-visual mode.
 * Single output at completion (non-TTY fallback).
 */
export const finalVisual: OutputMode = { _tag: 'final-visual' }

/**
 * Create final-json mode.
 * JSON output at completion.
 */
export const finalJson: OutputMode = { _tag: 'final-json' }

/**
 * Create progressive-json mode.
 * NDJSON streaming output.
 */
export const progressiveJson: OutputMode = { _tag: 'progressive-json' }

// =============================================================================
// Service Tag
// =============================================================================

/**
 * OutputMode service tag for Effect dependency injection.
 *
 * @example
 * ```typescript
 * const program = Effect.gen(function* () {
 *   const mode = yield* OutputMode
 *   if (mode._tag === 'final-json') {
 *     // JSON mode specific logic
 *   }
 * })
 * ```
 */
export class OutputModeTag extends Context.Tag('OutputMode')<OutputModeTag, OutputMode>() {}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create OutputMode from CLI flags.
 *
 * @param options.json - Whether --json flag is set
 * @param options.stream - Whether --stream flag is set
 * @returns OutputMode based on flag combination
 *
 * @example
 * ```typescript
 * // --json
 * fromFlags({ json: true, stream: false })  // => final-json
 *
 * // --json --stream
 * fromFlags({ json: true, stream: true })   // => progressive-json
 *
 * // no flags
 * fromFlags({ json: false, stream: false }) // => progressive-visual
 * ```
 */
export const fromFlags = ({ json, stream }: { json: boolean; stream: boolean }): OutputMode => {
  if (json && stream) return progressiveJson
  if (json) return finalJson
  return progressiveVisual
}

/**
 * Check if visual mode is forced via env var.
 */
const isVisualEnvSet = (): boolean =>
  typeof process !== 'undefined' && process.env?.TUI_VISUAL === '1'

/**
 * Create OutputMode from CLI flags with TTY detection.
 *
 * Priority (highest to lowest):
 * 1. `--json` flag (forces JSON mode)
 * 2. `--visual` flag (forces visual mode)
 * 3. `TUI_VISUAL=1` env var (forces visual mode)
 * 4. TTY detection (visual if TTY, JSON if not)
 *
 * @param options.json - Whether --json flag is set
 * @param options.stream - Whether --stream flag is set
 * @param options.visual - Whether --visual flag is set (optional, defaults to false)
 * @returns OutputMode based on flags and environment
 */
export const fromFlagsWithTTY = ({
  json,
  stream,
  visual = false,
}: {
  json: boolean
  stream: boolean
  visual?: boolean
}): OutputMode => {
  // JSON flags take highest priority
  if (json && stream) return progressiveJson
  if (json) return finalJson

  // Visual flag takes precedence over env var and TTY detection
  if (visual || isVisualEnvSet()) return progressiveVisual

  // Fall back to TTY detection
  const isTTY = typeof process !== 'undefined' && process.stdout?.isTTY === true

  // In TTY: progressive visual rendering
  // In non-TTY (piped): default to final-json for script consumption
  return isTTY ? progressiveVisual : finalJson
}

/**
 * Auto-detect output mode from environment.
 *
 * Checks if stdout is a TTY:
 * - TTY: progressive-visual (real-time updates with cursor manipulation)
 * - Non-TTY: final-visual (single output, safe for pipes and CI)
 *
 * Use this when you want automatic mode selection without explicit flags.
 *
 * @example
 * ```typescript
 * // Auto-detect mode (TTY → progressive-visual, pipe → final-visual)
 * const mode = OutputMode.detect()
 *
 * runDeploy(services).pipe(
 *   Effect.provide(Layer.succeed(OutputMode, mode))
 * )
 * ```
 */
export const detect = (): OutputMode => {
  const isTTY = typeof process !== 'undefined' && process.stdout?.isTTY === true
  // In TTY: progressive visual rendering
  // In non-TTY (piped): default to final-json for script consumption
  return isTTY ? progressiveVisual : finalJson
}

/**
 * Check if running in a TTY environment.
 *
 * @returns true if stdout is a TTY
 */
export const isTTY = (): boolean => typeof process !== 'undefined' && process.stdout?.isTTY === true

/**
 * Check if running in a non-TTY environment (piped, CI, etc.).
 *
 * @returns true if stdout is NOT a TTY
 */
export const isNonTTY = (): boolean => !isTTY()

// =============================================================================
// Guards
// =============================================================================

/**
 * Check if mode is a visual mode (progressive-visual, progressive-visual-alternate, or final-visual).
 */
export const isVisual = (mode: OutputMode): boolean =>
  mode._tag === 'progressive-visual' ||
  mode._tag === 'progressive-visual-alternate' ||
  mode._tag === 'final-visual'

/**
 * Check if mode is a JSON mode (final-json or progressive-json).
 */
export const isJson = (mode: OutputMode): boolean =>
  mode._tag === 'final-json' || mode._tag === 'progressive-json'

/**
 * Check if mode is progressive (has real-time updates).
 */
export const isProgressive = (mode: OutputMode): boolean =>
  mode._tag === 'progressive-visual' ||
  mode._tag === 'progressive-visual-alternate' ||
  mode._tag === 'progressive-json'

/**
 * Check if mode is final (single output at end).
 */
export const isFinal = (mode: OutputMode): boolean =>
  mode._tag === 'final-visual' || mode._tag === 'final-json'

// =============================================================================
// Layers
// =============================================================================

/**
 * Create a layer that provides a specific output mode.
 */
export const layer = (mode: OutputMode): Layer.Layer<OutputModeTag> =>
  Layer.succeed(OutputModeTag, mode)

/**
 * Layer for progressive-visual mode.
 */
export const progressiveVisualLayer: Layer.Layer<OutputModeTag> = layer(progressiveVisual)

/**
 * Layer for progressive-visual-alternate mode.
 * Note: Falls back to progressive-visual if OpenTUI is not available.
 */
export const progressiveVisualAlternateLayer: Layer.Layer<OutputModeTag> = layer(
  progressiveVisualAlternate,
)

/**
 * Layer for final-visual mode.
 */
export const finalVisualLayer: Layer.Layer<OutputModeTag> = layer(finalVisual)

/**
 * Layer for final-json mode.
 */
export const finalJsonLayer: Layer.Layer<OutputModeTag> = layer(finalJson)

/**
 * Layer for progressive-json mode.
 */
export const progressiveJsonLayer: Layer.Layer<OutputModeTag> = layer(progressiveJson)

/**
 * Layer that auto-detects mode from environment.
 * TTY → progressive-visual, non-TTY → final-json.
 */
export const detectLayer: Layer.Layer<OutputModeTag> = Layer.sync(OutputModeTag, detect)

/**
 * Create a layer from CLI flags with TTY detection.
 *
 * @param options.json - Whether --json flag is set
 * @param options.stream - Whether --stream flag is set
 */
export const fromFlagsLayer = ({
  json,
  stream,
}: {
  json: boolean
  stream: boolean
}): Layer.Layer<OutputModeTag> => layer(fromFlagsWithTTY({ json, stream }))
