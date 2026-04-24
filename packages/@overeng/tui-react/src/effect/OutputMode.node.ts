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

import {
  type OutputMode,
  OutputModeTag,
  ViewOutputStreamTag,
  tty,
  ci,
  json,
  isTTY,
} from './OutputMode.tsx'

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
 * Classify the stdout file descriptor type.
 *
 * Uses a single `fs.fstatSync(1)` call to determine how stdout is connected:
 * - `'pipe'` — FIFO (shell pipe, e.g. `cmd | cat`) or socket (Node.js `child_process` capture)
 * - `'file'` — redirected to a regular file (e.g. `cmd > out.txt`)
 * - `'other'` — anything else (e.g. `/dev/null`, block device)
 *
 * Note: Node.js `child_process.execFile`/`spawn` uses socketpairs for stdio on
 * both macOS and Linux, so sockets must be treated as captured (machine) output.
 */
export const stdoutFdType = (): 'pipe' | 'file' | 'other' => {
  if (typeof process === 'undefined') return 'other'
  try {
    const stat = fs.fstatSync(1)
    if (stat.isFIFO() === true || stat.isSocket() === true) return 'pipe'
    if (stat.isFile() === true) return 'file'
    return 'other'
  } catch {
    return 'other'
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
 * 1. `TUI_VISUAL=1` env → forces React mode (tty or ci based on TTY).
 * 2. Agent environment detected → `json` (structured output for coding agents).
 * 3. TTY + not CI → `tty` (animated terminal).
 * 4. TTY + CI → `ci` (static terminal).
 * 5. Non-TTY stdout (pipe, socket, regular file) → `json`. Same treatment
 *    regardless of which fd type — the stdout contract says "machine output
 *    when no human is watching," and for result-oriented commands built on
 *    `runResult` the view still renders (to stderr) in visual modes.
 *
 * Respects `NO_COLOR` and `NO_UNICODE` environment variables.
 */
export const detectOutputMode = (): OutputMode => {
  const forceVisual = isVisualEnvSet()
  const ttyEnv = isTTY()
  const ciEnv = isCIEnv()
  const agentEnv = isAgentEnv()
  const noColor = isNoColorSet()
  const noUnicode = isNoUnicodeSet()

  const withEnvOverrides = (mode: OutputMode): OutputMode => {
    if (mode._tag !== 'react') return mode
    let render = mode.render
    if (noColor === true) render = { ...render, colors: false }
    if (noUnicode === true) render = { ...render, unicode: false }
    return render === mode.render ? mode : { ...mode, render }
  }

  if (forceVisual === true) {
    return withEnvOverrides(ttyEnv === true && ciEnv === false ? tty : ci)
  }

  if (agentEnv === true) {
    return json
  }

  if (ttyEnv === true) {
    return withEnvOverrides(ciEnv === true ? ci : tty)
  }

  // Non-TTY — any flavour of captured/redirected stdout gets `json`.
  return json
}

/**
 * Layer that auto-detects mode from environment.
 */
export const detectLayer: Layer.Layer<OutputModeTag> = Layer.sync(OutputModeTag, detectOutputMode)

/**
 * Default layer binding the TUI view stream to `process.stdout`.
 *
 * Most entry points (`run`, interactive TUIs) want the view on stdout. Provide
 * this alongside your `OutputModeTag` layer so setup functions have a default.
 */
export const viewOutputStreamStdoutLayer: Layer.Layer<ViewOutputStreamTag> = Layer.succeed(
  ViewOutputStreamTag,
  process.stdout,
)

/**
 * Layer binding the TUI view stream to `process.stderr`.
 *
 * `runResult` provides this internally so the view never pollutes stdout, which
 * is reserved for the result payload. Callers generally should not provide it
 * explicitly.
 */
export const viewOutputStreamStderrLayer: Layer.Layer<ViewOutputStreamTag> = Layer.succeed(
  ViewOutputStreamTag,
  process.stderr,
)
