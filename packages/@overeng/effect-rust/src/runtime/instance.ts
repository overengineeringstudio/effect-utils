import { Effect, Semaphore, Sink, Stream } from 'effect'

import { Init, Transport } from './errors.ts'

export type PanicPolicy = 'rebuild' | 'retire'
export type ChunkProfile = 'latency' | 'bulk'
export const chunkProfiles = { latency: 64 * 1024, bulk: 256 * 1024 } as const

/** The factory must close over fresh glue state as well as a fresh instance. */
export interface Instance<TApi> {
  readonly api: TApi
  readonly release: () => void | PromiseLike<void>
}
export type InstanceFactory<TApi> = () => Instance<TApi> | PromiseLike<Instance<TApi>>

/** cancel resolves only after Rust has dropped its future and stopped host calls. */
export type RustJob<T> =
  | { readonly _tag: 'RustJob'; readonly mode: 'abortable'; readonly result: PromiseLike<T>; readonly cancel: () => void | PromiseLike<void> }
  | { readonly _tag: 'RustJob'; readonly mode: 'settle-only'; readonly result: PromiseLike<T> }

export interface Invocation<TApi> {
  readonly api: TApi
  readonly signal: AbortSignal
}
export type Start<TApi, T> = (invocation: Invocation<TApi>) => T | PromiseLike<T> | RustJob<T>
export interface CallOptions<TError> {
  readonly decodeError?: (cause: unknown) => Effect.Effect<never, TError>
}
export interface InputHandle<T> {
  readonly write: (bytes: Uint8Array) => void | PromiseLike<void>
  /** Consumes the Rust handle on success. */
  readonly finish: () => T | PromiseLike<T>
  readonly close: () => void | PromiseLike<void>
}
export interface OutputHandle {
  /** Returns owned bytes, bounded by maxBytes, or undefined at end. */
  readonly next: (maxBytes: number) => Uint8Array | undefined | PromiseLike<Uint8Array | undefined>
  readonly close: () => void | PromiseLike<void>
}
export interface Runtime<TApi> {
  readonly call: <T, TError = never>(start: Start<TApi, T>, options?: CallOptions<TError>) => Effect.Effect<T, TError>
  readonly inputSink: <T, TError = never>(open: Start<TApi, InputHandle<T>>, options?: CallOptions<TError>) => Sink.Sink<T, Uint8Array, never, TError>
  readonly outputStream: <TError = never>(open: (invocation: Invocation<TApi>, chunkBytes: number) => OutputHandle | PromiseLike<OutputHandle> | RustJob<OutputHandle>, options?: CallOptions<TError>) => Stream.Stream<Uint8Array, TError | Transport>
  readonly snapshot: Effect.Effect<{ readonly generation: number; readonly jobs: number; readonly handles: number; readonly state: 'healthy' | 'rebuilding' | 'retired' | 'closed' }>
}
export interface RuntimeOptions<TApi> {
  readonly load: InstanceFactory<TApi>
  readonly panicPolicy?: PanicPolicy
  readonly chunkProfile?: ChunkProfile
  readonly byteBudget?: number
  /** Native adapters identify their caught panic envelope here. */
  readonly isPanic?: (cause: unknown) => boolean
}

interface Pending {
  readonly fail: (defect: unknown) => void
  readonly stop: () => Promise<void>
}
interface Handle {
  readonly close: () => void | PromiseLike<void>
}
interface Generation<TApi> {
  readonly id: number
  readonly instance: Instance<TApi>
  readonly release: () => Promise<void>
  readonly jobs: Set<Pending>
  readonly handles: Set<Handle>
  state: 'healthy' | 'retired'
}

const isRustJob = <T>(value: T | PromiseLike<T> | RustJob<T>): value is RustJob<T> =>
  typeof value === 'object' && value !== null && '_tag' in value && value._tag === 'RustJob'

const retiredDefect = (generation: number) => new Error(`Rust generation ${generation} is retired`)

