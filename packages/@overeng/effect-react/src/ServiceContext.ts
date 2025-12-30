import { Cause, Effect, Exit, Fiber, Layer, Logger, LogLevel, type Runtime, Scope } from 'effect'

export interface MainLayer<Ctx> {
  layer: Layer.Layer<Ctx>
  close: Effect.Effect<void>
}

/** Create a main layer with managed scope */
export const unsafeMainLayer = <Ctx>(original: Layer.Layer<Ctx>): MainLayer<Ctx> => {
  const scope = Effect.runSync(Scope.make())
  const layer = original.pipe(
    Layer.memoize,
    Effect.parallelFinalizers,
    Effect.provideService(Scope.Scope, scope),
    Effect.tapErrorCause((cause) =>
      Effect.logError('Layer initialization failed', Cause.pretty(cause)),
    ),
    Effect.runSync,
  )
  return { layer, close: Scope.close(scope, Exit.void) }
}

/** Create a ServiceContext from a runtime */
export const make = <TStaticData, Ctx>(
  staticData: TStaticData,
  runtime: Runtime.Runtime<Ctx>,
  close: Effect.Effect<void> = Effect.dieMessage('close not implemented'),
): ServiceContext<Ctx, TStaticData> => {
  return {
    provide: (self) => Effect.provide(runtime)(self),
    runWithErrorLog: <E, A>(self: Effect.Effect<A, E, Ctx>) =>
      runWithErrorLog(Effect.provide(runtime)(self)),
    runSync: <E, A>(self: Effect.Effect<A, E, Ctx>) =>
      Effect.runSync(Effect.provide(runtime)(self)),
    runPromiseWithErrorLog: <E, A>(self: Effect.Effect<A, E, Ctx>) =>
      runPromiseWithErrorLog(Effect.provide(runtime)(self)),
    runPromiseExit: <E, A>(self: Effect.Effect<A, E, Ctx>) =>
      Effect.runPromiseExit(Effect.provide(runtime)(self)),
    runPromise: <E, A>(self: Effect.Effect<A, E, Ctx>) =>
      Effect.runPromise(Effect.provide(runtime)(self)),
    withRuntime: (fn) => fn(runtime),
    close: close,
    closePromise: () => Effect.runPromise(close),
    staticData,
  }
}

/** Service context for running effects with a provided runtime */
export interface ServiceContext<Ctx, TStaticData> {
  readonly provide: <E, A>(self: Effect.Effect<A, E, Ctx>) => Effect.Effect<A, E>

  /** Fire and forget. Errors are logged. */
  readonly runWithErrorLog: <E, A>(self: Effect.Effect<A, E, Ctx>) => AbortCallback

  readonly runSync: <E, A>(self: Effect.Effect<A, E, Ctx>) => A

  /** Fire and forget. Promise never fails. Errors are logged. */
  readonly runPromiseWithErrorLog: <E, A>(self: Effect.Effect<A, E, Ctx>) => Promise<A | undefined>

  /** Promise never fails, returns Exit result */
  readonly runPromiseExit: <E, A>(self: Effect.Effect<A, E, Ctx>) => Promise<Exit.Exit<A, E>>
  readonly runPromise: <E, A>(self: Effect.Effect<A, E, Ctx>) => Promise<A>

  readonly withRuntime: (fn: (runtime: Runtime.Runtime<Ctx>) => void) => void

  /** Close the ServiceContext and all its layers */
  readonly close: Effect.Effect<void>
  readonly closePromise: () => Promise<void>
  readonly staticData: TStaticData
}

export type AbortCallback = () => void

/** Run an effect and log any errors */
export const runWithErrorLog = <E, A>(eff: Effect.Effect<A, E>) => {
  const fiber = eff.pipe(
    Effect.tapErrorCause((cause) => Effect.logError('Effect failed', Cause.pretty(cause))),
    Effect.provide(Logger.pretty),
    Logger.withMinimumLogLevel(LogLevel.Debug),
    Effect.runFork,
  )
  return () => {
    Effect.runFork(Fiber.interrupt(fiber))
  }
}

/** Run an effect as promise and log any errors */
export const runPromiseWithErrorLog = <E, A>(self: Effect.Effect<A, E>) =>
  Effect.runPromiseExit(
    self.pipe(
      Effect.tapErrorCause((cause) => Effect.logError('Effect failed', Cause.pretty(cause))),
    ),
  ).then((ex) => {
    if (ex._tag === 'Failure') {
      return undefined
    } else {
      return ex.value
    }
  })

export const MissingContext = Effect.die(
  'service context not provided, wrap your app in LiveServiceContext',
)

/** Create an empty ServiceContext placeholder */
export const empty = <Ctx, TStaticData = Record<string, never>>(): ServiceContext<
  Ctx,
  TStaticData
> => ({
  provide: () => MissingContext,
  runWithErrorLog: () => runWithErrorLog(MissingContext),
  runSync: () => Effect.runSync(MissingContext),
  runPromiseWithErrorLog: () => runPromiseWithErrorLog(MissingContext),
  runPromiseExit: () => Effect.runPromiseExit(MissingContext),
  runPromise: () => Effect.runPromise(MissingContext),
  withRuntime: () => Effect.runSync(MissingContext),
  close: Effect.dieMessage('Empty ServiceContext cannot be closed'),
  closePromise: () => Promise.reject('Empty ServiceContext cannot be closed'),
  staticData: undefined as unknown as TStaticData,
})
