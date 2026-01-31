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

import { Effect, Stream, SubscriptionRef, Runtime, Fiber } from 'effect'
import {
  useState,
  useEffect,
  useSyncExternalStore,
  createContext,
  useContext,
  type ReactNode,
} from 'react'

// =============================================================================
// useSubscriptionRef
// =============================================================================

/**
 * Subscribe to a SubscriptionRef and re-render when it changes.
 *
 * This hook bridges Effect's reactive SubscriptionRef with React's rendering.
 * It uses useSyncExternalStore for proper concurrent mode support.
 *
 * ## Implementation Notes
 *
 * The subscription uses Effect.runFork to listen to `ref.changes`, which means
 * change notifications are processed asynchronously by an Effect fiber. When
 * the ref is updated (e.g., via dispatch), the sequence is:
 *
 * 1. SubscriptionRef is updated synchronously
 * 2. Change event is published to the changes stream
 * 3. The listening fiber (created by runFork) needs to be scheduled to run
 * 4. When the fiber runs, it calls onStoreChange to notify React
 * 5. React schedules a re-render and calls getSnapshot for the new value
 *
 * This async nature means callers must yield to the Effect scheduler (e.g.,
 * Effect.yieldNow) before flushing React if they need updates to be visible.
 * See TuiApp.unmount() for the canonical pattern.
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
  // Get current value synchronously - called by React during render and after
  // onStoreChange notifications to check if the value actually changed
  const getSnapshot = (): A => {
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

  // Subscribe to changes - called once during the passive effect phase after
  // the component mounts. Returns an unsubscribe function for cleanup.
  const subscribe = (onStoreChange: () => void): (() => void) => {
    // Start a fiber that listens to the SubscriptionRef's change stream.
    // When a change is detected, we call onStoreChange to notify React.
    // Note: This fiber runs asynchronously - see docstring for implications.
    const fiber = Effect.runFork(
      ref.changes.pipe(
        Stream.runForEach(() =>
          Effect.sync(() => {
            onStoreChange()
          }),
        ),
      ),
    )

    // Cleanup: interrupt the listening fiber when the component unmounts
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
 * @param options.stream - The Stream to subscribe to
 * @param options.initial - Initial value before any stream emissions
 * @returns The latest value from the stream
 */
export const useStream = <A, E>({
  stream,
  initial,
}: {
  stream: Stream.Stream<A, E>
  initial: A
}): A => {
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
  children?: ReactNode
}): ReactNode => {
  return (
    <RuntimeContext.Provider value={runtime as Runtime.Runtime<never>}>
      {children}
    </RuntimeContext.Provider>
  )
}

/**
 * Get the Effect Runtime from context.
 *
 * @throws If used outside of RuntimeProvider
 */
export const useRuntime = <R = never>(): Runtime.Runtime<R> => {
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
 * @param options.effect - Effect to run when callback is invoked
 * @param options.runtime - Optional runtime to use for execution
 * @returns A function that runs the effect
 *
 * @example
 * ```tsx
 * const handleClick = useEffectCallback({
 *   effect: Effect.log('Button clicked!')
 * })
 * ```
 */
export const useEffectCallback = <A, E, R>({
  effect,
  runtime,
}: {
  effect: Effect.Effect<A, E, R>
  runtime?: Runtime.Runtime<R>
}): (() => void) => {
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
