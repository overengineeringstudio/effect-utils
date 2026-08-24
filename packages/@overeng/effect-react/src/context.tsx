/** @jsxImportSource react */
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  type Layer,
  ManagedRuntime,
  Result,
  Schema,
  type Scope,
} from 'effect'
import React from 'react'

import { OtelOperation } from '@overeng/otel-contract'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Error handler for effect execution */
export type ErrorHandler = (cause: Cause.Cause<unknown>) => void

/** Configuration for the EffectProvider */
export interface EffectProviderConfig<TEnv, TErr> {
  /** Layer to build the runtime from */
  layer: Layer.Layer<TEnv, TErr>
  /** Component to show while runtime is loading */
  Loading?: () => React.ReactNode
  /** Component to show when runtime initialization fails */
  Error?: (props: { cause: Cause.Cause<TErr>; onRetry: () => void }) => React.ReactNode
  /** Error handler for effects run via useEffectRunner */
  onError?: ErrorHandler
}

/** Effect type that can be run with the provider's environment */
export type ProviderEffect<TEnv, TA, TE> = Effect.Effect<TA, TE, TEnv | Scope.Scope>

// -----------------------------------------------------------------------------
// Context
// -----------------------------------------------------------------------------

type EffectContextValue = {
  runtime: Context.Context<unknown>
  onError: ErrorHandler
}

const EffectContext = React.createContext<EffectContextValue | null>(null)

const EffectRunnerOperation = OtelOperation.define({
  name: 'ui.effect',
  schema: Schema.Struct({}),
  label: () => 'effect',
  root: true,
})

// -----------------------------------------------------------------------------
// Provider
// -----------------------------------------------------------------------------

/**
 * Provider component that initializes an Effect runtime and makes it available to children.
 *
 * @example
 * ```tsx
 * const AppLayer = Layer.mergeAll(
 *   HttpClient.layer,
 *   Logger.prettyWithThread('app'),
 * )
 *
 * const App = () => (
 *   <EffectProvider
 *     layer={AppLayer}
 *     Loading={() => <div>Loading...</div>}
 *     Error={({ cause, onRetry }) => (
 *       <div>
 *         <pre>{Cause.pretty(cause)}</pre>
 *         <button onClick={onRetry}>Retry</button>
 *       </div>
 *     )}
 *   >
 *     <MainApp />
 *   </EffectProvider>
 * )
 * ```
 */
export const EffectProvider = <TEnv, TErr>({
  layer,
  Loading = DefaultLoading,
  Error: ErrorComponent = DefaultError,
  onError = defaultErrorHandler,
  children,
}: EffectProviderConfig<TEnv, TErr> & {
  children: React.ReactNode
}): React.ReactNode => {
  const [state, setState] = React.useState<
    | { _tag: 'loading' }
    | { _tag: 'error'; cause: Cause.Cause<TErr> }
    | { _tag: 'ready'; runtime: Context.Context<TEnv> }
  >({ _tag: 'loading' })

  const [retryCount, setRetryCount] = React.useState(0)

  React.useEffect(() => {
    setState({ _tag: 'loading' })

    let managedRuntime: ManagedRuntime.ManagedRuntime<TEnv, TErr> | undefined

    const init = Effect.gen(function* () {
      managedRuntime = ManagedRuntime.make(layer)
      const runtime = yield* managedRuntime.contextEffect
      return runtime
    })

    const fiber = Effect.runFork(init)

    fiber.addObserver((exit) => {
      if (Exit.isSuccess(exit) === true) {
        setState({ _tag: 'ready', runtime: exit.value })
      } else if (Exit.isFailure(exit) === true) {
        setState({ _tag: 'error', cause: exit.cause })
      }
    })

    return () => {
      void Effect.runFork(Fiber.interrupt(fiber))
      if (managedRuntime !== undefined) {
        managedRuntime.dispose().catch(() => {
          // Ignore disposal errors during cleanup
        })
      }
    }
  }, [layer, retryCount])

  const handleRetry = React.useCallback(() => {
    setRetryCount((c) => c + 1)
  }, [])

  const contextValue = React.useMemo<EffectContextValue | null>(
    () =>
      state._tag === 'ready'
        ? { runtime: state.runtime as Context.Context<unknown>, onError }
        : null,
    [state, onError],
  )

  if (state._tag === 'loading') {
    return <Loading />
  }

  if (state._tag === 'error') {
    return <ErrorComponent cause={state.cause} onRetry={handleRetry} />
  }

  return <EffectContext.Provider value={contextValue}>{children}</EffectContext.Provider>
}

// -----------------------------------------------------------------------------
// Hooks
// -----------------------------------------------------------------------------

