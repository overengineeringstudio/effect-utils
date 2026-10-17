/**
 * Terminal Symbols
 *
 * Centralized symbol definitions for CLI rendering with unicode/ascii fallback support.
 * Symbols are organized by category and support runtime resolution based on terminal capabilities.
 *
 * @example
 * ```ts
 * import { resolveSymbols, unicodeSymbols, asciiSymbols } from '@overeng/tui-core'
 *
 * // Use pre-resolved symbols
 * console.log(unicodeSymbols.status.check) // ✓
 * console.log(asciiSymbols.status.check)   // +
 *
 * // Or resolve based on environment
 * const symbols = resolveSymbols(process.env.NO_UNICODE !== undefined)
 * console.log(symbols.status.check) // ✓ or + depending on env
 * ```
 *
 * @module
 */

// =============================================================================
// Symbol Definitions
// =============================================================================

/**
 * Symbol definition with unicode and ascii variants.
 */
export interface SymbolDef {
  readonly unicode: string
  readonly ascii: string
}

/**
 * All symbol definitions organized by category.
 *
 * Each symbol has both a unicode and ascii variant for terminals
 * that don't support unicode characters.
 */
export const symbolDefs = {
  /**
   * Status indicators (check marks, crosses, circles, etc.)
   */
  status: {
    /** Success/complete indicator: ✓ / + */
    check: { unicode: '\u2713', ascii: '+' },
    /** Error/failure indicator: ✗ / x */
    cross: { unicode: '\u2717', ascii: 'x' },
    /** Pending/neutral indicator: ○ / o */
    circle: { unicode: '\u25cb', ascii: 'o' },
    /** Small separator/bullet: · / . */
    dot: { unicode: '\u00b7', ascii: '.' },
    /** Modified/dirty indicator: ● / * */
    dirty: { unicode: '\u25cf', ascii: '*' },
    /** Warning indicator: ⚠ / ! */
    warning: { unicode: '\u26a0', ascii: '!' },
  },
  /**
   * Directional arrows
   */
  arrows: {
    /** Right arrow: → / -> */
    right: { unicode: '\u2192', ascii: '->' },
    /** Up arrow (e.g., commits ahead): ↑ / ^ */
    up: { unicode: '\u2191', ascii: '^' },
  },
  /**
   * Tree drawing characters for hierarchical displays
   */
  tree: {
    /** Middle branch: ├── / |-- */
    branch: { unicode: '\u251c\u2500\u2500 ', ascii: '|-- ' },
    /** Last item branch: └── / \-- */
    last: { unicode: '\u2514\u2500\u2500 ', ascii: '\\-- ' },
    /** Vertical continuation: │   / |   */
    vertical: { unicode: '\u2502   ', ascii: '|   ' },
    /** Empty indentation (4 spaces) */
    empty: { unicode: '    ', ascii: '    ' },
  },
  /**
   * Line drawing characters
   */
  line: {
    /** Horizontal line: ─ / - */
    horizontal: { unicode: '\u2500', ascii: '-' },
  },
} as const

/**
 * Type for the symbol definitions structure.
 */
export type SymbolDefs = typeof symbolDefs

// =============================================================================
// Resolved Symbol Types
// =============================================================================

/**
 * Resolved symbols type - same structure as symbolDefs but with string values only.
 *
 * This is the type you get after calling `resolveSymbols()`.
 */
export type Symbols = {
  readonly [G in keyof SymbolDefs]: {
    readonly [S in keyof SymbolDefs[G]]: string
  }
}

// =============================================================================
// Resolution Functions
// =============================================================================

/**
 * Resolve symbols to either unicode or ascii variants.
 *
 * @param useAscii - If true, returns ascii variants. If false, returns unicode.
 * @returns Resolved symbols object with string values
 *
 * @example
 * ```ts
 * const symbols = resolveSymbols(false) // unicode
 * console.log(symbols.status.check) // ✓
 *
 * const asciiSyms = resolveSymbols(true) // ascii
 * console.log(asciiSyms.status.check) // +
 * ```
 */
export const resolveSymbols = (useAscii: boolean): Symbols => {
  const variant = useAscii === true ? 'ascii' : 'unicode'

  return {
    status: {
      check: symbolDefs.status.check[variant],
      cross: symbolDefs.status.cross[variant],
      circle: symbolDefs.status.circle[variant],
      dot: symbolDefs.status.dot[variant],
      dirty: symbolDefs.status.dirty[variant],
      warning: symbolDefs.status.warning[variant],
    },
    arrows: {
      right: symbolDefs.arrows.right[variant],
      up: symbolDefs.arrows.up[variant],
    },
    tree: {
      branch: symbolDefs.tree.branch[variant],
      last: symbolDefs.tree.last[variant],
      vertical: symbolDefs.tree.vertical[variant],
      empty: symbolDefs.tree.empty[variant],
    },
    line: {
      horizontal: symbolDefs.line.horizontal[variant],
    },
  }
}

// =============================================================================
// Pre-resolved Symbols
// =============================================================================

/**
 * Pre-resolved unicode symbols.
 *
 * Use this when you know unicode is supported or for tests.
 *
 * @example
 * ```ts
 * import { unicodeSymbols } from '@overeng/tui-core'
 * console.log(`${unicodeSymbols.status.check} Done`)
 * ```
 */
export const unicodeSymbols: Symbols = resolveSymbols(false)

/**
 * Pre-resolved ASCII symbols.
 *
 * Use this for terminals that don't support unicode.
 *
 * @example
 * ```ts
 * import { asciiSymbols } from '@overeng/tui-core'
 * console.log(`${asciiSymbols.status.check} Done`)
 * ```
 */
export const asciiSymbols: Symbols = resolveSymbols(true)
