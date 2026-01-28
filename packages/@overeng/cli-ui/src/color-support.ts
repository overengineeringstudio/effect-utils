/**
 * Color Support Detection
 *
 * Detects terminal color support level based on environment variables and TTY state.
 * Follows the NO_COLOR (https://no-color.org/) and FORCE_COLOR specifications.
 *
 * @example
 * ```ts
 * import { supportsColor, getColorLevel, ColorLevel } from '@overeng/cli-ui'
 *
 * if (supportsColor()) {
 *   console.log('\x1b[32mGreen text\x1b[0m')
 * }
 *
 * const level = getColorLevel()
 * if (level === 'truecolor') {
 *   // Use RGB colors
 * }
 * ```
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Color support levels:
 * - 'none': No color support (monochrome)
 * - 'basic': 16 colors (ANSI standard colors)
 * - '256': 256 colors (extended palette)
 * - 'truecolor': 16 million colors (24-bit RGB)
 */
export type ColorLevel = 'none' | 'basic' | '256' | 'truecolor'

// =============================================================================
// Internal State
// =============================================================================

/** Forced color level override (for testing/Storybook) */
let forcedLevel: ColorLevel | undefined

/** Cached detected level */
let cachedLevel: ColorLevel | undefined

// =============================================================================
// Detection Logic
// =============================================================================

/**
 * Parse FORCE_COLOR environment variable value.
 * - '0' or 'false' -> none
 * - '1' or 'true' or '' -> basic
 * - '2' -> 256
 * - '3' -> truecolor
 */
const parseForceColor = (value: string): ColorLevel | undefined => {
  if (value === '0' || value === 'false') return 'none'
  if (value === '' || value === '1' || value === 'true') return 'basic'
  if (value === '2') return '256'
  if (value === '3') return 'truecolor'
  return 'basic' // Any other value enables basic colors
}

/**
 * Detect color level from TERM environment variable.
 */
const detectFromTerm = (term: string): ColorLevel => {
  const termLower = term.toLowerCase()

  // Check for truecolor support
  if (termLower.includes('truecolor') || termLower.includes('24bit')) {
    return 'truecolor'
  }

  // Check for 256 color support
  if (termLower.includes('256color') || termLower.includes('256-color')) {
    return '256'
  }

  // Known terminals with truecolor support
  const truecolorTerms = ['iterm', 'kitty', 'alacritty', 'wezterm', 'vscode']
  if (truecolorTerms.some((t) => termLower.includes(t))) {
    return 'truecolor'
  }

  // Known terminals with 256 color support
  const color256Terms = ['xterm', 'screen', 'tmux', 'rxvt', 'linux']
  if (color256Terms.some((t) => termLower.includes(t))) {
    return '256'
  }

  // Dumb terminal = no colors
  if (termLower === 'dumb') {
    return 'none'
  }

  // Default to basic colors if TERM is set
  return 'basic'
}

/**
 * Detect color level from environment.
 * Priority:
 * 1. NO_COLOR (disables all colors)
 * 2. FORCE_COLOR (explicit level)
 * 3. COLORTERM (truecolor detection)
 * 4. TERM_PROGRAM (known terminal detection)
 * 5. TERM (terminal type)
 * 6. CI environment detection
 * 7. TTY check
 */
const detectColorLevel = (): ColorLevel => {
  // Check if we're in a Node.js-like environment
  if (typeof process === 'undefined' || !process.env) {
    return 'none'
  }

  const env = process.env

  // 1. NO_COLOR takes absolute precedence
  // Any value (including empty string) disables colors
  if (env.NO_COLOR !== undefined) {
    return 'none'
  }

  // 2. FORCE_COLOR overrides all other detection
  if (env.FORCE_COLOR !== undefined) {
    return parseForceColor(env.FORCE_COLOR) ?? 'basic'
  }

  // 3. COLORTERM for truecolor detection
  if (env.COLORTERM) {
    const colorterm = env.COLORTERM.toLowerCase()
    if (colorterm === 'truecolor' || colorterm === '24bit') {
      return 'truecolor'
    }
  }

  // 4. TERM_PROGRAM for known terminals
  if (env.TERM_PROGRAM) {
    const program = env.TERM_PROGRAM.toLowerCase()
    if (program === 'iterm.app' || program === 'hyper' || program === 'vscode') {
      return 'truecolor'
    }
    if (program === 'apple_terminal') {
      return '256'
    }
  }

  // 5. TERM environment variable
  if (env.TERM) {
    return detectFromTerm(env.TERM)
  }

  // 6. CI environments often support colors
  if (env.CI) {
    // GitHub Actions, GitLab CI, etc. support colors
    if (env.GITHUB_ACTIONS || env.GITLAB_CI || env.CIRCLECI || env.BUILDKITE) {
      return 'basic'
    }
    // Generic CI - be conservative
    return 'none'
  }

  // 7. Check if stdout is a TTY
  if (typeof process.stdout !== 'undefined' && process.stdout.isTTY) {
    return 'basic'
  }

  // Default: no colors
  return 'none'
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Get the current color support level.
 *
 * This respects:
 * - `forceColorLevel()` overrides
 * - `NO_COLOR` environment variable
 * - `FORCE_COLOR` environment variable
 * - Terminal capabilities (TERM, COLORTERM, etc.)
 *
 * The result is cached for performance.
 *
 * @returns The detected or forced color level
 */
export const getColorLevel = (): ColorLevel => {
  // Check for forced level first
  if (forcedLevel !== undefined) {
    return forcedLevel
  }

  // Use cached value if available
  if (cachedLevel !== undefined) {
    return cachedLevel
  }

  // Detect and cache
  cachedLevel = detectColorLevel()
  return cachedLevel
}

/**
 * Check if colors are supported.
 *
 * This is a convenience function that returns true if the color level
 * is anything other than 'none'.
 *
 * @returns true if colors are supported
 */
export const supportsColor = (): boolean => {
  return getColorLevel() !== 'none'
}

/**
 * Check if 256 colors are supported.
 *
 * @returns true if 256 or truecolor is supported
 */
export const supports256Colors = (): boolean => {
  const level = getColorLevel()
  return level === '256' || level === 'truecolor'
}

/**
 * Check if truecolor (24-bit RGB) is supported.
 *
 * @returns true if truecolor is supported
 */
export const supportsTruecolor = (): boolean => {
  return getColorLevel() === 'truecolor'
}

/**
 * Force a specific color level.
 *
 * This is useful for:
 * - Testing
 * - Storybook (force colors on in browser)
 * - CLI flags like `--color` and `--no-color`
 *
 * @param level - The color level to force, or undefined to clear the override
 *
 * @example
 * ```ts
 * // Force colors on for testing
 * forceColorLevel('truecolor')
 *
 * // Force colors off
 * forceColorLevel('none')
 *
 * // Clear override, use auto-detection
 * forceColorLevel(undefined)
 * ```
 */
export const forceColorLevel = (level: ColorLevel | undefined): void => {
  forcedLevel = level
}

/**
 * Reset the cached color level.
 *
 * This forces re-detection on the next call to `getColorLevel()`.
 * Useful for testing when environment variables change.
 */
export const resetColorCache = (): void => {
  cachedLevel = undefined
}

/**
 * Reset all color state (both forced level and cache).
 *
 * This is mainly useful for testing.
 */
export const resetColorState = (): void => {
  forcedLevel = undefined
  cachedLevel = undefined
}
