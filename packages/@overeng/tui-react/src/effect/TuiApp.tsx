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
 * // 3. Run with handler callback (scope managed internally)
 * yield* run(DeployApp, (tui) =>
 *   Effect.gen(function* () {
 *     tui.dispatch({ _tag: 'Start' })
 *   }),
 *   { view: <DeployView /> }
 * )
 *
 * // Or run headless (JSON modes, testing)
 * yield* run(DeployApp, (tui) =>
 *   Effect.gen(function* () {
 *     tui.dispatch({ _tag: 'Start' })
 *   })
 * )
 * ```
 *
 * @module
 */

import { Atom, Registry } from '@effect-atom/atom'
import type { Scope } from 'effect'
import { Cause, Console, Effect, Function as Fn, PubSub, Runtime, Schema, Stream } from 'effect'
import React, { type ReactElement, type ReactNode, createContext } from 'react'

import { renderToString } from '../renderToString.ts'
import { createRoot, type Root } from '../root.tsx'
import { useContext, useSyncExternalStore, useCallback } from './hooks.tsx'
import { CapturedLogsProvider, type LogCaptureHandle } from './LogCapture.ts'
import {
  OutputModeTag,
  type OutputMode,
  type RenderConfig,
  RenderConfigProvider,
  stripAnsi,
} from './OutputMode.tsx'

// =============================================================================
// TuiApp TypeId (for dual API dispatch)
// =============================================================================

/** Type brand for TuiApp instances, used by the dual `run` API for dispatch. */
export const TuiAppTypeId: unique symbol = Symbol.for('@overeng/tui-react/TuiApp')

/** Type brand for TuiApp instances. */
export type TuiAppTypeId = typeof TuiAppTypeId

/** Check if a value is a TuiApp instance. */
export const isTuiApp = (u: unknown): u is TuiApp<unknown, unknown> =>
  typeof u === 'object' && u !== null && TuiAppTypeId in u

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
  if (registry === null) {
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
   * Optional function to determine process exit code based on final state.
   * Called on unmount - if returns a number, sets process.exitCode.
   * If returns undefined, exit code is not modified.
   *
   * @example
   * ```typescript
   * exitCode: (state) => {
   *   if (state._tag === 'Error') return 1
   *   if (state._tag === 'Interrupted') return 130  // Standard SIGINT
   *   return 0
   * }
   * ```
   */
  readonly exitCode?: (state: S) => number | undefined
}

// =============================================================================
// Output Schema Types
// =============================================================================

/**
 * The Cause schema used for Failure output.
 * Uses Schema.Defect for both error and defect fields.
 *
 * Typed errors (Fail nodes) are serialized lossily as { name, message }.
 * Structured error details should be carried in state (for JSON consumers),
 * while typed errors still propagate via the Effect channel for in-process handling.
 */
const OutputCauseSchema = Schema.Cause({
  error: Schema.Defect,
  defect: Schema.Defect,
})

/**
 * Type for the encoded cause in JSON output.
 */
export type OutputCauseEncoded = typeof OutputCauseSchema.Encoded

/**
 * Type for the cause value (Effect's Cause type).
 */
export type OutputCause = typeof OutputCauseSchema.Type

/**
 * Success output - command completed (results may include member-level errors).
 * Fields are spread flat from the state schema plus `_tag: "Success"`.
 */
export type TuiOutputSuccess<S> = { readonly _tag: 'Success' } & S

/**
 * Failure output - command crashed or was interrupted.
 * Contains the cause and the state at time of failure.
 */
export interface TuiOutputFailure<S> {
  readonly _tag: 'Failure'
  readonly cause: OutputCause
  readonly state: S
}

/**
 * Union of Success and Failure output types.
 */
export type TuiOutput<S> = TuiOutputSuccess<S> | TuiOutputFailure<S>

/**
 * Derive an output schema from a state schema.
 *
 * Creates a discriminated union:
 * - `Success`: State fields spread flat + `_tag: "Success"`
 * - `Failure`: `{ _tag: "Failure", cause: Cause, state: S }`
 *
 * @example
 * ```typescript
 * const StateSchema = Schema.Struct({ count: Schema.Number })
 * const OutputSchema = deriveOutputSchema(StateSchema)
 *
 * // Success: { _tag: "Success", count: 42 }
 * // Failure: { _tag: "Failure", cause: {...}, state: { count: 10 } }
 * ```
 */
export const deriveOutputSchema = <S, I, R>(
  stateSchema: Schema.Schema<S, I, R>,
): Schema.Schema<TuiOutput<S>> => {
  const ast = stateSchema.ast
  if (ast._tag !== 'TypeLiteral') {
    // Fallback: wrap state in a `value` field if not a struct
    const SuccessSchema = Schema.TaggedStruct('Success', {
      value: stateSchema as Schema.Schema<S, I>,
    })
    const FailureSchema = Schema.TaggedStruct('Failure', {
      cause: OutputCauseSchema,
      state: stateSchema as Schema.Schema<S, I>,
    })
    return Schema.Union(SuccessSchema, FailureSchema) as unknown as Schema.Schema<TuiOutput<S>>
  }

  // State is a struct - spread fields into Success
  const stateStruct = stateSchema as unknown as Schema.Struct<Schema.Struct.Fields>
  const SuccessSchema = Schema.TaggedStruct('Success', stateStruct.fields)
  const FailureSchema = Schema.TaggedStruct('Failure', {
    cause: OutputCauseSchema,
    state: stateSchema as Schema.Schema<S, I>,
  })

  return Schema.Union(SuccessSchema, FailureSchema) as unknown as Schema.Schema<TuiOutput<S>>
}

// =============================================================================
// TuiApp API Types
// =============================================================================

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
  readonly [TuiAppTypeId]: TuiAppTypeId

  /**
   * Atom containing the current state. Use with `useTuiAtomValue(App.stateAtom)`.
   */
  readonly stateAtom: Atom.Writable<S>

  /**
   * Schema for JSON output, derived from stateSchema.
   *
   * Output is a discriminated union:
   * - `Success`: State fields spread flat + `_tag: "Success"`
   * - `Failure`: `{ _tag: "Failure", cause: Cause, state: S }`
   *
   * Use this for type-safe parsing of CLI JSON output.
   *
   * @example
   * ```typescript
   * type Output = typeof MyApp.outputSchema.Type
   * // { _tag: "Success", count: number } | { _tag: "Failure", cause: Cause, state: {...} }
   * ```
   */
  readonly outputSchema: Schema.Schema<TuiOutput<S>>

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
    if (tagProperty === undefined) {
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
  if (hasInterruptedVariant(schema) === false) {
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
 * @returns TuiApp instance with atoms and run() method
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

  // Derive output schema from state schema (once per app, not per run)
  const outputSchema = deriveOutputSchema(config.stateSchema)

  // Check once if schema has Interrupted variant
  const interruptedAction = createInterruptedAction(config.actionSchema)
  const run_ = (
    view?: ReactElement,
  ): Effect.Effect<TuiAppApi<S, A>, never, Scope.Scope | OutputModeTag> =>
    Effect.gen(function* () {
      const mode = yield* OutputModeTag
      const { stateSchema } = config

      // Mount stateAtom to prevent registry GC between async operations.
      // Without this, the atom node can be removed via microtask when nothing
      // subscribes (e.g. json mode), causing registry.get() to return stale initial values.
      const unmountAtom = registry.mount(stateAtom)
      yield* Effect.addFinalizer(() => Effect.sync(unmountAtom))

      // Create action PubSub for streaming
      const actionPubSub = yield* PubSub.unbounded<A>()
      const runtime = yield* Effect.runtime<never>()

      // Sync dispatch function that updates the atom and publishes to PubSub
      const dispatch = (action: A): void => {
        // Update atom synchronously via registry
        registry.set(dispatchAtom, action)
        // Also publish to PubSub for action stream
        Runtime.runFork(runtime)(PubSub.publish(actionPubSub, action))
      }

      // Track root for manual unmount
      let rootRef: Root | null = null
      let exitMode: ExitMode = 'persist' // default for inline

      /**
       * Apply exit code based on final state if exitCode mapper is configured.
       */
      const applyExitCode = (): void => {
        if (config.exitCode !== undefined) {
          const finalState = registry.get(stateAtom)
          const code = config.exitCode(finalState)
          if (code !== undefined) {
            process.exitCode = code
          }
        }
      }

      /**
       * Unmount the TUI and render final output.
       *
       * State updates are synchronous via effect-atom.
       */
      const unmount = (options?: UnmountOptions): Effect.Effect<void> =>
        Effect.sync(() => {
          if (options?.mode !== undefined) {
            exitMode = options.mode
          }
          if (rootRef !== null) {
            rootRef.unmount({ mode: exitMode })
            rootRef = null
          }
          // Apply exit code based on final state
          applyExitCode()
        })

      // Create API
      const api: TuiAppApi<S, A> = {
        dispatch,
        getState: () => registry.get(stateAtom),
        stateAtom,
        actions: Stream.fromPubSub(actionPubSub),
        unmount,
      }

      // Setup mode-specific behavior
      rootRef = yield* setupMode({
        mode,
        stateAtom,
        stateSchema,
        outputSchema,
        registry,
        view,
      })

      // Add finalizer for cleanup
      yield* Effect.addFinalizer((exit) =>
        Effect.sync(() => {
          // Only dispatch Interrupted when the fiber was actually interrupted (e.g. Ctrl+C),
          // not on normal scope close. Without this check, normal exits get exitCode 130.
          if (
            interruptedAction != null &&
            exit._tag === 'Failure' &&
            Cause.isInterruptedOnly(exit.cause) === true
          ) {
            dispatch(interruptedAction)
          }
          // Unmount with current exit mode
          if (rootRef !== null) {
            rootRef.unmount({ mode: exitMode })
            rootRef = null
          }
          // Apply exit code based on final state
          applyExitCode()
        }),
      )

      return api
    })

  return {
    [TuiAppTypeId]: TuiAppTypeId,
    stateAtom,
    outputSchema,
    run: run_,
    config,
  }
}

// =============================================================================
// Mode Setup
// =============================================================================

const setupMode = <S,>({
  mode,
  stateAtom,
  stateSchema,
  outputSchema,
  registry,
  view,
}: {
  mode: OutputMode
  stateAtom: Atom.Writable<S>
  stateSchema: Schema.Schema<S>
  outputSchema: Schema.Schema<TuiOutput<S>>
  registry: Registry.Registry
  view?: ReactElement | undefined
}): Effect.Effect<Root | null, never, Scope.Scope> => {
  // Handle based on output format
  if (mode._tag === 'react') {
    if (mode.timing === 'progressive') {
      // Progressive React rendering (inline or fullscreen)
      return view !== undefined
        ? setupProgressiveVisualWithView({
            registry,
            view,
            renderConfig: mode.render,
            ...(mode.capturedLogs !== undefined ? { capturedLogs: mode.capturedLogs } : {}),
          })
        : Effect.succeed(null)
    } else {
      // Final React rendering (single output at end)
      return setupFinalVisualWithAtom({
        view,
        registry,
        renderConfig: mode.render,
      }).pipe(Effect.as(null))
    }
  } else {
    // JSON modes
    if (mode.timing === 'progressive') {
      return setupProgressiveJsonWithAtom({
        stateAtom,
        stateSchema,
        outputSchema,
        registry,
      }).pipe(Effect.as(null))
    } else {
      return setupFinalJsonWithAtom({ stateAtom, stateSchema, outputSchema, registry }).pipe(
        Effect.as(null),
      )
    }
  }
}

const setupProgressiveVisualWithView = ({
  registry,
  view,
  renderConfig,
  capturedLogs,
}: {
  registry: Registry.Registry
  view: ReactElement
  renderConfig: RenderConfig
  capturedLogs?: LogCaptureHandle
}): Effect.Effect<Root, never, Scope.Scope> =>
  Effect.gen(function* () {
    const root = createRoot({ terminalOrStream: process.stdout })

    // Wrapper that provides Registry via our own context (avoids multiple React instance issues)
    const TuiAppWrapper = (): ReactNode => {
      let content: ReactNode = (
        <RenderConfigProvider config={renderConfig}>{view}</RenderConfigProvider>
      )

      // Wrap with captured logs provider if log capture is active
      if (capturedLogs !== undefined) {
        content = <CapturedLogsProvider handle={capturedLogs}>{content}</CapturedLogsProvider>
      }

      return <TuiRegistryContext.Provider value={registry}>{content}</TuiRegistryContext.Provider>
    }

    root.render(<TuiAppWrapper />)

    // Clean up root when scope closes
    yield* Effect.addFinalizer(() => Effect.sync(() => root.unmount()))

    return root
  })

// =============================================================================
// Atom-based mode setup functions
// =============================================================================

/**
 * Final visual mode with atoms: Render to string on scope close.
 */
const setupFinalVisualWithAtom = ({
  view,
  registry,
  renderConfig,
}: {
  view: ReactElement | undefined
  registry: Registry.Registry
  renderConfig: RenderConfig
}): Effect.Effect<void, never, Scope.Scope> => {
  if (view === undefined) return Effect.void

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
      const finalOutput = renderConfig.colors === true ? output : stripAnsi(output)

      // Output to stdout
      yield* Console.log(finalOutput)
    }).pipe(Effect.orDie),
  )
}

/**
 * Check if a state schema is a struct (TypeLiteral in AST).
 * Used to determine whether to spread state fields or wrap in `value`.
 */
const isStructSchema = <S,>(stateSchema: Schema.Schema<S>): boolean => {
  return stateSchema.ast._tag === 'TypeLiteral'
}

/**
 * Final JSON mode with atoms: Output final state as JSON on scope close.
 *
 * Wraps output in Success/Failure based on Exit status:
 * - Success (struct state): `{ _tag: "Success", ...state }`
 * - Success (non-struct state): `{ _tag: "Success", value: state }`
 * - Failure (defect/interrupt): `{ _tag: "Failure", cause: {...}, state: {...} }`
 */
const setupFinalJsonWithAtom = <S,>({
  stateAtom,
  stateSchema,
  outputSchema,
  registry,
}: {
  stateAtom: Atom.Writable<S>
  stateSchema: Schema.Schema<S>
  outputSchema: Schema.Schema<TuiOutput<S>>
  registry: Registry.Registry
}): Effect.Effect<void, never, Scope.Scope> =>
  Effect.addFinalizer((exit) =>
    Effect.gen(function* () {
      const finalState = registry.get(stateAtom)
      const isStruct = isStructSchema(stateSchema)

      // Wrap in Success or Failure based on exit status
      // For non-struct states, wrap in `value` field to avoid _tag collision
      const output =
        exit._tag === 'Success'
          ? isStruct === true
            ? { _tag: 'Success' as const, ...finalState }
            : { _tag: 'Success' as const, value: finalState }
          : { _tag: 'Failure' as const, cause: exit.cause as OutputCause, state: finalState }

      const jsonString = yield* Schema.encode(Schema.parseJson(outputSchema))(output as any)
      yield* Console.log(jsonString)
    }).pipe(Effect.orDie),
  )

/**
 * Progressive JSON mode: Stream state changes as NDJSON via atom subscriptions.
 *
 * Intermediate lines output raw state for progressive consumption.
 * Final line wraps in Success/Failure based on Exit status.
 */
const setupProgressiveJsonWithAtom = <S,>({
  stateAtom,
  stateSchema,
  outputSchema,
  registry,
}: {
  stateAtom: Atom.Writable<S>
  stateSchema: Schema.Schema<S>
  outputSchema: Schema.Schema<TuiOutput<S>>
  registry: Registry.Registry
}): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>()
    const isStruct = isStructSchema(stateSchema)

    // Output initial state (raw, for progressive consumption)
    const initialState = registry.get(stateAtom)
    const initialJson = yield* Schema.encode(Schema.parseJson(stateSchema))(initialState).pipe(
      Effect.orDie,
    )
    yield* Console.log(initialJson)

    // Subscribe to changes and output as NDJSON (raw state for intermediate lines)
    const unsubscribe = registry.subscribe(stateAtom, (state) => {
      // Encode and output synchronously
      Runtime.runSync(runtime)(
        Schema.encode(Schema.parseJson(stateSchema))(state).pipe(
          Effect.flatMap((jsonString) => Console.log(jsonString)),
          Effect.orDie,
        ),
      )
    })

    // Add finalizer to unsubscribe and output final wrapped result
    yield* Effect.addFinalizer((exit) =>
      Effect.gen(function* () {
        unsubscribe()

        // Output final line with Success/Failure wrapper
        // For non-struct states, wrap in `value` field to avoid _tag collision
        const finalState = registry.get(stateAtom)
        const output =
          exit._tag === 'Success'
            ? isStruct === true
              ? { _tag: 'Success' as const, ...finalState }
              : { _tag: 'Success' as const, value: finalState }
            : { _tag: 'Failure' as const, cause: exit.cause as OutputCause, state: finalState }

        const jsonString = yield* Schema.encode(Schema.parseJson(outputSchema))(output as any)
        yield* Console.log(jsonString)
      }).pipe(Effect.orDie),
    )
  })

// =============================================================================
// Helper
// =============================================================================

/**
 * Create a typed app config. Useful for type inference at definition site.
 */
export const tuiAppConfig = <S, A>(config: TuiAppConfig<S, A>): TuiAppConfig<S, A> => config

// =============================================================================
// Standalone run (dual API)
// =============================================================================

/**
 * Options for `run`.
 */
export interface TuiAppRunOptions {
  /**
   * Optional React element to render in visual modes.
   * Omit for headless mode (JSON modes, testing).
   */
  readonly view?: ReactElement
}

// oxlint-disable-next-line overeng/named-args -- dual API pattern requires positional args
const runImpl = <S, A, B, E, R>(
  app: TuiApp<S, A>,
  handler: (api: TuiAppApi<S, A>) => Effect.Effect<B, E, R>,
  options?: TuiAppRunOptions,
): Effect.Effect<B, E, R | OutputModeTag> =>
  Effect.scoped(app.run(options?.view).pipe(Effect.flatMap(handler)))

/**
 * Run a TuiApp with a handler callback.
 *
 * Manages scope internally — consumers do not need `Effect.scoped`.
 * The error type `E` is inferred from the handler, so typed errors
 * propagate naturally via the Effect channel.
 *
 * Supports Effect's dual/pipeable pattern:
 *
 * @example
 * ```typescript
 * // Data-first:
 * yield* run(DeployApp, (tui) =>
 *   Effect.gen(function* () {
 *     tui.dispatch({ _tag: 'Start' })
 *     // ...work...
 *     return tui.getState()
 *   }),
 *   { view: <DeployView stateAtom={DeployApp.stateAtom} /> }
 * )
 *
 * // Data-last (pipeable):
 * yield* pipe(DeployApp, run((tui) =>
 *   Effect.gen(function* () {
 *     tui.dispatch({ _tag: 'Start' })
 *   }),
 *   { view: <DeployView stateAtom={DeployApp.stateAtom} /> }
 * ))
 * ```
 */
export const run: {
  // Data-last (pipeable): run(handler, options?) returns (app) => Effect
  <S, A, B, E, R>(
    handler: (api: TuiAppApi<S, A>) => Effect.Effect<B, E, R>,
    options?: TuiAppRunOptions,
  ): (app: TuiApp<S, A>) => Effect.Effect<B, E, R | OutputModeTag>

  // Data-first: run(app, handler, options?) returns Effect
  <S, A, B, E, R>(
    app: TuiApp<S, A>,
    handler: (api: TuiAppApi<S, A>) => Effect.Effect<B, E, R>,
    options?: TuiAppRunOptions,
  ): Effect.Effect<B, E, R | OutputModeTag>
} = Fn.dual((args) => isTuiApp(args[0]), runImpl)
