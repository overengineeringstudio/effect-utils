import { Effect, type Scope, Semaphore, Sink, Stream } from 'effect'

import { Init, Transport } from './errors.ts'

/** Whether a poisoned instance is rebuilt or permanently retired. */
export type PanicPolicy = 'rebuild' | 'retire'
/** Preferred byte chunk size for latency-sensitive or bulk transfers. */
export type ChunkProfile = 'latency' | 'bulk'
/** Maximum per-operation byte sizes for each chunk profile. */
export const chunkProfiles = { latency: 64 * 1024, bulk: 256 * 1024 } as const

/** Observes traps raised by an instance's asynchronous scheduler callbacks. */
export type PanicObserver = (cause: unknown) => void

/** The factory must close over fresh glue state as well as a fresh instance. */
export interface Instance<TApi> {
  readonly api: TApi
  readonly release: () => void | PromiseLike<void>
  /** Bindgen glue installs this observer at its generation-local callback boundary. */
  readonly observePanic?: (observer: PanicObserver) => () => void
}
/** Constructs fresh glue state and an independently releasable Rust instance. */
export type InstanceFactory<TApi> = () => Instance<TApi> | PromiseLike<Instance<TApi>>

/** cancel resolves only after Rust has dropped its future and stopped host calls. */
export type RustJob<T> =
  | {
      readonly _tag: 'RustJob'
      readonly mode: 'abortable'
      readonly result: PromiseLike<T>
      readonly cancel: () => void | PromiseLike<void>
    }
  | { readonly _tag: 'RustJob'; readonly mode: 'settle-only'; readonly result: PromiseLike<T> }

/** Generation-local API and cancellation signal supplied to a Rust operation. */
export interface Invocation<TApi> {
  readonly api: TApi
  readonly signal: AbortSignal
}
/** Starts a value, promise, or explicitly cancellable Rust job. */
export type Start<TApi, T> = (invocation: Invocation<TApi>) => T | PromiseLike<T> | RustJob<T>
/** Optional decoder for non-panic Rust failures. */
export interface CallOptions<TError> {
  readonly decodeError?: (cause: unknown) => Effect.Effect<never, TError>
}
/** Owned Rust input resource with ordered writes and consuming completion. */
export interface InputHandle<T> {
  readonly write: (bytes: Uint8Array) => void | PromiseLike<void>
  /** Consumes the Rust handle on success. */
  readonly finish: () => T | PromiseLike<T>
  readonly close: () => void | PromiseLike<void>
}
/** Owned Rust output resource that returns bounded byte chunks. */
export interface OutputHandle {
  /** Returns owned bytes, bounded by maxBytes, or undefined at end. */
  readonly next: (maxBytes: number) => Uint8Array | undefined | PromiseLike<Uint8Array | undefined>
  readonly close: () => void | PromiseLike<void>
}
/** Owned adapter resource. The runtime, not the handle, owns generation validity. */
export interface ResourceHandle {
  readonly close: () => void | PromiseLike<void>
}
/** Serialized access to one resource in its acquisition generation. */
export interface Resource<THandle extends ResourceHandle> {
  readonly call: <T, TError = never>(
    start: Start<THandle, T>,
    options?: CallOptions<TError>,
  ) => Effect.Effect<T, TError>
  readonly close: Effect.Effect<void>
}
/** Scoped Rust calls and byte streams sharing one generation registry. */
export interface Runtime<TApi> {
  readonly call: <T, TError = never>(
    start: Start<TApi, T>,
    options?: CallOptions<TError>,
  ) => Effect.Effect<T, TError>
  /** Synchronous exports cannot suspend or issue host calls; interruption is checked before entry. */
  readonly callSync: <T, TError = never>(
    start: (api: TApi) => T,
    options?: CallOptions<TError>,
  ) => Effect.Effect<T, TError>
  readonly resource: <THandle extends ResourceHandle>(
    open: Start<TApi, THandle>,
  ) => Effect.Effect<Resource<THandle>, never, Scope.Scope>
  readonly inputSink: <T, TError = never>(
    open: Start<TApi, InputHandle<T>>,
    options?: CallOptions<TError>,
  ) => Sink.Sink<T, Uint8Array, never, TError>
  readonly outputStream: <TError = never>(
    open: (
      invocation: Invocation<TApi>,
      chunkBytes: number,
    ) => OutputHandle | PromiseLike<OutputHandle> | RustJob<OutputHandle>,
    options?: CallOptions<TError>,
  ) => Stream.Stream<Uint8Array, TError | Transport>
  readonly snapshot: Effect.Effect<{
    readonly generation: number
    readonly jobs: number
    readonly handles: number
    readonly state: 'healthy' | 'rebuilding' | 'retired' | 'closed'
  }>
}
/** Instance loader, panic policy, and bounded byte-transfer configuration. */
export interface RuntimeOptions<TApi> {
  readonly load: InstanceFactory<TApi>
  readonly panicPolicy?: PanicPolicy
  readonly chunkProfile?: ChunkProfile
  readonly byteBudget?: number
  /** Native adapters identify their caught panic envelope here. */
  readonly isPanic?: (cause: unknown) => boolean
  /** Native unwind boundaries can still cancel jobs; poisoned wasm cannot be called. */
  readonly panicBoundary?: 'wasm' | 'native'
}

