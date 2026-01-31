/**
 * TuiApp - Factory pattern for TUI applications
 *
 * Creates a reusable TUI app definition that separates state configuration
 * from view rendering. Uses app-scoped hooks for type-safe state access.
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
 * // 2. View uses app-scoped hooks (types inferred!)
 * const DeployView = () => {
 *   const state = DeployApp.useState()
 *   const dispatch = DeployApp.useDispatch()
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

import type { Scope } from 'effect'
import { Effect, PubSub, Stream, SubscriptionRef, type Schema } from 'effect'
import React, { createContext, useContext, type ReactElement, type ReactNode } from 'react'

import type { Viewport } from '../hooks/useViewport.tsx'
import { ViewportProvider } from '../hooks/useViewport.tsx'
import { createRoot, type Root } from '../root.tsx'
import { RuntimeProvider, useSubscriptionRef } from './hooks.tsx'
import { setupFinalVisual, setupFinalJson, setupProgressiveJson } from './modeSetup.tsx'
import {
  OutputModeTag,
  type OutputMode,
  type RenderConfig,
  RenderConfigProvider,
  isTTY,
  tty,
  ci,
  getRenderConfig,
} from './OutputMode.tsx'

// =============================================================================
// Types
// =============================================================================

/**
 * Exit mode for TUI unmount behavior.
 */
export type ExitMode = 'persist' | 'clear' | 'clearDynamic'

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
   * The underlying SubscriptionRef for advanced use.
   */
  readonly stateRef: SubscriptionRef.SubscriptionRef<S>

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
 * A TUI application definition with app-scoped hooks.
 */
export interface TuiApp<S, A> {
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
   * App-scoped hook to get current state. Subscribes to changes.
   * Must be used within a component rendered by this app's run().
   *
   * @example
   * ```typescript
   * const MyView = () => {
   *   const state = MyApp.useState()
   *   return <Text>{state.count}</Text>
   * }
   * ```
   */
  readonly useState: () => S

