/**
 * OutputMode Node.js detection utilities.
 *
 * Contains functions that require `node:fs` for detecting pipe/file redirect
 * status of stdout. These are separated from `OutputMode.tsx` to keep the
 * main module browser-safe for Storybook and other browser environments.
 *
 * @module
 */

import * as fs from 'node:fs'

import { Layer } from 'effect'

import { type OutputMode, OutputModeTag, tty, ci, pipe, json, isTTY } from './OutputMode.tsx'

// =============================================================================
// Node.js Detection Helpers
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
 * Check if NO_UNICODE env var is set.
 */
const isNoUnicodeSet = (): boolean =>
  typeof process !== 'undefined' && process.env?.NO_UNICODE !== undefined

/**
 * Check if running in a CI environment.
 */
const isCIEnv = (): boolean => typeof process !== 'undefined' && process.env?.CI !== undefined

/**
 * Check if TUI_PIPE_MODE=visual env var is set to force visual output in pipes.
 */
const isPipeModeVisual = (): boolean =>
  typeof process !== 'undefined' && process.env?.TUI_PIPE_MODE === 'visual'

/**
 * Check if stdout is piped to another process (FIFO).
 *
 * Uses `fs.fstatSync(1).isFIFO()` to detect if stdout (fd 1) is a pipe/FIFO.
 * This is true when the command is piped to another process (e.g., `cmd | cat`).
 *
 * @returns `true` if stdout is a FIFO (pipe to process), `false` otherwise
 */
export const isPiped = (): boolean => {
  if (typeof process === 'undefined') return false
  try {
    const stat = fs.fstatSync(1)
    return stat.isFIFO()
  } catch {
    // If fstat fails (e.g., fd not available), assume not piped
    return false
  }
}

/**
 * Check if stdout is redirected to a file.
 *
 * Uses `fs.fstatSync(1).isFile()` to detect if stdout (fd 1) is a regular file.
 * This is true when the command output is redirected to a file (e.g., `cmd > file.txt`).
 *
 * @returns `true` if stdout is a file, `false` otherwise
 */
export const isRedirectedToFile = (): boolean => {
  if (typeof process === 'undefined') return false
  try {
    const stat = fs.fstatSync(1)
    return stat.isFile()
  } catch {
    // If fstat fails (e.g., fd not available), assume not redirected
    return false
  }
}

/**
 * Check if running inside a coding agent's shell environment.
 *
 * Detects known coding agents by their environment variables:
 * - `AGENT` (generic convention): OpenCode sets `AGENT=1`, Amp sets `AGENT=amp`
 * - `CLAUDE_PROJECT_DIR`: Claude Code (https://docs.anthropic.com/en/docs/claude-code/cli-reference)
 * - `CLAUDECODE`: Amp compatibility (https://ampcode.com/manual/appendix#toolboxes-reference)
 * - `OPENCODE`: OpenCode (verified empirically)
 * - `CLINE_ACTIVE`: Cline VS Code extension (https://github.com/cline/cline/blob/main/src/hosts/vscode/terminal/VscodeTerminalRegistry.ts)
 * - `CODEX_SANDBOX`: OpenAI Codex CLI (https://github.com/openai/codex/blob/main/codex-rs/core/src/spawn.rs)
 *
 * Note: Some agents (Cursor, Windsurf, Aider) don't set identifiable env vars.
 * Use `--output=json` or `TUI_VISUAL=1` for those.
 */
export const isAgentEnv = (): boolean => {
  if (typeof process === 'undefined') return false
  const env = process.env
  return (
    // Generic agent convention (OpenCode: AGENT=1, Amp: AGENT=amp)
    (env?.AGENT !== undefined && env.AGENT !== '' && env.AGENT !== '0' && env.AGENT !== 'false') ||
    // Claude Code
    env?.CLAUDE_PROJECT_DIR !== undefined ||
    // Amp (also sets AGENT, but CLAUDECODE is a secondary signal)
    env?.CLAUDECODE !== undefined ||
    // OpenCode (also sets AGENT, but OPENCODE is a secondary signal)
    env?.OPENCODE !== undefined ||
    // Cline (VS Code extension)
    env?.CLINE_ACTIVE !== undefined ||
    // OpenAI Codex CLI
    env?.CODEX_SANDBOX !== undefined
  )
}

/**
 * Auto-detect the appropriate OutputMode based on environment.
 *
 * Detection logic:
 * 1. `TUI_VISUAL=1` env → forces React mode (tty or ci based on TTY)
 * 2. Agent environment detected → `json` (structured output for coding agents)
 * 3. TTY + not CI → `tty` (animated terminal)
 * 4. TTY + CI → `ci` (static terminal)
 * 5. Non-TTY + piped → `json` (machine-readable for downstream tools)
 * 6. Non-TTY + file redirect → `pipe` (visual output for file storage)
 *
 * Respects `NO_COLOR`, `NO_UNICODE`, and `TUI_PIPE_MODE` environment variables.
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
  const agentEnv = isAgentEnv()
  const noColor = isNoColorSet()
  const noUnicode = isNoUnicodeSet()
  const pipedEnv = isPiped()
  const forcePipeVisual = isPipeModeVisual()

  // Helper to apply noColor and noUnicode
  const withEnvOverrides = (mode: OutputMode): OutputMode => {
    if (mode._tag !== 'react') return mode
    let render = mode.render
    if (noColor === true) render = { ...render, colors: false }
    if (noUnicode === true) render = { ...render, unicode: false }
    return render === mode.render ? mode : { ...mode, render }
  }

  if (forceVisual === true) {
    // Forced visual: use tty if actually TTY, otherwise ci mode
    return withEnvOverrides(ttyEnv === true && ciEnv === false ? tty : ci)
  }

  // Agent environment → JSON output for structured consumption
  if (agentEnv === true) {
    return json
  }

  // Auto-detect based on environment
  if (ttyEnv === true) {
    return withEnvOverrides(ciEnv === true ? ci : tty)
  }

  // Non-TTY: distinguish between pipe and file redirect
  // Piped to another process (cmd | cat) → JSON for machine consumption
  // Unless TUI_PIPE_MODE=visual is set
  if (pipedEnv === true && forcePipeVisual === false) {
    return json
  }

  // File redirect or TUI_PIPE_MODE=visual → pipe mode (final React output)
  return withEnvOverrides(pipe)
}

/** @deprecated Use `detectOutputMode()` instead */
export const detect = detectOutputMode

/**
 * Layer that auto-detects mode from environment.
 */
export const detectLayer: Layer.Layer<OutputModeTag> = Layer.sync(OutputModeTag, detectOutputMode)
