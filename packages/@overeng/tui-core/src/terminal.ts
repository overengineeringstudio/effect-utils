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
 * Resolve a Terminal or TerminalLike to a Terminal.
 *
 * If already a Terminal, returns as-is. Otherwise wraps in createTerminal().
 */
export const resolveTerminal = (terminalOrStream: Terminal | TerminalLike): Terminal =>
  isTerminal(terminalOrStream) ? terminalOrStream : createTerminal(terminalOrStream)

/**
 * Check if an object is a Terminal.
 *
 * This checks for both property existence AND types to distinguish
 * a proper Terminal from a Node.js stream that needs wrapping.
 * A Node.js stream (like process.stdout) has these properties but
 * they may be undefined when not a TTY - we need to wrap it.
 */
export const isTerminal = (value: unknown): value is Terminal =>
  typeof value === 'object' &&
  value !== null &&
  'write' in value &&
  typeof (value as Terminal).columns === 'number' &&
  typeof (value as Terminal).rows === 'number' &&
  typeof (value as Terminal).isTTY === 'boolean'