interface Pending {
  readonly fail: (defect: unknown) => void
  readonly stop: () => Promise<void>
}
type HandleState<THandle extends ResourceHandle> =
  | { readonly state: 'pending-acquire' }
  | { readonly state: 'owned'; readonly handle: THandle }
  | { readonly state: 'closing'; readonly completed: Promise<void> }
  | { readonly state: 'closed' | 'retired' }
interface HandleOwnership<THandle extends ResourceHandle = ResourceHandle> {
  state: HandleState<THandle>
}
interface Generation<TApi> {
  readonly id: number
  readonly instance: Instance<TApi>
  readonly release: () => Promise<void>
  readonly jobs: Set<Pending>
  readonly handles: Set<HandleOwnership>
  state: 'healthy' | 'closing' | 'retired'
}

const isRustJob = <T>(value: T | PromiseLike<T> | RustJob<T>): value is RustJob<T> =>
  typeof value === 'object' && value !== null && '_tag' in value && value._tag === 'RustJob'

const isPromiseLike = <T>(value: T | PromiseLike<T>): value is PromiseLike<T> =>
  value !== null &&
  (typeof value === 'object' || typeof value === 'function') &&
  'then' in value &&
  typeof value.then === 'function'

const retiredDefect = (generation: number) => new Error(`Rust generation ${generation} is retired`)

const retireHandles = <TApi>({ generation }: { readonly generation: Generation<TApi> }): void => {
  for (const owner of generation.handles) owner.state = { state: 'retired' }
  generation.handles.clear()
}

