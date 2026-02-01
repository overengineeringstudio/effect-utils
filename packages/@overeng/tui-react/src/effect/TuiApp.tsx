/**
 * TuiApp - Factory pattern for TUI applications
 *
 * Creates a reusable TUI app definition that separates state configuration
 * from view rendering. Uses effect-atom for reactive state management.
 *
 * @example
 * ```typescript
 * // 1. Define the app (reusable, no View coupling)
 * const DeployApp = createTuiApp({
 *   stateSchema: DeployState,
 *   actionSchema: DeployAction,
 *   initial: { _tag: 'Idle' },
 *   reducer: deployReducer,
 * })
 *
 * // 2. View uses atoms directly (types inferred!)
 * const DeployView = () => {
 *   const state = useTuiAtomValue(DeployApp.stateAtom)
 *   return <Box><Text>{state._tag}</Text></Box>
 * }
 *
 * // 3. Run with view
 * const runDeploy = Effect.gen(function* () {
 *   const tui = yield* DeployApp.run(<DeployView />)
 *   tui.dispatch({ _tag: 'Start' })
 * }).pipe(Effect.scoped)
 *
 * // Or run headless (JSON modes, testing)
 * const runHeadless = Effect.gen(function* () {
 *   const tui = yield* DeployApp.run()
 *   tui.dispatch({ _tag: 'Start' })
 * }).pipe(Effect.scoped)
 * ```
 *
 * @module
 */

import { Atom, Registry } from '@effect-atom/atom'
import type { Scope } from 'effect'
import { Console, Effect, PubSub, Schema, Stream } from 'effect'
import React, { type ReactElement, type ReactNode, createContext } from 'react'

import type { Viewport } from '../hooks/useViewport.tsx'
import { ViewportProvider } from '../hooks/useViewport.tsx'
import { renderToString } from '../renderToString.ts'
import { createRoot, type Root } from '../root.tsx'
import { useContext, useSyncExternalStore, useCallback } from './hooks.tsx'
import {
  OutputModeTag,
  type OutputMode,
  type RenderConfig,
  RenderConfigProvider,
  stripAnsi,
} from './OutputMode.tsx'

// =============================================================================
// TUI Registry Context (avoids multiple React instance issues with @effect-atom/atom-react)
// =============================================================================

/**
 * Context for providing the TUI registry to components.
 * Uses our own React instance to avoid context sharing issues with @effect-atom/atom-react.
 */
export const TuiRegistryContext = createContext<Registry.Registry | null>(null)

/**
 * Hook to get an atom's value from the TUI registry.
 * This is a workaround for multiple React instance issues with @effect-atom/atom-react.
 *
 * Uses useSyncExternalStore for proper React 18+ integration.
 *
 * @example
 * ```tsx
 * const state = useTuiAtomValue(MyApp.stateAtom)
 * ```
 */
