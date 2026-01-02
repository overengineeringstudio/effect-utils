/** Re-export core types from effect-distributed-lock */
export {
  Backing,
  DistributedSemaphore,
  DistributedSemaphoreBacking,
  LockLostError,
  SemaphoreBackingError,
} from 'effect-distributed-lock'

/** Type guard for filtering out undefined values. */
export const isNotUndefined = <T>(value: T | undefined): value is T => value !== undefined

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

/**
 * Throws a clear error for impossible states while offering a breakpoint in dev.
 */
// biome-ignore lint/suspicious/noExplicitAny: variadic args needed for console.error compatibility
export const shouldNeverHappen = (msg?: string, ...args: any[]): never => {
  console.error(msg, ...args)
  if (isDevEnv()) {
    // biome-ignore lint/suspicious/noDebugger: intentional breakpoint for impossible states during development
    debugger
  }

  throw new Error(`This should never happen: ${msg}`)
}
