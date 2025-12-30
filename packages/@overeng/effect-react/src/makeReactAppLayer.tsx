import {
  Cause,
  Context,
  Deferred,
  Effect,
  type Exit,
  Fiber,
  FiberRefsPatch,
  Layer,
  Runtime,
  RuntimeFlags,
  Stream,
  SubscriptionRef,
  type Tracer,
} from 'effect'
import React from 'react'
import { createRoot } from 'react-dom/client'

import { LoadingState } from './LoadingState.ts'
import * as ServiceContext from './ServiceContext.ts'

export { ServiceContext }

export interface ReactApp {
  readonly _: unique symbol
}

export const ReactApp = Context.GenericTag<ReactApp, void>('@overeng/effect-react/ReactApp')

// Use `any` for the context to avoid complex generic constraints with React.createContext
const ReactServiceContext = React.createContext<ServiceContext.ServiceContext<unknown, unknown>>(
  ServiceContext.empty<unknown, Record<string, never>>(),
)

/** Hook to access the Effect service context from React */
export const useServiceContext = <TCtx,>(): ServiceContext.ServiceContext<
  TCtx,
  Record<string, never>
> =>
  React.useContext(ReactServiceContext) as ServiceContext.ServiceContext<
    TCtx,
    Record<string, never>
  >

export type ReactAppProps<TLoadingProps, TErr, TCtx> = {
  getRootEl: () => HTMLElement
  renderShutdown?: (exit: Exit.Exit<unknown, unknown>) => React.ReactNode
  render: (props: RenderProps<TLoadingProps, TErr, TCtx>) => React.ReactNode
  layer: Layer.Layer<TCtx, TErr, InCtx<TLoadingProps>>
}

export type InCtx<TLoadingProps> = LoadingState<TLoadingProps> | Tracer.ParentSpan

/**
 * Create a layer that initializes and renders a React app with Effect integration.
 *
 * This layer handles:
 * - Runtime initialization with proper fiber ref propagation
 * - Loading state management
 * - App lifecycle (mount, render, shutdown)
 * - Service context propagation to React components
 *
 * @example
 * ```tsx
 * const AppLayer = makeReactAppLayer({
 *   getRootEl: () => document.getElementById('root')!,
 *   render: (props) => {
 *     if (props._tag === 'Loading') return <Loading state={props.readyState} />
 *     if (props._tag === 'Error') return <Error cause={props.errorCause} />
 *     return <App />
 *   },
 *   layer: AppServicesLayer,
 * })
 * ```
 */
export const makeReactAppLayer = <
  TLoadingProps extends Record<string, unknown> = never,
  TErr = never,
  TCtx = never,
>({
  getRootEl,
  renderShutdown = () => <DefaultShutdown />,
  render,
  layer,
}: ReactAppProps<TLoadingProps, TErr, TCtx>): Layer.Layer<
  ReactApp,
  never,
  InCtx<TLoadingProps>
> => {
  const reactLayer = Layer.scoped(
    ReactApp,
    Effect.gen(function* () {
      const rootEl = getRootEl()
      const root = createRoot(rootEl)

      // Dark Effect magic: Propagate runtime flags and fiber refs from current runtime
      const fiberRefs = yield* Effect.getFiberRefs
      const runtimeFlags = yield* Effect.getRuntimeFlags
      const patchFlags = RuntimeFlags.diff(Runtime.defaultRuntime.runtimeFlags, runtimeFlags)
      const inversePatchFlags = RuntimeFlags.diff(runtimeFlags, Runtime.defaultRuntime.runtimeFlags)
      const patchRefs = FiberRefsPatch.diff(Runtime.defaultRuntime.fiberRefs, fiberRefs)
      const inversePatchRefs = FiberRefsPatch.diff(fiberRefs, Runtime.defaultRuntime.fiberRefs)
      const layerWithFiberRefsAndRuntimeFlags = Layer.scopedDiscard(
        Effect.acquireRelease(
          Effect.flatMap(Effect.patchRuntimeFlags(patchFlags), () =>
            Effect.patchFiberRefs(patchRefs),
          ),
          () =>
            Effect.flatMap(Effect.patchRuntimeFlags(inversePatchFlags), () =>
              Effect.patchFiberRefs(inversePatchRefs),
            ),
        ),
      )

      const ctx = yield* Effect.context<InCtx<TLoadingProps>>()
      const inputLayer = Layer.succeedContext(ctx)
      const rootLayer = layer.pipe(
        Layer.provideMerge(inputLayer),
        Layer.provideMerge(layerWithFiberRefsAndRuntimeFlags),
      )

      const runtimeDeferred = yield* Deferred.make<Runtime.Runtime<TCtx>, TErr>()

      // Start layer initialization
      yield* Layer.toRuntime(rootLayer).pipe(
        Effect.intoDeferred(runtimeDeferred),
        Effect.forkScoped,
      )

      const readyStateSRef = Context.get(ctx, LoadingState<TLoadingProps>())

      root.render(
        <AppOrLoading
          readyStateSRef={readyStateSRef}
          LiveServiceContext={LiveServiceContext}
          runtimeDeferred={runtimeDeferred}
          render={render}
        />,
      )

      yield* Effect.addFinalizer((exit) =>
        Effect.gen(function* () {
          root.unmount()

          // Wait for React cleanup effects (e.g., span.end() calls)
          yield* Effect.sleep(500)

          const newRoot = createRoot(rootEl)
          newRoot.render(renderShutdown(exit))
        }),
      )
    }),
  )

  return reactLayer
}

