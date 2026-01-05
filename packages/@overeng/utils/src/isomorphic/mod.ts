/** Re-export core types from effect-distributed-lock */
export {
  Backing,
  DistributedSemaphore,
  DistributedSemaphoreBacking,
  LockLostError,
  SemaphoreBackingError,
} from 'effect-distributed-lock'

/** Debug utilities for tracing scope and finalizer lifecycle */
export * from './ScopeDebugger.ts'

import { Schema } from 'effect'

// ============================================================================
// Error Types
// ============================================================================

/**
 * Generic error class for wrapping unknown error causes.
 * Useful when catching errors of unknown type and wrapping them in a typed Effect error.
 */
export class UnknownError extends Schema.TaggedError<UnknownError>()('UnknownError', {
  cause: Schema.Unknown,
  payload: Schema.optional(Schema.Unknown),
}) {}

// ============================================================================
// Type Guards
// ============================================================================

/** Type guard for filtering out undefined values. */
export const isNotUndefined = <T>(value: T | undefined): value is T => value !== undefined

/** Type guard for checking if a value is undefined. */
export const isUndefined = <T>(value: T | undefined): value is undefined => value === undefined

/** Type guard for filtering out null values. */
export const isNotNull = <T>(value: T | null): value is T => value !== null

/** Type guard for checking if a value is null or undefined (nil). */
// biome-ignore lint/suspicious/noExplicitAny: type guard needs to accept any value
export const isNil = (value: any): value is null | undefined =>
  value === null || value === undefined

/** Type guard for filtering out null and undefined values. */
export const isNotNil = <T>(value: T | null | undefined): value is T =>
  value !== null && value !== undefined

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

/**
 * Throws a clear error for impossible states while offering a breakpoint in dev.
 */
// oxlint-disable-next-line eslint(max-params) -- variadic args needed for console.error compatibility
export const shouldNeverHappen = (msg?: string, ...args: any[]): never => {
  console.error(msg, ...args)
  if (isDevEnv()) {
    // oxlint-disable-next-line eslint(no-debugger) -- intentional breakpoint for impossible states during development
    debugger
  }

  throw new Error(`This should never happen: ${msg}`)
}
