/**
 * Terminal abstraction for output streams.
 *
 * Provides a unified interface for writing to terminals, whether real TTYs or virtual.
 */

/** Minimal terminal interface for writing output */
export interface Terminal {
  /** Write data to the terminal */
  readonly write: (data: string) => void
  /** Terminal width in columns */
  readonly columns: number
  /** Terminal height in rows */
  readonly rows: number
  /** Whether this is a TTY (supports ANSI codes) */
  readonly isTTY: boolean
}

/** Objects that look like a Node.js WriteStream */
export interface TerminalLike {
  write: (data: string) => boolean | void
  columns?: number | undefined
  rows?: number | undefined
  isTTY?: boolean | undefined
}

/**
 * Create a Terminal from a Node.js-like stream.
 *
 * @example
 * ```ts
 * const terminal = createTerminal(process.stdout)
 * ```
 */
export const createTerminal = (stream: TerminalLike): Terminal => ({
  write: (data: string) => {
    stream.write(data)
  },
  get columns() {
    return stream.columns ?? 80
  },
  get rows() {
    return stream.rows ?? 24
  },
  get isTTY() {
    return stream.isTTY ?? false
  },
})

/**
 * Check if an object is a Terminal.
 */
export const isTerminal = (value: unknown): value is Terminal =>
  typeof value === 'object' &&
  value !== null &&
  'write' in value &&
  'columns' in value &&
  'rows' in value &&
  'isTTY' in value