/** Tagged union for render props */
export type RenderProps<TLoadingProps, TErr, TCtx> =
  | {
      _tag: 'Loading'
      readyState: TLoadingProps
    }
  | {
      _tag: 'Error'
      errorCause: Cause.Cause<TErr>
    }
  | {
      _tag: 'Ready'
      runtime: Runtime.Runtime<TCtx>
    }

type AppOrLoadingProps<TLoadingProps, TErr, TCtx> = {
  readyStateSRef: SubscriptionRef.SubscriptionRef<TLoadingProps>
  LiveServiceContext: React.FC<LiveServiceContextProps<TCtx>>
  runtimeDeferred: Deferred.Deferred<Runtime.Runtime<TCtx>, TErr>
  render: (props: RenderProps<TLoadingProps, TErr, TCtx>) => React.ReactNode
}

const AppOrLoading = <TLoadingProps, TErr, TCtx>({
  readyStateSRef,
  LiveServiceContext,
  runtimeDeferred,
  render,
}: AppOrLoadingProps<TLoadingProps, TErr, TCtx>) => {
  const [readyState, setReadyState] = React.useState(() =>
    Effect.runSync(SubscriptionRef.get(readyStateSRef)),
  )

  const [runtime, setRuntime] = React.useState<Runtime.Runtime<TCtx> | undefined>()
  const [errorCause, setErrorCause] = React.useState<Cause.Cause<TErr> | undefined>()

  React.useEffect(() => {
    const fiber = readyStateSRef.changes.pipe(
      Stream.tap((newReadyState) => Effect.sync(() => setReadyState(newReadyState))),
      Stream.runDrain,
      Effect.runFork,
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [readyStateSRef])

  React.useEffect(() => {
    const fiber = Deferred.await(runtimeDeferred).pipe(
      Effect.tap((rt) => Effect.sync(() => setRuntime(rt))),
      Effect.tapErrorCause((cause) => Effect.sync(() => setErrorCause(cause as Cause.Cause<TErr>))),
      Effect.runFork,
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [runtimeDeferred])

  const renderProps = React.useMemo<RenderProps<TLoadingProps, TErr, TCtx>>(() => {
    if (errorCause !== undefined) {
      return { _tag: 'Error', errorCause }
    } else if (runtime === undefined) {
      return { _tag: 'Loading', readyState }
    } else {
      return { _tag: 'Ready', runtime }
    }
  }, [errorCause, readyState, runtime])

  return (
    <LiveServiceContext
      renderApp={() => render(renderProps)}
      runtime={runtime as Runtime.Runtime<TCtx>}
    />
  )
}

/** Default shutdown component */
export const DefaultShutdown = () => <div>The React app has been shut down.</div>

/** Default error component */
export const DefaultError: React.FC<{ errorCause: Cause.Cause<unknown> }> = ({ errorCause }) => {
  console.error('errorCause', Cause.pretty(errorCause))

  return (
    <div>
      <div>An error has occurred while starting the app:</div>
      <pre>{Cause.pretty(errorCause)}</pre>
    </div>
  )
}

type LiveServiceContextProps<TCtx> = {
  renderApp: () => React.ReactNode
  runtime: Runtime.Runtime<TCtx>
}

const LiveServiceContext = <TCtx,>({ renderApp, runtime }: LiveServiceContextProps<TCtx>) => {
  const ctx = React.useMemo(() => {
    const ctx = ServiceContext.make({}, runtime)
    globalThis.__debug ??= {}
    globalThis.__debug.EffectCtx = ctx
    return ctx
  }, [runtime])

  return (
    <ReactServiceContext.Provider value={ctx as ServiceContext.ServiceContext<unknown, unknown>}>
      {renderApp()}
    </ReactServiceContext.Provider>
  )
}

declare global {
  var __debug: { EffectCtx?: unknown } | undefined
}
