/**
 * Powerline-style shell prompt for CLI storybooks.
 *
 * Renders a terminal prompt line above the output showing the command being
 * demonstrated, styled after https://github.com/b-ryan/powerline-shell.
 *
 * Uses CSS border triangles for the angled separators (no custom font needed).
 */

import React from 'react'

/** Props for the powerline-style shell prompt component */
export interface PowerlinePromptProps {
  /** The CLI command being demonstrated (e.g. "deploy --env production") */
  command: string
  /** Working directory to display (defaults to "~/project") */
  cwd?: string | undefined
}

/** Color palette for the powerline prompt segments (cwd, prompt symbol, and background bar) */
export const COLORS = {
  cwd: { bg: '#0087af', fg: '#ffffff' },
  prompt: { bg: '#303030', fg: '#ffffff' },
  bar: '#1a1a2e',
} as const

/** Total height in pixels for the prompt bar */
export const PROMPT_HEIGHT = 22
/** Half the prompt height, used for CSS border triangle calculations */
export const HALF_HEIGHT = PROMPT_HEIGHT / 2

/** CSS border triangle separator — creates the powerline angled arrow effect */
export const Separator: React.FC<{ leftBg: string; rightBg: string }> = ({ leftBg, rightBg }) => (
  <span
    style={{
      display: 'inline-block',
      width: 0,
      height: 0,
      borderTop: `${HALF_HEIGHT}px solid ${rightBg}`,
      borderBottom: `${HALF_HEIGHT}px solid ${rightBg}`,
      borderLeft: `${HALF_HEIGHT}px solid ${leftBg}`,
    }}
  />
)

/** Powerline-style shell prompt showing the command being demonstrated */
export const PowerlinePrompt: React.FC<PowerlinePromptProps> = ({ command, cwd = '~/project' }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      height: PROMPT_HEIGHT,
      background: COLORS.bar,
      fontFamily: 'Monaco, Menlo, "DejaVu Sans Mono", Consolas, monospace',
      fontSize: '12px',
      lineHeight: `${PROMPT_HEIGHT}px`,
      overflow: 'hidden',
    }}
    data-testid="powerline-prompt"
  >
    {/* CWD segment */}
    <span
      style={{
        background: COLORS.cwd.bg,
        color: COLORS.cwd.fg,
        padding: '0 8px 0 10px',
        height: PROMPT_HEIGHT,
        lineHeight: `${PROMPT_HEIGHT}px`,
        display: 'inline-flex',
        alignItems: 'center',
        fontWeight: 'bold',
      }}
    >
      {cwd}
    </span>

    <Separator leftBg={COLORS.cwd.bg} rightBg={COLORS.prompt.bg} />

    {/* Prompt $ segment */}
    <span
      style={{
        background: COLORS.prompt.bg,
        color: COLORS.prompt.fg,
        padding: '0 8px',
        height: PROMPT_HEIGHT,
        lineHeight: `${PROMPT_HEIGHT}px`,
        display: 'inline-flex',
        alignItems: 'center',
      }}
    >
      $
    </span>

    <Separator leftBg={COLORS.prompt.bg} rightBg={COLORS.bar} />

    {/* Command text */}
    <span
      style={{
        color: '#e4e4e4',
        padding: '0 10px 0 6px',
        height: PROMPT_HEIGHT,
        lineHeight: `${PROMPT_HEIGHT}px`,
        display: 'inline-flex',
        alignItems: 'center',
      }}
    >
      {command}
    </span>
  </div>
)