  /**
   * App-scoped hook to get dispatch function. Does not subscribe to state changes.
   *
   * @example
   * ```typescript
   * const MyView = () => {
   *   const dispatch = MyApp.useDispatch()
   *   return <Text onPress={() => dispatch({ _tag: 'Click' })}>Click me</Text>
   * }
   * ```
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
 * Create a TUI application with app-scoped hooks.
 *
 * @param config - App configuration (state schema, reducer, initial state)
 * @returns TuiApp instance with run() method and app-scoped hooks
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
 * // View uses app-scoped hooks
 * const CounterView = () => {
 *   const state = CounterApp.useState()
 *   const dispatch = CounterApp.useDispatch()
 *   return (
 *     <Box>
 *       <Text>Count: {state.count}</Text>
 *       <Text onPress={() => dispatch({ _tag: 'Inc' })}>+</Text>
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
  // Create app-specific context for this app instance
  // Using a unique symbol to prevent cross-app context conflicts
  const StateContext = createContext<SubscriptionRef.SubscriptionRef<S> | null>(null)
  const DispatchContext = createContext<((action: A) => void) | null>(null)

  // App-scoped hooks
  const useState = (): S => {
    const ref = useContext(StateContext)
    if (!ref) {
      throw new Error('useState must be used within a component rendered by this TuiApp')
    }
    return useSubscriptionRef(ref)
  }

  const useDispatch = (): ((action: A) => void) => {
    const dispatch = useContext(DispatchContext)
    if (!dispatch) {
      throw new Error('useDispatch must be used within a component rendered by this TuiApp')
    }
    return dispatch
  }

  // Check once if schema has Interrupted variant
  const interruptedAction = createInterruptedAction(config.actionSchema)
  const interruptTimeout = config.interruptTimeout ?? 500

  const run = (
    view?: ReactElement,
  ): Effect.Effect<TuiAppApi<S, A>, never, Scope.Scope | OutputModeTag> =>
    Effect.gen(function* () {
      const mode = yield* OutputModeTag
      const { initial, reducer, stateSchema } = config

      // Create state ref
      const stateRef = yield* SubscriptionRef.make(initial)

      // Create action PubSub for streaming
      const actionPubSub = yield* PubSub.unbounded<A>()

      // Sync dispatch function
      const dispatch = (action: A): void => {
        Effect.runSync(SubscriptionRef.update(stateRef, (state) => reducer({ state, action })))
        Effect.runFork(PubSub.publish(actionPubSub, action))
      }

      // Track root for manual unmount
      let rootRef: Root | null = null
      let exitMode: ExitMode = 'persist' // default for inline

      // Unmount function
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
        getState: () => Effect.runSync(SubscriptionRef.get(stateRef)),
        stateRef,
        actions: Stream.fromPubSub(actionPubSub),
        unmount,
      }

      // Setup mode-specific behavior
      rootRef = yield* setupMode({
        mode,
        stateRef,
        dispatch,
        stateSchema,
        StateContext,
        DispatchContext,
        view,
      })

      // Add finalizer for cleanup
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          // Handle interrupt: dispatch Interrupted action if schema supports it
          if (interruptedAction) {
            dispatch(interruptedAction)
            // Wait for render to complete using actual setTimeout to yield to event loop
            // This ensures React has time to process the state update and re-render
            yield* Effect.promise(
              () => new Promise<void>((resolve) => setTimeout(resolve, interruptTimeout)),
            )
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
  stateRef,
  dispatch,
  stateSchema,
  StateContext,
  DispatchContext,
  view,
}: {
  mode: OutputMode
  stateRef: SubscriptionRef.SubscriptionRef<S>
  dispatch: (action: A) => void
  stateSchema: Schema.Schema<S>
  StateContext: React.Context<SubscriptionRef.SubscriptionRef<S> | null>
  DispatchContext: React.Context<((action: A) => void) | null>
  view?: ReactElement | undefined
}): Effect.Effect<Root | null, never, Scope.Scope> => {
  // Handle based on output format
  if (mode._tag === 'react') {
    if (mode.timing === 'progressive') {
      // Progressive React rendering (inline or fullscreen)
      return view
        ? setupProgressiveVisualWithView({
            stateRef,
            dispatch,
            StateContext,
            DispatchContext,
            view,
            renderConfig: mode.render,
          })
        : Effect.succeed(null)
    } else {
      // Final React rendering (single output at end)
      return setupFinalVisual({
        stateRef,
        view,
        StateContext,
        DispatchContext,
        dispatch,
        renderConfig: mode.render,
      }).pipe(Effect.as(null))
    }
  } else {
    // JSON modes
    if (mode.timing === 'progressive') {
      return setupProgressiveJson({ stateRef, schema: stateSchema }).pipe(Effect.as(null))
    } else {
      return setupFinalJson({ stateRef, schema: stateSchema }).pipe(Effect.as(null))
    }
  }
}

const setupProgressiveVisualWithView = <S, A>({
  stateRef,
  dispatch,
  StateContext,
  DispatchContext,
  view,
  renderConfig,
}: {
  stateRef: SubscriptionRef.SubscriptionRef<S>
  dispatch: (action: A) => void
  StateContext: React.Context<SubscriptionRef.SubscriptionRef<S> | null>
  DispatchContext: React.Context<((action: A) => void) | null>
  view: ReactElement
  renderConfig: RenderConfig
}): Effect.Effect<Root, never, Scope.Scope> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>()
    const root = createRoot({ terminalOrStream: process.stdout })

    // Wrapper that provides context
    const TuiAppWrapper = (): ReactNode => (
      <RenderConfigProvider config={renderConfig}>
        <StateContext.Provider value={stateRef}>
          <DispatchContext.Provider value={dispatch}>{view}</DispatchContext.Provider>
        </StateContext.Provider>
      </RenderConfigProvider>
    )

    const initialViewport: Viewport = {
      columns: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
    }

    root.render(
      <RuntimeProvider<never> runtime={runtime}>
        <ViewportProvider viewport={initialViewport}>
          <TuiAppWrapper />
        </ViewportProvider>
      </RuntimeProvider>,
    )

    return root
  })

// =============================================================================
// Helper
// =============================================================================

/**
 * Create a typed app config. Useful for type inference at definition site.
 */
export const tuiAppConfig = <S, A>(config: TuiAppConfig<S, A>): TuiAppConfig<S, A> => config
