/**
 * OutputMode - Unified output configuration for TUI applications.
 *
 * Combines what was previously split between OutputMode (Effect-level) and
 * RenderMode (React-level) into a single discriminated union type.
 *
 * ## Mode Types
 *
 * - **React modes** (`_tag: 'react'`): Render React components to terminal
 *   - Include `RenderConfig` for animation, colors, fullscreen
 *   - Can be progressive (real-time) or final (single output at end)
 *
 * - **JSON modes** (`_tag: 'json'`): Output JSON to stdout
 *   - No render config (no React rendering)
 *   - Can be progressive (NDJSON streaming) or final (single JSON at end)
 *
 * ## Presets
 *
 * Use named presets for common scenarios:
 * - `tty` - Interactive terminal (progressive, animated, colors)
 * - `ci` - CI environment (progressive, static spinners, colors)
 * - `pipe` - Piped output (final, static, colors)
 * - `log` - Log file (final, static, no colors)
 * - `fullscreen` - Alternate buffer mode (progressive, animated, colors)
 * - `json` - JSON output (final)
 * - `ndjson` - NDJSON streaming (progressive)
 *
 * @example
 * ```typescript
 * import { OutputMode, tty, ci, json, detect } from '@overeng/tui-react'
 *
 * // Use a preset
 * const mode = tty
 *
 * // Auto-detect from environment
 * const mode = detect({ json: false, stream: false })
 *
 * // Check mode type
 * if (mode._tag === 'react') {
 *   console.log('Animation:', mode.render.animation)
 * }
 * ```
 *
 * @module
 */

import { Context, Layer } from 'effect'
import React, { createContext, useContext, type ReactNode } from 'react'

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for React rendering behavior.
 * Only applies to React output modes.
 */
export interface RenderConfig {
  /** Whether animations (spinners, etc.) should animate or show static character */
  readonly animation: boolean
  /** Whether to output ANSI color codes */
  readonly colors: boolean
  /** Whether to use alternate screen buffer (fullscreen mode) */
  readonly alternate: boolean
}

/**
 * React output mode - renders React components to terminal.
 */
export interface ReactOutputMode {
  readonly _tag: 'react'
  /** Whether output is progressive (real-time) or final (single output at end) */
  readonly timing: 'progressive' | 'final'
  /** Render configuration for React components */
  readonly render: RenderConfig
}

/**
 * JSON output mode - outputs JSON to stdout.
 */
export interface JsonOutputMode {
  readonly _tag: 'json'
  /** Whether output is progressive (NDJSON streaming) or final (single JSON at end) */
  readonly timing: 'progressive' | 'final'
}

/**
 * Unified output mode type.
 *
 * Discriminated union that covers all output scenarios:
 * - React rendering with configurable animation/colors
 * - JSON output with streaming or final modes
 */
export type OutputMode = ReactOutputMode | JsonOutputMode

// =============================================================================
// Presets
// =============================================================================

/**
 * TTY mode - Interactive terminal.
 *
 * Progressive React rendering with animations and colors.
 * Use this when running in an interactive terminal.
 */
export const tty: OutputMode = {
  _tag: 'react',
  timing: 'progressive',
  render: { animation: true, colors: true, alternate: false },
}

/**
 * CI mode - Continuous Integration environment.
 *
 * Live React rendering with static spinners and colors.
 * Use this in CI environments that support ANSI colors but not cursor movement.
 */
export const ci: OutputMode = {
  _tag: 'react',
  timing: 'progressive',
  render: { animation: false, colors: true, alternate: false },
}

/**
 * CI Plain mode - CI environment without color support.
 *
 * Live React rendering with static spinners and no colors.
 * Use this in CI environments that don't support ANSI escape codes.
 */
export const ciPlain: OutputMode = {
  _tag: 'react',
  timing: 'progressive',
  render: { animation: false, colors: false, alternate: false },
}

/**
 * Pipe mode - Piped/redirected output.
 *
 * Final React rendering (single output at end) with static spinners and colors.
 * Use this when stdout is redirected to a file or another process.
 */
export const pipe: OutputMode = {
  _tag: 'react',
  timing: 'final',
  render: { animation: false, colors: true, alternate: false },
}

/**
 * Log mode - Plain text log output.
 *
 * Final React rendering with static spinners and no colors.
 * Use this when writing to log files that should be plain text.
 */
export const log: OutputMode = {
  _tag: 'react',
  timing: 'final',
  render: { animation: false, colors: false, alternate: false },
}

/**
 * Alt-screen mode - Alternate screen buffer.
 *
 * Live React rendering in alternate screen buffer.
 * Use this for fullscreen TUI applications.
 *
 * **Note:** Requires Bun runtime and OpenTUI packages.
 */
export const altScreen: OutputMode = {
  _tag: 'react',
  timing: 'progressive',
  render: { animation: true, colors: true, alternate: true },
}