export const useTuiAtomValue = <T,>(atom: Atom.Atom<T>): T => {
  const registry = useContext(TuiRegistryContext)
  if (!registry) {
    throw new Error(
      'useTuiAtomValue must be used within a TUI component. ' +
        'Make sure your component is rendered by TuiApp.run().',
    )
  }

  // Use useSyncExternalStore for proper React integration
  const subscribe = useCallback(
    (callback: () => void) => {
      // Registry.subscribe returns an unsubscribe function
      const unsubscribe = registry.subscribe(atom, callback)
      return unsubscribe
    },
    [atom, registry],
  )

  const getSnapshot = useCallback(() => registry.get(atom), [atom, registry])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// =============================================================================
// Types
// =============================================================================

/**
 * Exit mode for TUI unmount behavior.
 */
export type ExitMode = 'persist' | 'clear' | 'clearDynamic'

/**
 * Options for TuiAppApi.unmount()
 */
export interface UnmountOptions {
  /**
   * Exit mode controlling what happens to rendered output.
   * - `persist` (default for inline): Keep all output visible
   * - `clear`: Remove all output
   * - `clearDynamic`: Keep static logs, clear dynamic region
   */
  readonly mode?: ExitMode
}

/**
 * Configuration for creating a TUI app.
 * Does not include View - that's passed at run time.
 */
export interface TuiAppConfig<S, A> {
  /**
   * Effect Schema for state serialization (used in JSON modes).
   */
  readonly stateSchema: Schema.Schema<S>

  /**
   * Effect Schema for action serialization (for debugging/logging).
   * If includes Schema.TaggedStruct('Interrupted', {}), system auto-dispatches on Ctrl+C.
   */
  readonly actionSchema: Schema.Schema<A>

  /**
   * Initial state value.
   */
  readonly initial: S

  /**
   * Pure reducer function: ({ state, action }) => newState
   */
  readonly reducer: (args: { state: S; action: A }) => S

  /**
   * Timeout for final render on interrupt (default: 500ms).
   * Only used if actionSchema includes 'Interrupted' variant.
   */
  readonly interruptTimeout?: number
}

/**
 * API returned by TuiApp.run() for interacting with state.
 */
export interface TuiAppApi<S, A> {
  /**
   * Dispatch an action synchronously.
   */
  readonly dispatch: (action: A) => void

  /**
   * Get current state synchronously.
   */
  readonly getState: () => S

  /**
   * The state atom for advanced use.
   */
  readonly stateAtom: Atom.Writable<S>

  /**
   * The dispatch atom for advanced use.
   * Note: The return type of the dispatch atom is Option<void> due to effect-atom internals.
   */
  readonly dispatchAtom: Atom.Atom<unknown>

  /**
   * Stream of dispatched actions (for logging/debugging).
   */
  readonly actions: Stream.Stream<A>

  /**
   * Explicitly unmount the TUI with optional exit mode.
   * If not called, unmount happens when scope closes with default mode.
   */
  readonly unmount: (options?: UnmountOptions) => Effect.Effect<void>
}

/**
 * A TUI application definition with atoms for state management.
 */
export interface TuiApp<S, A> {
  /**
   * Atom containing the current state. Use with `useTuiAtomValue(App.stateAtom)`.
   */
  readonly stateAtom: Atom.Writable<S>

  /**
   * Atom for dispatching actions. Use with registry.set(App.dispatchAtom, action).
   * Note: The return type of the dispatch atom is Option<void> due to effect-atom internals.
   */
  readonly dispatchAtom: Atom.Atom<unknown>

  /**
   * Run the app, optionally rendering a view.
   *
   * @param view - Optional React element to render (for visual modes)
   * @returns Effect yielding the state API
   *
   * @example
   * ```typescript
   * // With view (progressive-visual mode)
   * const tui = yield* MyApp.run(<MyView />)
   *
   * // Headless (JSON modes or testing)
   * const tui = yield* MyApp.run()
   * ```
   */
  readonly run: (
    view?: ReactElement,
  ) => Effect.Effect<TuiAppApi<S, A>, never, Scope.Scope | OutputModeTag>

  /**
   * @deprecated Use `useTuiAtomValue(App.stateAtom)` instead.
   * App-scoped hook to get current state.
   */
  readonly useState: () => S

  /**
   * @deprecated Use registry.set(App.dispatchAtom, action) instead.
   * App-scoped hook to get dispatch function.
   */
  readonly useDispatch: () => (action: A) => void

  /**
   * The app configuration (useful for testing).
   */
  readonly config: TuiAppConfig<S, A>
}

// =============================================================================
// Helpers for Interrupted detection
// =============================================================================

/**
 * Check if an Effect Schema has an 'Interrupted' variant (TaggedStruct with _tag: 'Interrupted').
 */
const hasInterruptedVariant = <A,>(schema: Schema.Schema<A>): boolean => {
  const ast = schema.ast

  // Check if it's a Union
  if (ast._tag !== 'Union') {
    return false
  }

  // Check each variant in the union
  return ast.types.some((type) => {
    // We're looking for a TypeLiteral with a _tag property set to 'Interrupted'
    if (type._tag !== 'TypeLiteral') {
      return false
    }

    // Find the _tag property
    const tagProperty = type.propertySignatures.find((prop) => prop.name === '_tag')
    if (!tagProperty) {
      return false
    }

    // Check if it's a Literal with value 'Interrupted'
    const tagType = tagProperty.type
    if (tagType._tag !== 'Literal') {
      return false
    }

    return tagType.literal === 'Interrupted'
  })
}

/**
 * Create an Interrupted action value if the schema supports it.
 */
const createInterruptedAction = <A,>(schema: Schema.Schema<A>): A | null => {
  if (!hasInterruptedVariant(schema)) {
    return null
  }
  // Create the Interrupted action
  return { _tag: 'Interrupted' } as A
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a TUI application with effect-atom state management.
 *
 * @param config - App configuration (state schema, reducer, initial state)
 * @returns TuiApp instance with atoms, run() method, and legacy hooks
 *
 * @example
 * ```typescript
 * const CounterApp = createTuiApp({
 *   stateSchema: Schema.Struct({ count: Schema.Number }),
 *   actionSchema: Schema.Union(
 *     Schema.TaggedStruct('Inc', {}),
 *     Schema.TaggedStruct('Dec', {}),
 *   ),
 *   initial: { count: 0 },
 *   reducer: ({ state, action }) => {
 *     switch (action._tag) {
 *       case 'Inc': return { count: state.count + 1 }
 *       case 'Dec': return { count: state.count - 1 }
 *     }
 *   },
 * })
 *
 * // View uses atoms directly
 * const CounterView = () => {
 *   const state = useTuiAtomValue(CounterApp.stateAtom)
 *   return (
 *     <Box>
 *       <Text>Count: {state.count}</Text>
 *     </Box>
 *   )
 * }
 *
 * // Run the app
 * const tui = yield* CounterApp.run(<CounterView />)
 * tui.dispatch({ _tag: 'Inc' })
 * ```
 */
export const createTuiApp = <S, A>(config: TuiAppConfig<S, A>): TuiApp<S, A> => {
  const { initial, reducer } = config

  // Create atoms at app definition time (shared across all runs)
  const stateAtom = Atom.make(initial)
  const dispatchAtom = Atom.fnSync((action: A, get) => {
    const currentState = get(stateAtom)
    const newState = reducer({ state: currentState, action })
    get.set(stateAtom, newState)
  })

  // Create a registry for this app
  const registry = Registry.make()

  // Legacy hooks for backward compatibility (deprecated)
  const useState = (): S => {
    // This requires the component to be wrapped in TuiRegistryContext
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useTuiAtomValue(stateAtom)
  }

  const useDispatch = (): ((action: A) => void) => {
    // Return a function that updates the dispatch atom
    return (action: A) => {
      registry.set(dispatchAtom, action)
    }
  }

  // Check once if schema has Interrupted variant
  const interruptedAction = createInterruptedAction(config.actionSchema)
  const interruptTimeout = config.interruptTimeout ?? 500

  const run = (
    view?: ReactElement,
  ): Effect.Effect<TuiAppApi<S, A>, never, Scope.Scope | OutputModeTag> =>
    Effect.gen(function* () {
      const mode = yield* OutputModeTag
      const { stateSchema } = config

      // Create action PubSub for streaming
      const actionPubSub = yield* PubSub.unbounded<A>()

      // Sync dispatch function that updates the atom and publishes to PubSub
      const dispatch = (action: A): void => {
        // Update atom synchronously via registry
        registry.set(dispatchAtom, action)
        // Also publish to PubSub for action stream
        Effect.runFork(PubSub.publish(actionPubSub, action))
      }

      // Track root for manual unmount
      let rootRef: Root | null = null
      let exitMode: ExitMode = 'persist' // default for inline

      /**
       * Unmount the TUI and render final output.
       *
       * With effect-atom, state updates are synchronous, so we don't need
       * the Effect.yieldNow() pattern that was required with SubscriptionRef.
       */
      const unmount = (options?: UnmountOptions): Effect.Effect<void> =>
        Effect.sync(() => {
          if (options?.mode) {
            exitMode = options.mode
          }
          if (rootRef) {
            rootRef.unmount({ mode: exitMode })
            rootRef = null
          }
        })

      // Create API
      const api: TuiAppApi<S, A> = {
        dispatch,
        getState: () => registry.get(stateAtom),
        stateAtom,
        dispatchAtom,
        actions: Stream.fromPubSub(actionPubSub),
        unmount,
      }

      // Setup mode-specific behavior
      rootRef = yield* setupMode({
        mode,
        stateAtom,
        dispatch,
        stateSchema,
        registry,
        view,
      })

      // Add finalizer for cleanup
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          // Handle interrupt: dispatch Interrupted action if schema supports it
          if (interruptedAction) {
            dispatch(interruptedAction)
          }
          // Unmount with current exit mode
          if (rootRef) {
            rootRef.unmount({ mode: exitMode })
            rootRef = null
          }
        }),
      )

      return api
    })

  return {
    stateAtom,
    dispatchAtom,
    run,
    useState,
    useDispatch,
    config,
  }
}

