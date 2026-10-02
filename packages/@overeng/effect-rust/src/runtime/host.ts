import { Context, Effect, Exit } from 'effect'

export type CancellationMode = 'abortable' | 'settle-only'

export interface HostCapability<TArgs extends ReadonlyArray<unknown>, TValue> {
  readonly mode: CancellationMode
  readonly call: (signal: AbortSignal, ...args: TArgs) => Promise<TValue>
  /** Resolves after every host operation and its Effect finalizers are done. */
  readonly quiesce: Effect.Effect<void>
  readonly live: Effect.Effect<number>
}

/** Capture dependencies once, inside the owning Layer's scope. */
export const hostCapability = Effect.fn('effect-rust.hostCapability')(function* <TArgs extends ReadonlyArray<unknown>, TValue, TError, TServices>(
  mode: CancellationMode,
  run: (...args: TArgs) => Effect.Effect<TValue, TError, TServices>,
) {
  const context = yield* Effect.context<TServices>()
  const runExit = Effect.runPromiseExitWith(context)
  const pending = new Set<Promise<void>>()
  const controllers = new Set<AbortController>()
  let closed = false
  const quiesce = Effect.promise(async () => { await Promise.all(pending) })
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    closed = true
    for (const controller of controllers) controller.abort()
    yield* quiesce
  }))
  const call = async (signal: AbortSignal, ...args: TArgs): Promise<TValue> => {
    if (closed) throw new Error('Rust host capability scope is closed')
    const controller = new AbortController()
    controllers.add(controller)
    const abort = () => { controller.abort() }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    const program = Effect.scoped(Effect.suspend(() => run(...args)))
    // settle-only does not pretend that an interrupt stopped an underlying operation.
    const result = runExit(mode === 'settle-only' ? Effect.uninterruptible(program) : program, mode === 'abortable' ? { signal: controller.signal } : undefined)
    const settled = result.then(() => undefined, () => undefined)
    pending.add(settled)
    try {
      const exit = await result
      if (Exit.isSuccess(exit)) return exit.value
      return await Effect.runPromiseWith(Context.empty())(Effect.failCause(exit.cause))
    } finally {
      signal.removeEventListener('abort', abort)
      pending.delete(settled)
      controllers.delete(controller)
    }
  }
  const capability: HostCapability<TArgs, TValue> = { mode, call, quiesce, live: Effect.sync(() => pending.size) }
  return capability
})