/** @deprecated Use `altScreen` instead */
export const fullscreen = altScreen

/**
 * JSON mode - Single JSON output at completion.
 *
 * Outputs final state as JSON when command completes.
 * Use this for scripting and programmatic consumption.
 */
export const json: OutputMode = {
  _tag: 'json',
  timing: 'final',
}

/**
 * NDJSON mode - Streaming JSON output.
 *
 * Outputs each state change as a JSON line (newline-delimited JSON).
 * Use this for real-time streaming to other processes.
 */
export const ndjson: OutputMode = {
  _tag: 'json',
  timing: 'progressive',
}

// =============================================================================
// RenderConfig Presets (for direct use in React contexts)
// =============================================================================

/**
 * RenderConfig for interactive TTY.
 * Animated spinners with colors.
 */
export const ttyRenderConfig: RenderConfig = { animation: true, colors: true, alternate: false }

/**
 * RenderConfig for CI environments.
 * Static spinners with colors.
 */
export const ciRenderConfig: RenderConfig = { animation: false, colors: true, alternate: false }

/**
 * RenderConfig for CI environments without color support.
 * Live timing (React re-renders) with static spinners, no colors.
 */
export const ciPlainRenderConfig: RenderConfig = {
  animation: false,
  colors: false,
  alternate: false,
}

/**
 * RenderConfig for piped output.
 * Final timing with static spinners, with colors.
 */
export const pipeRenderConfig: RenderConfig = { animation: false, colors: true, alternate: false }

/**
 * RenderConfig for log files.
 * Final timing with static spinners, no colors.
 */
export const logRenderConfig: RenderConfig = { animation: false, colors: false, alternate: false }

/**
 * RenderConfig for alt-screen mode.
 * Animated spinners with colors in alternate buffer.
 */
export const altScreenRenderConfig: RenderConfig = {
  animation: true,
  colors: true,
  alternate: true,
}