// =============================================================================
// Mode Setup
// =============================================================================

const setupMode = <S, A>({
  mode,
  stateAtom,
  dispatch,
  stateSchema,
  registry,
  view,
}: {
  mode: OutputMode
  stateAtom: Atom.Writable<S>
  dispatch: (action: A) => void
  stateSchema: Schema.Schema<S>
  registry: Registry.Registry
  view?: ReactElement | undefined
}): Effect.Effect<Root | null, never, Scope.Scope> => {
  // Handle based on output format
  if (mode._tag === 'react') {
    if (mode.timing === 'progressive') {
      // Progressive React rendering (inline or fullscreen)
      return view
        ? setupProgressiveVisualWithView({
            stateAtom,
            dispatch,
            registry,
            view,
            renderConfig: mode.render,
          })
        : Effect.succeed(null)
    } else {
      // Final React rendering (single output at end)
      return setupFinalVisualWithAtom({
        stateAtom,
        view,
        dispatch,
        registry,
        renderConfig: mode.render,
      }).pipe(Effect.as(null))
    }
  } else {
    // JSON modes
    if (mode.timing === 'progressive') {
      return setupProgressiveJsonWithAtom({ stateAtom, schema: stateSchema, registry }).pipe(
        Effect.as(null),
      )
    } else {
      return setupFinalJsonWithAtom({ stateAtom, schema: stateSchema, registry }).pipe(
        Effect.as(null),
      )
    }
  }
}

