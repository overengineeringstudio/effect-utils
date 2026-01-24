/**
 * Progress Indicators
 *
 * Components for showing progress in CLI output.
 * - Determinate: progress bar with known total
 * - Indeterminate: spinner for unknown duration
 */

import { styled } from './styled.ts'

// =============================================================================
// Progress Bar Symbols
// =============================================================================

/** Unicode block characters for progress bars */
export const progressSymbols = {
  /** Filled block: █ */
  filled: '█',
  /** Empty block: ░ */
  empty: '░',
  /** Half block (for smoother rendering): ▌ */
  half: '▌',
} as const

// =============================================================================
// Spinner
// =============================================================================

/** Braille spinner animation frames */
export const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/**
 * Get a spinner frame by index (wraps around).
 *
 * @example
 * ```ts
 * let frame = 0
 * setInterval(() => {
 *   process.stdout.write(`\r${spinner(frame++)} Loading...`)
 * }, 80)
 * ```
 */
export const spinner = (frame: number): string => spinnerFrames[frame % spinnerFrames.length]!

// =============================================================================
// Progress Bar
// =============================================================================

/** Options for progress bar rendering */
export type ProgressOptions = {
  /** Width of the bar in characters (default: 20) */
  width?: number
  /** Character for filled portion (default: █) */
  filled?: string
  /** Character for empty portion (default: ░) */
  empty?: string
  /** Style function for filled portion (default: styled.info/cyan) */
  filledStyle?: (s: string) => string
  /** Style function for empty portion (default: styled.muted) */
  emptyStyle?: (s: string) => string
}

const defaultProgressOptions: Required<ProgressOptions> = {
  width: 20,
  filled: progressSymbols.filled,
  empty: progressSymbols.empty,
  filledStyle: styled.cyan,
  emptyStyle: styled.muted,
}

/**
 * Render a progress bar.
 *
 * @example
 * ```ts
 * // Basic usage
 * console.log(progress({ current: 45, total: 100 }))
 * // ████████████░░░░░░░░
 *
 * // With custom width
 * console.log(progress({ current: 45, total: 100, options: { width: 10 } }))
 * // █████░░░░░
 *
 * // In a status line
 * console.log(`Downloading ${progress({ current: 45, total: 100 })} 45%`)
 * // Downloading ████████████░░░░░░░░ 45%
 * ```
 */
export const progress = ({
  current,
  total,
  options,
}: {
  current: number
  total: number
  options?: ProgressOptions
}): string => {
  const opts = { ...defaultProgressOptions, ...options }
  const ratio = Math.min(Math.max(current / Math.max(total, 1), 0), 1)
  const filledCount = Math.round(ratio * opts.width)
  const emptyCount = opts.width - filledCount

  const filledPart = opts.filledStyle(opts.filled.repeat(filledCount))
  const emptyPart = opts.emptyStyle(opts.empty.repeat(emptyCount))

  return `${filledPart}${emptyPart}`
}

// =============================================================================
// Elapsed Time Formatting
// =============================================================================

/**
 * Format elapsed time in a human-readable way.
 *
 * @example
 * ```ts
 * formatElapsed(5000)   // "5s"
 * formatElapsed(65000)  // "1m 5s"
 * formatElapsed(3665000) // "1h 1m"
 * ```
 */
export const formatElapsed = (ms: number): string => {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60

  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

