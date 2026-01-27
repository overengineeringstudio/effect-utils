/**
 * React hooks for Effect integration.
 *
 * These hooks allow React components to subscribe to Effect's reactive primitives
 * like SubscriptionRef, enabling reactive UI updates from Effect business logic.
 *
 * @example
 * ```tsx
 * // In Effect code
 * const countRef = yield* SubscriptionRef.make(0)
 *
 * // In React component (via context)
 * const count = useSubscriptionRef(countRef)
 * ```
 */

import { useState, useEffect, useSyncExternalStore, createContext, useContext, type ReactNode } from 'react'
import { Effect, Stream, SubscriptionRef, Runtime, Fiber, Exit } from 'effect'

// =============================================================================
// useSubscriptionRef
// =============================================================================

/**
 * Subscribe to a SubscriptionRef and re-render when it changes.
 *
 * This hook bridges Effect's reactive SubscriptionRef with React's rendering.
 * It uses useSyncExternalStore for proper concurrent mode support.
 *
 * @param ref - The SubscriptionRef to subscribe to
 * @returns The current value of the ref
 *
 * @example
 * ```tsx
 * const MyComponent = ({ countRef }: { countRef: SubscriptionRef.SubscriptionRef<number> }) => {
 *   const count = useSubscriptionRef(countRef)
 *   return <Text>Count: {count}</Text>
 * }
 * ```
 */
