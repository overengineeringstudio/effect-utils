import { Context, Effect, Exit, Schema } from 'effect'

import { Input, Transport } from './errors.ts'

/** Whether cancellation interrupts host work or waits for it to settle. */
export type CancellationMode = 'abortable' | 'settle-only'

/** Scope-owned host calls with explicit cancellation and quiescence tracking. */
export interface HostCapability<TArgs extends ReadonlyArray<unknown>, TValue> {
  readonly mode: CancellationMode
  readonly call: (signal: AbortSignal, ...args: TArgs) => Promise<TValue>
  /** Resolves after every host operation and its Effect finalizers are done. */
  readonly quiesce: Effect.Effect<void>
  readonly live: Effect.Effect<number>
}

/** Capture dependencies once, inside the owning Layer's scope. */
export const hostCapability = Effect.fn('effect-rust.hostCapability')(function* <
  TArgs extends ReadonlyArray<unknown>,
  TValue,
  TError,
  TServices,
>(mode: CancellationMode, run: (...args: TArgs) => Effect.Effect<TValue, TError, TServices>) {
  const context = yield* Effect.context<TServices>()
  const runExit = Effect.runPromiseExitWith(context)
  const pending = new Set<Promise<void>>()
  const controllers = new Set<AbortController>()
  let closed = false
  const quiesce = Effect.promise(async () => {
    await Promise.all(pending)
  })
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true
      for (const controller of controllers) controller.abort()
      yield* quiesce
    }),
  )
  const call = async (signal: AbortSignal, ...args: TArgs): Promise<TValue> => {
    if (closed === true) throw new Error('Rust host capability scope is closed')
    const controller = new AbortController()
    controllers.add(controller)
    const abort = () => {
      controller.abort()
    }
    if (signal.aborted === true) abort()
    else signal.addEventListener('abort', abort, { once: true })
    const program = Effect.scoped(Effect.suspend(() => run(...args)))
    // settle-only does not pretend that an interrupt stopped an underlying operation.
    const result = runExit(
      mode === 'settle-only' ? Effect.uninterruptible(program) : program,
      mode === 'abortable' ? { signal: controller.signal } : undefined,
    )
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    pending.add(settled)
    try {
      const exit = await result
      if (Exit.isSuccess(exit) === true) return exit.value
      return await Effect.runPromiseWith(Context.empty())(Effect.failCause(exit.cause))
    } finally {
      signal.removeEventListener('abort', abort)
      pending.delete(settled)
      controllers.delete(controller)
    }
  }
  const capability: HostCapability<TArgs, TValue> = {
    mode,
    call,
    quiesce,
    live: Effect.sync(() => pending.size),
  }
  return capability
})

/** Effect-owned file reads. There is no implicit open handle or file snapshot. */
export interface Source<TError = never, TServices = never> {
  /** Whole-file read; no size bound is implied. */
  readonly read: (path: string) => Effect.Effect<Uint8Array, TError, TServices>
  /**
   * At most maxBytes bytes from the absolute byte offset. maxBytes is a positive
   * u32 and offset is a u64. Short reads are allowed, not proof of EOF; an empty
   * response reports EOF at this offset. The host owns file-change consistency.
   */
  readonly readRange: (
    path: string,
    offset: bigint,
    maxBytes: number,
  ) => Effect.Effect<Uint8Array, TError, TServices>
}

const sourceRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('read'), path: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('readRange'),
    path: Schema.String,
    offset: Schema.BigInt.check(
      Schema.isBetweenBigInt({ minimum: 0n, maximum: 18446744073709551615n }),
    ),
    maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4294967295 })),
  }),
  Schema.Struct({ kind: Schema.Literal('yield') }),
])
const decodeSourceRequest = Schema.decodeUnknownEffect(sourceRequest, {
  onExcessProperty: 'error',
})

/** Native and wasm use the same typed protocol, including exact u64 bigint offsets. */
export type SourceRequest =
  | { readonly kind: 'read'; readonly path: string }
  | {
      readonly kind: 'readRange'
      readonly path: string
      readonly offset: bigint
      readonly maxBytes: number
    }
  | { readonly kind: 'yield' }
/** Request callback shared by Node-API and wasm adapter bridges. */
export type SourceCallback = (request: SourceRequest) => Promise<Uint8Array>
/** Scoped Source bridge with range reads and cooperative host task yielding. */
export type HostSource = HostCapability<readonly [SourceRequest], Uint8Array>

/** A cancellable event-loop task, not a microtask-only scheduler yield. */
export const eventLoopYield: Effect.Effect<void> = Effect.callback<void>((resume) => {
  const task = setTimeout(() => resume(Effect.void), 0)
  return Effect.sync(() => clearTimeout(task))
})

/** Reads and cooperative yields share scope ownership, cancellation and quiescence. */
export const hostSource = Effect.fn('effect-rust.hostSource')(function* <TError, TServices>(
  mode: CancellationMode,
  source: Source<TError, TServices>,
) {
  return yield* hostCapability(
    mode,
    Effect.fn('effect-rust.Source.call')(function* (request: SourceRequest) {
      const decoded = yield* decodeSourceRequest(request).pipe(
        Effect.mapError(
          (cause) =>
            new Input({ operation: 'Source', message: 'Invalid host Source request', cause }),
        ),
      )
      if (decoded.kind === 'yield') {
        yield* eventLoopYield
        return new Uint8Array(0)
      }
      const bytes = yield* decoded.kind === 'read'
        ? source.read(decoded.path)
        : source.readRange(decoded.path, decoded.offset, decoded.maxBytes)
      if (
        !(bytes instanceof Uint8Array) ||
        (decoded.kind === 'readRange' && bytes.byteLength > decoded.maxBytes)
      ) {
        return yield* new Transport({
          operation: 'Source',
          message: 'Host Source must return Uint8Array within the requested maxBytes',
          cause: bytes,
        })
      }
      return bytes
    }),
  )
})