/** B3's registry, with interruption acknowledgments and scope-owned handles. */
export const makeRuntime = Effect.fn('effect-rust.makeRuntime')(function* <TApi>(
  runtimeName: string,
  options: RuntimeOptions<TApi>,
) {
  const chunkBytes = chunkProfiles[options.chunkProfile ?? 'latency']
  const byteBudget = options.byteBudget ?? chunkBytes * 4
  if (!Number.isSafeInteger(byteBudget) || byteBudget < chunkBytes) {
    return yield* new Init({ runtime: runtimeName, message: `byteBudget must be an integer >= ${chunkBytes}`, cause: byteBudget })
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
    let releasing: Promise<void> | undefined
    const generation: Generation<TApi> = {
      id: ++counter, instance, jobs: new Set(), handles: new Set(), state: 'healthy',
      release: () => releasing ??= Promise.resolve().then(() => instance.release()),
    }
    if (closed) {
      await generation.release()
      throw new Error('Rust runtime scope is closed')
    }
    current = generation
    return generation
  }
  // Layer.effect retains this acquisition's Scope; no eager global initialization.
  const release = Effect.promise(async () => {
    closed = true
    if (transition !== undefined && current === undefined) { await transition.catch(() => undefined); return }
    const generation = current
    if (generation === undefined) return
    // Quiesce before freeing handles or releasing glue, including error paths.
    try {
      const stopped = await Promise.allSettled(Array.from(generation.jobs, (job) => job.stop()))
      for (const job of generation.jobs) job.fail(new Error('Rust runtime scope is closed'))
      generation.jobs.clear()
      const failure = stopped.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      for (const handle of generation.handles) await handle.close()
    } finally {
      generation.handles.clear()
      generation.state = 'retired'
      current = undefined
      await generation.release()
    }
  })
  yield* Effect.acquireRelease(
    Effect.tryPromise({ try: acquire, catch: (cause) => new Init({ runtime: runtimeName, message: 'Unable to construct Rust instance', cause }) }),
    () => release,
  )

  const poison = (generation: Generation<TApi>, defect: unknown): void => {
    if (generation.state !== 'healthy') return
    generation.state = 'retired'
    terminal = defect
    if (current === generation) current = undefined
    // Never call Rust handle destructors through poisoned borrows.
    generation.handles.clear()
    for (const job of generation.jobs) job.fail(defect)
    generation.jobs.clear()
    const rebuild = async () => {
      await generation.release()
      if (options.panicPolicy === 'retire' || closed) throw defect
      return acquire()
    }
    transition = rebuild().then(
      (next) => { transition = undefined; return next },
      (cause: unknown) => { terminal = cause; transition = undefined; throw cause },
    )
    void transition.catch(() => undefined)
  }

  const generationEffect = Effect.suspend(() => {
    if (closed) return Effect.die(new Error('Rust runtime scope is closed'))
    if (current !== undefined) return Effect.succeed(current)
    const rebuilding = transition
    if (rebuilding !== undefined) return Effect.promise(() => rebuilding)
    return Effect.die(terminal)
  })

  const invokeOn = <T, TError>(generation: Generation<TApi>, start: Start<TApi, T>, options?: CallOptions<TError>): Effect.Effect<T, TError> =>
    Effect.callback<T, TError>((resume) => {
      if (generation.state !== 'healthy') { resume(Effect.die(retiredDefect(generation.id))); return }
      const controller = new AbortController()
      let active = true
      let operation: RustJob<T> | undefined
      let settlement: Promise<void> = Promise.resolve()
      let stopping: Promise<void> | undefined
      const finish = (effect: Effect.Effect<T, TError>) => {
        if (!active) return
        active = false
        generation.jobs.delete(job)
        resume(effect)
      }
      const job: Pending = {
        fail: (defect) => { controller.abort(); finish(Effect.die(defect)) },
        stop: () => stopping ??= (async () => {
          controller.abort()
          if (generation.state !== 'healthy') { await generation.release(); return }
          if (operation?.mode === 'abortable') await operation.cancel()
          else await settlement
        })(),
      }
      generation.jobs.add(job)
      const rejected = (cause: unknown) => {
        if (isPanic(cause)) poison(generation, cause)
        else finish(options?.decodeError === undefined ? Effect.die(cause) : options.decodeError(cause))
      }
      try {
        const started = start({ api: generation.instance.api, signal: controller.signal })
        if (isRustJob(started)) {
          operation = started
          settlement = Promise.resolve(started.result).then((value) => { finish(Effect.succeed(value)) }, rejected)
        } else {
          settlement = Promise.resolve(started).then((value) => { finish(Effect.succeed(value)) }, rejected)
        }
      } catch (cause) { rejected(cause) }
      return Effect.promise(async () => {
        active = false
        try { await job.stop() } catch (cause) { if (isPanic(cause)) poison(generation, cause); throw cause }
        finally { generation.jobs.delete(job) }
      })
    })

  const call = Effect.fn('effect-rust.call')(<T, TError = never>(start: Start<TApi, T>, options?: CallOptions<TError>) =>
    Effect.flatMap(generationEffect, (generation) => invokeOn(generation, start, options)))

  const inputSink = <T, TError = never>(open: Start<TApi, InputHandle<T>>, options?: CallOptions<TError>): Sink.Sink<T, Uint8Array, never, TError> =>
    Sink.unwrap(Effect.gen(function* () {
      const generation = yield* generationEffect
      const handle = yield* Effect.acquireRelease(
        invokeOn(generation, open, options).pipe(Effect.tap((handle) => Effect.sync(() => { generation.handles.add(handle) }))),
        (handle) => Effect.suspend(() => {
          if (!generation.handles.delete(handle) || generation.state !== 'healthy') return Effect.void
          return invokeOn(generation, () => handle.close())
        }),
      )
      return Sink.forEach<Uint8Array, void, TError, never>(Effect.fn('effect-rust.input.write')(function* (bytes) {
        for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
          const chunk = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength))
          yield* invokeOn(generation, () => handle.write(chunk), options).pipe(Semaphore.withPermits(permits, chunk.byteLength))
        }
      })).pipe(Sink.mapEffect(() => invokeOn(generation, () => handle.finish(), options).pipe(
        Effect.tap(() => Effect.sync(() => { generation.handles.delete(handle) })),
      )))
    }))

  const outputStream = <TError = never>(open: (invocation: Invocation<TApi>, chunkBytes: number) => OutputHandle | PromiseLike<OutputHandle> | RustJob<OutputHandle>, options?: CallOptions<TError>): Stream.Stream<Uint8Array, TError | Transport> =>
    Stream.unwrap(Effect.gen(function* () {
      const generation = yield* generationEffect
      const handle = yield* Effect.acquireRelease(
        invokeOn(generation, (invocation) => open(invocation, chunkBytes), options).pipe(Effect.tap((handle) => Effect.sync(() => { generation.handles.add(handle) }))),
        (handle) => Effect.suspend(() => {
          if (!generation.handles.delete(handle) || generation.state !== 'healthy') return Effect.void
          return invokeOn(generation, () => handle.close())
        }),
      )
      let held = 0
      const release = Effect.suspend(() => {
        const bytes = held
        held = 0
        return Semaphore.release(permits, bytes).pipe(Effect.asVoid)
      })
      yield* Effect.addFinalizer(() => release)
      return Stream.unfold(undefined, () => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        yield* release
        yield* restore(Semaphore.take(permits, chunkBytes))
        held = chunkBytes
        const bytes = yield* restore(invokeOn(generation, () => handle.next(chunkBytes), options))
        if (bytes === undefined) { yield* release; return undefined }
        if (bytes.byteLength > chunkBytes) {
          return yield* new Transport({ operation: 'output_stream.next', message: `Rust returned ${bytes.byteLength} bytes, limit is ${chunkBytes}`, cause: bytes.byteLength })
        }
        yield* Semaphore.release(permits, held - bytes.byteLength)
        held = bytes.byteLength
        return [bytes, undefined] as const
      })))
    }))

  const snapshot = Effect.sync(() => ({ generation: counter, jobs: current?.jobs.size ?? 0, handles: current?.handles.size ?? 0, state: closed ? 'closed' as const : current !== undefined ? 'healthy' as const : transition !== undefined && options.panicPolicy !== 'retire' ? 'rebuilding' as const : 'retired' as const }))
  const runtime: Runtime<TApi> = { call, inputSink, outputStream, snapshot }
  return runtime
})