/** @deprecated Use `altScreenRenderConfig` instead */
export const fullscreenRenderConfig = altScreenRenderConfig

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
 *   if (mode._tag === 'react') {
 *     console.log('Animation:', mode.render.animation)
 *   }
 * })
 * ```
 */
export class OutputModeTag extends Context.Tag('OutputMode')<OutputModeTag, OutputMode>() {}

// =============================================================================
// Detection & Factory
// =============================================================================

/**
 * Check if visual mode is forced via env var.
 */
const isVisualEnvSet = (): boolean =>
  typeof process !== 'undefined' && process.env?.TUI_VISUAL === '1'

/**
 * Check if NO_COLOR env var is set.
 */
const isNoColorSet = (): boolean =>
  typeof process !== 'undefined' && process.env?.NO_COLOR !== undefined

/**
 * Check if running in a CI environment.
 */
const isCIEnv = (): boolean => typeof process !== 'undefined' && process.env?.CI !== undefined

/**
 * Check if running in a TTY environment.
 */
export const isTTY = (): boolean => typeof process !== 'undefined' && process.stdout?.isTTY === true

/**
 * Check if running in a non-TTY environment.
 */
export const isNonTTY = (): boolean => !isTTY()

/**
 * Auto-detect the appropriate OutputMode based on environment.
 *
 * Detection logic:
 * 1. `TUI_VISUAL=1` env → forces React mode (tty or ci based on TTY)
 * 2. TTY + not CI → `tty` (animated terminal)
 * 3. TTY + CI → `ci` (static terminal)
 * 4. Non-TTY → `pipe` (final output only)
 *
 * Respects `NO_COLOR` environment variable for disabling colors.
 *
 * @returns Detected OutputMode
 *
 * @example
 * ```typescript
 * const mode = detectOutputMode()
 * // Returns appropriate mode based on environment
 * ```
 */
export const detectOutputMode = (): OutputMode => {
  // Check environment
  const forceVisual = isVisualEnvSet()
  const ttyEnv = isTTY()
  const ciEnv = isCIEnv()
  const noColor = isNoColorSet()

  // Helper to apply noColor
  const withColorCheck = (mode: ReactOutputMode): OutputMode =>
    noColor ? { ...mode, render: { ...mode.render, colors: false } } : mode

  if (forceVisual) {
    // Forced visual: use tty if actually TTY, otherwise ci mode
    return withColorCheck(ttyEnv && !ciEnv ? tty : ci)
  }

  // Auto-detect based on environment
  if (ttyEnv) {
    return withColorCheck(ciEnv ? ci : tty)
  }

  // Non-TTY defaults to pipe (final React output, useful for piping)
  // Use json explicitly via --output=json if you want JSON
  return withColorCheck(pipe)
}

/** @deprecated Use `detectOutputMode()` instead */
export const detect = detectOutputMode

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if mode is a React mode.
 */
export const isReact = (mode: OutputMode): mode is ReactOutputMode => mode._tag === 'react'

/**
 * Check if mode is a JSON mode.
 */
export const isJson = (mode: OutputMode): mode is JsonOutputMode => mode._tag === 'json'

/**
 * Check if mode is progressive (real-time updates).
 */
export const isProgressive = (mode: OutputMode): boolean => mode.timing === 'progressive'

/**
 * Check if mode is final (single output at end).
 */
export const isFinal = (mode: OutputMode): boolean => mode.timing === 'final'

/**
 * Check if mode has animation enabled.
 * Returns false for JSON modes.
 */
export const isAnimated = (mode: OutputMode): boolean =>
  mode._tag === 'react' && mode.render.animation

/**
 * Check if mode has colors enabled.
 * Returns false for JSON modes.
 */
export const hasColors = (mode: OutputMode): boolean => mode._tag === 'react' && mode.render.colors

/**
 * Check if mode uses alternate screen buffer.
 * Returns false for JSON modes.
 */
export const isAlternate = (mode: OutputMode): boolean =>
  mode._tag === 'react' && mode.render.alternate

// =============================================================================
// Render Config Helpers
// =============================================================================

/**
 * Get render config from mode, with defaults for JSON modes.
 * Useful when you need a RenderConfig even for JSON modes.
 */
export const getRenderConfig = (mode: OutputMode): RenderConfig => {
  if (mode._tag === 'react') return mode.render
  // JSON modes get static, no-color config
  return { animation: false, colors: false, alternate: false }
}

// =============================================================================
// React Context
// =============================================================================

/**
 * Default render config (used when no provider is present).
 */
const defaultRenderConfig: RenderConfig = { animation: true, colors: true, alternate: false }

const RenderConfigContext = createContext<RenderConfig>(defaultRenderConfig)

/**
 * Provider for render configuration in React components.
 *
 * Components like `Spinner` use this to determine their behavior.
 *
 * @example
 * ```tsx
 * <RenderConfigProvider config={{ animation: false, colors: true, alternate: false }}>
 *   <App />
 * </RenderConfigProvider>
 * ```
 */
export const RenderConfigProvider: React.FC<{
  config: RenderConfig
  children: ReactNode
}> = ({ config, children }) => {
  return <RenderConfigContext.Provider value={config}>{children}</RenderConfigContext.Provider>
}

/**
 * Hook to access the current render configuration.
 *
 * @returns The current RenderConfig
 *
 * @example
 * ```tsx
 * const config = useRenderConfig()
 * if (!config.animation) {
 *   return <Text>Loading...</Text>
 * }
 * return <AnimatedSpinner />
 * ```
 */
export const useRenderConfig = (): RenderConfig => {
  return useContext(RenderConfigContext)
}

// =============================================================================
// Legacy Context (for migration)
// =============================================================================
// ANSI Utilities
// =============================================================================

/**
 * Strip ANSI escape codes from a string.
 *
 * @param str - String potentially containing ANSI codes
 * @returns Plain text without ANSI codes
 *
 * @example
 * ```typescript
 * stripAnsi('\x1b[32mHello\x1b[0m') // => 'Hello'
 * ```
 */
export const stripAnsi = (str: string): string => {
  // eslint-disable-next-line no-control-regex
  const ansiRegex = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g
  return str.replace(ansiRegex, '')
}

// =============================================================================
// Layers
// =============================================================================

/**
 * Create a layer that provides a specific output mode.
 */
export const layer = (mode: OutputMode): Layer.Layer<OutputModeTag> =>
  Layer.succeed(OutputModeTag, mode)

/** Layer for tty mode */
export const ttyLayer: Layer.Layer<OutputModeTag> = layer(tty)

/** Layer for ci mode */
export const ciLayer: Layer.Layer<OutputModeTag> = layer(ci)

/** Layer for ci-plain mode */
export const ciPlainLayer: Layer.Layer<OutputModeTag> = layer(ciPlain)

/** Layer for pipe mode */
export const pipeLayer: Layer.Layer<OutputModeTag> = layer(pipe)

/** Layer for log mode */
export const logLayer: Layer.Layer<OutputModeTag> = layer(log)

/** Layer for alt-screen mode */
export const altScreenLayer: Layer.Layer<OutputModeTag> = layer(altScreen)

/** @deprecated Use `altScreenLayer` instead */
export const fullscreenLayer = altScreenLayer

/** Layer for json mode */
export const jsonLayer: Layer.Layer<OutputModeTag> = layer(json)

/** Layer for ndjson mode */
export const ndjsonLayer: Layer.Layer<OutputModeTag> = layer(ndjson)

/**
 * Layer that auto-detects mode from environment.
 */
export const detectLayer: Layer.Layer<OutputModeTag> = Layer.sync(OutputModeTag, detectOutputMode)