/** Get the current Effect runtime context from context */
export const useRuntime = <TEnv,>(): Context.Context<TEnv> => {
  const ctx = React.useContext(EffectContext)
  if (ctx === null) {
    throw new Error('useRuntime must be used within an EffectProvider')
  }
  return ctx.runtime as Context.Context<TEnv>
}

/**
 * Returns a function to run effects with automatic error handling.
 *
 * The returned function runs the effect and returns a cancel function.
 * Errors are passed to the onError handler configured on the EffectProvider.
 *
 * @example
 * ```tsx
 * const MyComponent = () => {
 *   const runEffect = useEffectRunner()
 *
 *   const handleClick = () => {
 *     runEffect(
 *       Effect.gen(function* () {
 *         yield* Effect.log('Button clicked')
 *         yield* doSomething()
 *       }).pipe(ButtonClickOperation.with({}))
 *     )
 *   }
 *
 *   return <button onClick={handleClick}>Click me</button>
 * }
 * ```
 */
export const useEffectRunner = <TEnv,>(): (<TA, TE>(
  effect: ProviderEffect<TEnv, TA, TE>,
) => CancelFn) => {
  const ctx = React.useContext(EffectContext)
  if (ctx === null) {
    throw new Error('useEffectRunner must be used within an EffectProvider')
  }

  const { runtime, onError } = ctx
  const typedContext = runtime as Context.Context<TEnv>

  return React.useCallback(
    <TA, TE>(effect: ProviderEffect<TEnv, TA, TE>): CancelFn => {
      const fiber = effect.pipe(
        Effect.tapCause((cause) => Effect.sync(() => onError(cause))),
        EffectRunnerOperation.with({}),
        Effect.scoped,
        Effect.runForkWith(typedContext),
      )
      return () => {
        void Effect.runFork(Fiber.interrupt(fiber))
      }
    },
    [typedContext, onError],
  )
}

/** Cancel function returned by effect runners */
export type CancelFn = () => void

/**
 * Create a stable callback that runs an effect when called.
 *
 * @example
 * ```tsx
 * const MyComponent = () => {
 *   const saveEffect = Effect.gen(function* () {
 *     yield* saveData()
 *   })
 *
 *   const handleSave = useEffectCallback(saveEffect)
 *
 *   return <button onClick={handleSave}>Save</button>
 * }
 * ```
 */
export const useEffectCallback = <TEnv, TA, TE>(
  effect: ProviderEffect<TEnv, TA, TE>,
): (() => CancelFn) => {
  const runEffect = useEffectRunner<TEnv>()

  return React.useCallback(() => runEffect(effect), [runEffect, effect])
}

/**
 * Run an effect when the component mounts. Cancels on unmount.
 *
 * @example
 * ```tsx
 * const MyComponent = () => {
 *   useEffectOnMount(
 *     Effect.gen(function* () {
 *       yield* loadInitialData()
 *     })
 *   )
 *
 *   return <div>...</div>
 * }
 * ```
 */
export const useEffectOnMount = <TEnv, TA, TE>(effect: ProviderEffect<TEnv, TA, TE>): void => {
  const runEffect = useEffectRunner<TEnv>()

  React.useEffect(() => {
    const cancel = runEffect(effect)
    return () => cancel()
  }, [runEffect, effect])
}

// -----------------------------------------------------------------------------
// Default Components
// -----------------------------------------------------------------------------

const DefaultLoading = (): React.ReactNode => <div>Loading...</div>

const DefaultError = <TErr,>({
  cause,
  onRetry,
}: {
  cause: Cause.Cause<TErr>
  onRetry: () => void
}): React.ReactNode => (
  <div style={{ padding: '1rem', fontFamily: 'monospace' }}>
    <h2>Failed to initialize</h2>
    <pre style={{ whiteSpace: 'pre-wrap', overflow: 'auto' }}>{Cause.pretty(cause)}</pre>
    <button type="button" onClick={onRetry}>
      Retry
    </button>
  </div>
)

const defaultErrorHandler: ErrorHandler = (cause) => {
  console.error('Effect failed:', Cause.pretty(cause))
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

/**
 * Extract a user-friendly error message from a Cause.
 */
export const extractErrorMessage = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.findErrorOption(cause)
  if (failure._tag === 'Some') {
    const err = failure.value
    if (
      typeof err === 'object' &&
      err !== null &&
      'message' in err &&
      typeof err.message === 'string'
    ) {
      return err.message
    }
    if (typeof err === 'string') return err
    return String(err)
  }
  const defect = Cause.findDefect(cause)
  if (Result.isSuccess(defect) === true) {
    const d = defect.success
    if (d instanceof Error) return d.message
    return String(d)
  }
  return 'An unexpected error occurred'
}