/** B3's registry, with interruption acknowledgments and scope-owned handles. */
export const makeRuntime = Effect.fn('effect-rust.makeRuntime')(function* <TApi>(
  runtimeName: string,
  options: RuntimeOptions<TApi>,
) {
  const chunkBytes = chunkProfiles[options.chunkProfile ?? 'latency']
  const byteBudget = options.byteBudget ?? chunkBytes * 4
  if (Number.isSafeInteger(byteBudget) === false || byteBudget < chunkBytes) {
    return yield* new Init({
      runtime: runtimeName,
      message: `byteBudget must be an integer >= ${chunkBytes}`,
      cause: byteBudget,
    })
  }
  const permits = yield* Semaphore.make(byteBudget)
  let counter = 0
  let current: Generation<TApi> | undefined
  let transition: Promise<Generation<TApi>> | undefined
  let closed = false
  let terminal: unknown
  const isPanic = options.isPanic ?? ((cause: unknown) => cause instanceof WebAssembly.RuntimeError)
  const acquire = async (): Promise<Generation<TApi>> => {
    const instance = await options.load()
    let unobserve: (() => void) | undefined
    let releasing: Promise<void> | undefined
    const generation: Generation<TApi> = {
      id: ++counter,
      instance,
      jobs: new Set(),
      handles: new Set(),
      state: 'healthy',
      release: () =>
        (releasing ??= Promise.resolve().then(() => {
          unobserve?.()
          unobserve = undefined
          return instance.release()
        })),
    }
    if (closed === true) {
      await generation.release()
      throw new Error('Rust runtime scope is closed')
    }
    current = generation
    unobserve = instance.observePanic?.((defect) => {
      if (isPanic(defect) === true) poison({ generation, defect })
    })
    return generation
  }

  const dispatchClose = ({
    generation,
    owner,
  }: {
    readonly generation: Generation<TApi>
    readonly owner: HandleOwnership
  }): void | Promise<void> => {
    const state = owner.state
    if (state.state === 'closing') return state.completed
    if (state.state !== 'owned') return
    const completion = Promise.withResolvers<void>()
    // The registry indexes the owner until acknowledgment; it never retries Drop.
    // State transfer and dispatch are one synchronous step, including shutdown.
    owner.state = { state: 'closing', completed: completion.promise }
    const completed = () => {
      if (owner.state.state === 'closing') owner.state = { state: 'closed' }
      generation.handles.delete(owner)
      completion.resolve()
    }
    try {
      const result = state.handle.close()
      if (isPromiseLike(result) === true) return Promise.resolve(result).finally(completed)
      completed()
    } catch (cause) {
      completed()
      throw cause
    }
  }
  // Layer.effect retains this acquisition's Scope; no eager global initialization.
  const release = Effect.promise(async () => {
    closed = true
    if (transition !== undefined && current === undefined) {
      await transition.catch(() => undefined)
      return
    }
    const generation = current
    if (generation === undefined) return
    generation.state = 'closing'
    // Quiesce before freeing handles or releasing glue, including error paths.
    try {
      const stopped = await Promise.allSettled(Array.from(generation.jobs, (job) => job.stop()))
      for (const job of generation.jobs) job.fail(new Error('Rust runtime scope is closed'))
      generation.jobs.clear()
      const failure = stopped.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      // eslint-disable-next-line no-await-in-loop -- Rust handles must close serially in insertion order and stop at the first failure.
      for (const owner of generation.handles) await dispatchClose({ generation, owner })
    } finally {
      retireHandles({ generation })
      generation.state = 'retired'
      current = undefined
      await generation.release()
    }
  })

  const poison = ({
    generation,
    defect,
  }: {
    readonly generation: Generation<TApi>
    readonly defect: unknown
  }): void => {
    if (generation.state === 'retired') return
    generation.state = 'retired'
    terminal = defect
    if (current === generation) current = undefined
    const nativeQuiescence:
      | { readonly jobs: Pending[]; readonly acknowledgments: Promise<void>[] }
      | undefined =
      options.panicBoundary === 'native'
        ? { jobs: Array.from(generation.jobs), acknowledgments: [] }
        : undefined
    if (nativeQuiescence !== undefined) {
      for (const owner of generation.handles) {
        if (owner.state.state === 'closing')
          nativeQuiescence.acknowledgments.push(owner.state.completed)
      }
    }
    // Never start Rust destructors through poisoned borrows. Native retirement
    // still acknowledges destructors that were already dispatched.
    retireHandles({ generation })
    const rebuild = async () => {
      if (nativeQuiescence !== undefined) {
        for (const job of nativeQuiescence.jobs) nativeQuiescence.acknowledgments.push(job.stop())
        const stopped = await Promise.allSettled(nativeQuiescence.acknowledgments)
        const failure = stopped.find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
      }
      await generation.release()
      if (options.panicPolicy === 'retire' || closed === true) throw defect
      return acquire()
    }
    transition = rebuild().then(
      (next) => {
        transition = undefined
        return next
      },
      (cause: unknown) => {
        terminal = cause
        transition = undefined
        throw cause
      },
    )
    void transition.catch(() => undefined)
    // Failing a job can synchronously resume an Effect that calls again.
    // Publish retirement/rebuild before exposing that completion.
    for (const job of generation.jobs) job.fail(defect)
    generation.jobs.clear()
  }
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: acquire,
      catch: (cause) =>
        new Init({ runtime: runtimeName, message: 'Unable to construct Rust instance', cause }),
    }),
    () => release,
  )

  const generationEffect = Effect.suspend(() => {
    if (closed === true) return Effect.die(new Error('Rust runtime scope is closed'))
    if (current !== undefined) return Effect.succeed(current)
    const rebuilding = transition
    if (rebuilding !== undefined) return Effect.promise(() => rebuilding)
    return Effect.die(terminal)
  })

  const invokeOn = <T, TError = never>({
    generation,
    start,
    callOptions,
    onRetired,
    onSuccess,
  }: {
    readonly generation: Generation<TApi>
    readonly start: Start<TApi, T>
    readonly callOptions?: CallOptions<TError> | undefined
    readonly onRetired?: Effect.Effect<T, TError>
    readonly onSuccess?: ((value: T) => void) | undefined
  }): Effect.Effect<T, TError> =>
    Effect.callback<T, TError>((resume) => {
      if (closed === true || generation.state !== 'healthy') {
        resume(onRetired ?? Effect.die(retiredDefect(generation.id)))
        return
      }
      const controller = new AbortController()
      let active = true
      let operation: RustJob<T> | undefined
      // Completion includes the synchronous ownership transition, even if the
      // caller was interrupted while a consuming operation settled.
      const settlement = Promise.withResolvers<void>()
      let stopping: Promise<void> | undefined
      let wakeStopping: (() => void) | undefined
      const finish = (effect: Effect.Effect<T, TError>) => {
        if (active === false) return
        active = false
        generation.jobs.delete(job)
        resume(effect)
      }
      const job: Pending = {
        fail: (defect) => {
          controller.abort()
          wakeStopping?.()
          finish(Effect.die(defect))
        },
        stop: () =>
          (stopping ??= (async () => {
            controller.abort()
            if (generation.state === 'retired' && options.panicBoundary !== 'native') {
              await generation.release()
              return
            }
            const retirement = Promise.withResolvers<void>()
            wakeStopping = retirement.resolve
            const acknowledgment =
              operation?.mode === 'abortable' ? operation.cancel() : settlement.promise
            if (options.panicBoundary === 'native') await acknowledgment
            else {
              // Cancellation can already be waiting when the scheduler traps,
              // leaving both result and cancel promises permanently unsettled.
              await Promise.race([
                acknowledgment,
                retirement.promise.then(() => generation.release()),
              ])
            }
          })()),
      }
      generation.jobs.add(job)
      const rejected = (cause: unknown) => {
        try {
          if (isPanic(cause) === true) poison({ generation, defect: cause })
          else
            finish(
              callOptions?.decodeError === undefined
                ? Effect.die(cause)
                : callOptions.decodeError(cause),
            )
        } finally {
          settlement.resolve()
        }
      }
      const succeeded = (value: T) => {
        try {
          // Rust completion, ownership registration/consumption, job removal and
          // resumption share a callback. No scheduler boundary can orphan a handle.
          onSuccess?.(value)
          finish(Effect.succeed(value))
        } catch (cause) {
          rejected(cause)
        } finally {
          settlement.resolve()
        }
      }
      try {
        const started = start({ api: generation.instance.api, signal: controller.signal })
        if (isRustJob(started) === true) {
          operation = started
          void Promise.resolve(started.result).then(succeeded, rejected)
        } else if (isPromiseLike(started) === true) {
          void Promise.resolve(started).then(succeeded, rejected)
        } else {
          succeeded(started)
        }
      } catch (cause) {
        rejected(cause)
      }
      return Effect.promise(async () => {
        active = false
        try {
          await job.stop()
        } catch (cause) {
          if (isPanic(cause) === true) poison({ generation, defect: cause })
          throw cause
        } finally {
          generation.jobs.delete(job)
        }
      })
    })

  const acquireHandle = <THandle extends ResourceHandle, TError = never>({
    generation,
    start,
    callOptions,
  }: {
    readonly generation: Generation<TApi>
    readonly start: Start<TApi, THandle>
    readonly callOptions?: CallOptions<TError> | undefined
  }): Effect.Effect<HandleOwnership<THandle>, TError> => {
    const owner: HandleOwnership<THandle> = { state: { state: 'pending-acquire' } }
    return invokeOn({
      generation,
      start,
      callOptions,
      onSuccess: (handle) => {
        if (generation.state === 'retired') owner.state = { state: 'retired' }
        else {
          owner.state = { state: 'owned', handle }
          generation.handles.add(owner)
        }
      },
    }).pipe(Effect.as(owner))
  }
  const invokeHandle = <THandle extends ResourceHandle, T, TError = never>({
    generation,
    owner,
    start,
    callOptions,
    onSuccess,
  }: {
    readonly generation: Generation<TApi>
    readonly owner: HandleOwnership<THandle>
    readonly start: Start<THandle, T>
    readonly callOptions?: CallOptions<TError> | undefined
    readonly onSuccess?: ((value: T) => void) | undefined
  }): Effect.Effect<T, TError> =>
    invokeOn({
      generation,
      start: ({ signal }) => {
        const state = owner.state
        if (state.state !== 'owned') throw new Error('Rust resource is closed')
        return start({ api: state.handle, signal })
      },
      callOptions,
      onSuccess,
    })
  const closeHandle = ({
    generation,
    owner,
  }: {
    readonly generation: Generation<TApi>
    readonly owner: HandleOwnership
  }): Effect.Effect<void> =>
    invokeOn({
      generation,
      // A closing runtime owns the registry; poisoned generations discard handles.
      onRetired: Effect.void,
      start: () => dispatchClose({ generation, owner }),
    }).pipe(Effect.uninterruptible)

  const call = Effect.fn('effect-rust.call')(
    <T, TError = never>(start: Start<TApi, T>, callOptions?: CallOptions<TError>) =>
      Effect.flatMap(generationEffect, (generation) =>
        invokeOn({ generation, start, callOptions }),
      ),
  )

  // A synchronous Rust call cannot interleave with scope release, poison, or
  // interruption. It needs the same generation check, but no job, abort signal,
  // callback fiber, or cancellation finalizer. Rebuilding still suspends.
  const callSync = <T, TError = never>(
    start: (api: TApi) => T,
    callOptions?: CallOptions<TError>,
  ): Effect.Effect<T, TError> => {
    const invoke = (generation: Generation<TApi>): Effect.Effect<T, TError> => {
      if (closed === true || generation.state !== 'healthy')
        return Effect.die(retiredDefect(generation.id))
      try {
        return Effect.succeed(start(generation.instance.api))
      } catch (cause) {
        if (isPanic(cause) === true) {
          poison({ generation, defect: cause })
          return Effect.die(cause)
        }
        return callOptions?.decodeError === undefined
          ? Effect.die(cause)
          : callOptions.decodeError(cause)
      }
    }
    return Effect.suspend(() =>
      current === undefined ? Effect.flatMap(generationEffect, invoke) : invoke(current),
    )
  }

  const resource = Effect.fn('effect-rust.resource')(
    <THandle extends ResourceHandle>(open: Start<TApi, THandle>) =>
      Effect.gen(function* () {
        const generation = yield* generationEffect
        const serial = yield* Semaphore.make(1)
        const owner = yield* acquireHandle({ generation, start: open })
        // Waiting for a queued borrow remains interruptible. Once admitted, close
        // masks interruption until its atomic dispatch and acknowledgment finish.
        const close = closeHandle({ generation, owner }).pipe(Semaphore.withPermits(serial, 1))
        // eslint-disable-next-line overeng/named-args -- Resource.call follows Runtime.call's public positional (start, options) contract.
        const resourceCall: Resource<THandle>['call'] = (start, callOptions) =>
          invokeHandle({ generation, owner, start, callOptions }).pipe(
            Semaphore.withPermits(serial, 1),
          )
        yield* Effect.addFinalizer(() => close)
        return { call: resourceCall, close } satisfies Resource<THandle>
      }).pipe(Effect.uninterruptible),
  )
  // eslint-disable-next-line overeng/named-args -- Runtime.inputSink preserves the public positional (open, options) signature.
  const inputSink = <T, TError = never>(
    open: Start<TApi, InputHandle<T>>,
    callOptions?: CallOptions<TError>,
  ): Sink.Sink<T, Uint8Array, never, TError> =>
    Sink.unwrap(
      Effect.gen(function* () {
        const generation = yield* generationEffect
        const owner = yield* Effect.acquireRelease(
          acquireHandle({ generation, start: open, callOptions }),
          (acquiredOwner) => closeHandle({ generation, owner: acquiredOwner }),
        )
        return Sink.forEach<Uint8Array, void, TError, never>(
          Effect.fn('effect-rust.input.write')(function* (bytes) {
            for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
              const chunk = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength))
              yield* invokeHandle({
                generation,
                owner,
                start: ({ api }) => api.write(chunk),
                callOptions,
              }).pipe(Semaphore.withPermits(permits, chunk.byteLength))
            }
          }),
        ).pipe(
          Sink.mapEffect(() =>
            invokeHandle({
              generation,
              owner,
              start: ({ api }) => api.finish(),
              callOptions,
              onSuccess: () => {
                if (owner.state.state !== 'owned') return
                owner.state = { state: 'closed' }
                generation.handles.delete(owner)
              },
            }),
          ),
        )
      }),
    )

  // eslint-disable-next-line overeng/named-args -- Runtime.outputStream preserves the public positional (open, options) signature.
  const outputStream = <TError = never>(
    open: (
      invocation: Invocation<TApi>,
      chunkBytes: number,
    ) => OutputHandle | PromiseLike<OutputHandle> | RustJob<OutputHandle>,
    callOptions?: CallOptions<TError>,
  ): Stream.Stream<Uint8Array, TError | Transport> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const generation = yield* generationEffect
        const owner = yield* Effect.acquireRelease(
          acquireHandle({
            generation,
            start: (invocation) => open(invocation, chunkBytes),
            callOptions,
          }),
          (acquiredOwner) => closeHandle({ generation, owner: acquiredOwner }),
        )
        let held = 0
        const releaseBytes = Effect.suspend(() => {
          const bytes = held
          held = 0
          return Semaphore.release(permits, bytes).pipe(Effect.asVoid)
        })
        yield* Effect.addFinalizer(() => releaseBytes)
        return Stream.unfold(undefined, () =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              yield* releaseBytes
              yield* restore(Semaphore.take(permits, chunkBytes))
              held = chunkBytes
              const bytes = yield* restore(
                invokeHandle({
                  generation,
                  owner,
                  start: ({ api }) => api.next(chunkBytes),
                  callOptions,
                }),
              )
              if (bytes === undefined) {
                yield* releaseBytes
                return undefined
              }
              if (bytes.byteLength > chunkBytes) {
                return yield* new Transport({
                  operation: 'output_stream.next',
                  message: `Rust returned ${bytes.byteLength} bytes, limit is ${chunkBytes}`,
                  cause: bytes.byteLength,
                })
              }
              yield* Semaphore.release(permits, held - bytes.byteLength)
              held = bytes.byteLength
              return [bytes, undefined] as const
            }),
          ),
        )
      }),
    )

  const snapshot = Effect.sync(() => ({
    generation: counter,
    jobs: current?.jobs.size ?? 0,
    handles: current?.handles.size ?? 0,
    state:
      closed === true
        ? ('closed' as const)
        : current !== undefined
          ? ('healthy' as const)
          : transition !== undefined && options.panicPolicy !== 'retire'
            ? ('rebuilding' as const)
            : ('retired' as const),
  }))
  const runtime: Runtime<TApi> = { call, callSync, resource, inputSink, outputStream, snapshot }
  return runtime
})