export const useSubscriptionRef = <A,>(ref: SubscriptionRef.SubscriptionRef<A>): A => {
  // Get initial value synchronously
  const getSnapshot = (): A => {
    // This is safe because SubscriptionRef.get is synchronous
    let value: A
    Effect.runSync(
      SubscriptionRef.get(ref).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            value = v
          }),
        ),
      ),
    )
    return value!
  }

  // Subscribe to changes
  const subscribe = (onStoreChange: () => void): (() => void) => {
    // Create a fiber that listens to changes
    const fiber = Effect.runFork(
      ref.changes.pipe(
        Stream.runForEach(() =>
          Effect.sync(() => {
            onStoreChange()
          }),
        ),
      ),
    )

    // Return cleanup function
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// =============================================================================
// useStream
// =============================================================================

/**
 * Subscribe to a Stream and accumulate values.
 *
 * @param stream - The Stream to subscribe to
 * @param initial - Initial value before any stream emissions
 * @returns The latest value from the stream
 */
export const useStream = <A, E,>(stream: Stream.Stream<A, E>, initial: A): A => {
  const [value, setValue] = useState<A>(initial)

  useEffect(() => {
    const fiber = Effect.runFork(
      stream.pipe(
        Stream.runForEach((v) =>
          Effect.sync(() => {
            setValue(v)
          }),
        ),
      ),
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [stream])

  return value
}

// =============================================================================
// RuntimeContext
// =============================================================================

/**
 * Context for providing an Effect Runtime to React components.
 */
export const RuntimeContext = createContext<Runtime.Runtime<never> | null>(null)

/**
 * Provider component for Effect Runtime.
 *
 * @example
 * ```tsx
 * const runtime = Runtime.defaultRuntime
 *
 * <RuntimeProvider runtime={runtime}>
 *   <App />
 * </RuntimeProvider>
 * ```
 */
export const RuntimeProvider = <R,>({
  runtime,
  children,
}: {
  runtime: Runtime.Runtime<R>
  children: ReactNode
}): ReactNode => {
  return (
    <RuntimeContext.Provider value={runtime as Runtime.Runtime<never>}>{children}</RuntimeContext.Provider>
  )
}

/**
 * Get the Effect Runtime from context.
 *
 * @throws If used outside of RuntimeProvider
 */
export const useRuntime = <R = never,>(): Runtime.Runtime<R> => {
  const runtime = useContext(RuntimeContext)
  if (!runtime) {
    throw new Error('useRuntime must be used within a RuntimeProvider')
  }
  return runtime as Runtime.Runtime<R>
}

// =============================================================================
// useEffectCallback
// =============================================================================

/**
 * Create a callback that runs an Effect.
 *
 * @param effect - Effect to run when callback is invoked
 * @returns A function that runs the effect
 *
 * @example
 * ```tsx
 * const handleClick = useEffectCallback(
 *   Effect.log('Button clicked!')
 * )
 * ```
 */
export const useEffectCallback = <A, E, R,>(
  effect: Effect.Effect<A, E, R>,
  runtime?: Runtime.Runtime<R>,
): (() => void) => {
  const contextRuntime = useContext(RuntimeContext)
  const actualRuntime = runtime ?? (contextRuntime as Runtime.Runtime<R> | null)

  return () => {
    if (actualRuntime) {
      Runtime.runFork(actualRuntime)(effect)
    } else {
      Effect.runFork(effect as Effect.Effect<A, E, never>)
    }
  }
}

// =============================================================================
// RefRegistry (for sharing refs between Effect and React)
// =============================================================================

/**
 * A registry for sharing SubscriptionRefs between Effect code and React components.
 *
 * This allows Effect business logic to create refs that React components can subscribe to.
 */
export interface RefRegistry {
  /**
   * Register a ref with a key.
   */
  register: <A,>(key: string, ref: SubscriptionRef.SubscriptionRef<A>) => void

  /**
   * Get a ref by key.
   */
  get: <A,>(key: string) => SubscriptionRef.SubscriptionRef<A> | undefined

  /**
   * Subscribe to a ref by key. Returns undefined if ref doesn't exist.
   */
  subscribe: <A,>(key: string, onValue: (value: A) => void) => (() => void) | undefined
}

/**
 * Create a new RefRegistry.
 */
export const createRefRegistry = (): RefRegistry => {
  const refs = new Map<string, SubscriptionRef.SubscriptionRef<unknown>>()

  return {
    register: <A,>(key: string, ref: SubscriptionRef.SubscriptionRef<A>) => {
      refs.set(key, ref as SubscriptionRef.SubscriptionRef<unknown>)
    },

    get: <A,>(key: string) => {
      return refs.get(key) as SubscriptionRef.SubscriptionRef<A> | undefined
    },

    subscribe: <A,>(key: string, onValue: (value: A) => void) => {
      const ref = refs.get(key) as SubscriptionRef.SubscriptionRef<A> | undefined
      if (!ref) return undefined

      const fiber = Effect.runFork(
        ref.changes.pipe(
          Stream.runForEach((v) =>
            Effect.sync(() => {
              onValue(v)
            }),
          ),
        ),
      )

      return () => {
        Effect.runFork(Fiber.interrupt(fiber))
      }
    },
  }
}

/**
 * Context for RefRegistry.
 */
export const RefRegistryContext = createContext<RefRegistry | null>(null)

/**
 * Provider for RefRegistry.
 */
export const RefRegistryProvider = ({
  registry,
  children,
}: {
  registry: RefRegistry
  children: ReactNode
}): ReactNode => {
  return <RefRegistryContext.Provider value={registry}>{children}</RefRegistryContext.Provider>
}

/**
 * Hook to get a value from the registry by key.
 *
 * @param key - The key to look up
 * @param defaultValue - Default value if ref doesn't exist
 */
export const useRegistryRef = <A,>(key: string, defaultValue: A): A => {
  const registry = useContext(RefRegistryContext)
  const [value, setValue] = useState<A>(defaultValue)

  useEffect(() => {
    if (!registry) return

    const ref = registry.get<A>(key)
    if (!ref) return

    // Get initial value
    Effect.runSync(
      SubscriptionRef.get(ref).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            setValue(v)
          }),
        ),
      ),
    )

    // Subscribe to changes
    const unsubscribe = registry.subscribe<A>(key, setValue)
    return unsubscribe
  }, [registry, key])

  return value
}