const setupProgressiveVisualWithView = <S, A>({
  stateAtom: _stateAtom,
  dispatch: _dispatch,
  registry,
  view,
  renderConfig,
}: {
  stateAtom: Atom.Writable<S>
  dispatch: (action: A) => void
  registry: Registry.Registry
  view: ReactElement
  renderConfig: RenderConfig
}): Effect.Effect<Root, never, Scope.Scope> =>
  Effect.gen(function* () {
    const root = createRoot({ terminalOrStream: process.stdout })

    // Wrapper that provides Registry via our own context (avoids multiple React instance issues)
    const TuiAppWrapper = (): ReactNode => (
      <TuiRegistryContext.Provider value={registry}>
        <RenderConfigProvider config={renderConfig}>{view}</RenderConfigProvider>
      </TuiRegistryContext.Provider>
    )

    const initialViewport: Viewport = {
      columns: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
    }

    root.render(
      <ViewportProvider viewport={initialViewport}>
        <TuiAppWrapper />
      </ViewportProvider>,
    )

    return root
  })

// =============================================================================
// Atom-based mode setup functions
// =============================================================================

/**
 * Final visual mode with atoms: Render to string on scope close.
 */
const setupFinalVisualWithAtom = <S, A>({
  stateAtom: _stateAtom,
  view,
  dispatch: _dispatch,
  registry,
  renderConfig,
}: {
  stateAtom: Atom.Writable<S>
  view: ReactElement | undefined
  dispatch: (action: A) => void
  registry: Registry.Registry
  renderConfig: RenderConfig
}): Effect.Effect<void, never, Scope.Scope> => {
  if (!view) return Effect.void

  return Effect.addFinalizer(() =>
    Effect.gen(function* () {
      // Wrapper component that provides registry context (using our own context)
      const RegistryWrapper = ({ children }: { children: ReactNode }): ReactElement => (
        <TuiRegistryContext.Provider value={registry}>
          <RenderConfigProvider config={renderConfig}>{children}</RenderConfigProvider>
        </TuiRegistryContext.Provider>
      )

      const element = <RegistryWrapper>{view}</RegistryWrapper>

      // Render to string
      const output = yield* Effect.promise(() => renderToString({ element }))

      // Strip ANSI codes if colors are disabled
      const finalOutput = renderConfig.colors ? output : stripAnsi(output)

      // Output to stdout
      yield* Console.log(finalOutput)
    }).pipe(Effect.orDie),
  )
}

/**
 * Final JSON mode with atoms: Output final state as JSON on scope close.
 */
const setupFinalJsonWithAtom = <S,>({
  stateAtom,
  schema,
  registry,
}: {
  stateAtom: Atom.Writable<S>
  schema: Schema.Schema<S>
  registry: Registry.Registry
}): Effect.Effect<void, never, Scope.Scope> =>
  Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const finalState = registry.get(stateAtom)
      const jsonString = yield* Schema.encode(Schema.parseJson(schema))(finalState)
      yield* Console.log(jsonString)
    }).pipe(Effect.orDie),
  )

/**
 * Progressive JSON mode with atoms: Stream state changes as NDJSON.
 *
 * Note: effect-atom atoms don't have a built-in .changes stream like SubscriptionRef.
 * We use Atom.subscribe to watch for changes.
 */
const setupProgressiveJsonWithAtom = <S,>({
  stateAtom,
  schema,
  registry,
}: {
  stateAtom: Atom.Writable<S>
  schema: Schema.Schema<S>
  registry: Registry.Registry
}): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Output initial state
    const initialState = registry.get(stateAtom)
    const initialJson = yield* Schema.encode(Schema.parseJson(schema))(initialState).pipe(
      Effect.orDie,
    )
    yield* Console.log(initialJson)

    // Subscribe to changes and output as NDJSON
    const unsubscribe = registry.subscribe(stateAtom, (state) => {
      // Encode and output synchronously
      Effect.runSync(
        Schema.encode(Schema.parseJson(schema))(state).pipe(
          Effect.flatMap((jsonString) => Console.log(jsonString)),
          Effect.orDie,
        ),
      )
    })

    // Add finalizer to unsubscribe
    yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribe()))
  })

// =============================================================================
// Helper
// =============================================================================

/**
 * Create a typed app config. Useful for type inference at definition site.
 */
export const tuiAppConfig = <S, A>(config: TuiAppConfig<S, A>): TuiAppConfig<S, A> => config
