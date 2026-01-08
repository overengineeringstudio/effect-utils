// ============================================================================
// Environment Detection
// ============================================================================

/** Detects non-production environments when running in Node-like runtimes. */
export const isDevEnv = (): boolean => {
  if (typeof process === 'undefined') {
    return false
  }

  if (typeof process.env === 'undefined') {
    return false
  }

  return process.env.NODE_ENV !== 'production'
}

// ============================================================================
// Defensive Programming
// ============================================================================

// oxlint-disable-next-line eslint(max-params) -- variadic args needed for console.error compatibility
/** Throws a clear error for impossible states while offering a breakpoint in dev */
export const shouldNeverHappen = (msg?: string, ...args: any[]): never => {
  console.error(msg, ...args)
  if (isDevEnv()) {
    // oxlint-disable-next-line eslint(no-debugger) -- intentional breakpoint for impossible states during development
    debugger
  }

  throw new Error(`This should never happen: ${msg}`)
}
