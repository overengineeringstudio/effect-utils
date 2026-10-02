import { describe, expect, it } from '@effect/vitest'
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Stream } from 'effect'

import { wasmLayer } from './interop.ts'
import { chunkProfiles, makeRuntime, type Instance, type RustJob, type Runtime } from './instance.ts'

// Real wasm trap and identity exports, without a Rust toolchain or cached bindgen glue.
const module = new WebAssembly.Module(new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 9, 2, 96, 0, 0, 96, 1, 127, 1, 127,
  3, 3, 2, 0, 1,
  7, 16, 2, 4, 116, 114, 97, 112, 0, 0, 5, 118, 97, 108, 117, 101, 0, 1,
  10, 10, 2, 3, 0, 0, 11, 4, 0, 32, 0, 11,
]))
interface FakeApi {
  readonly value: (input: number) => number
  readonly trap: () => void
  readonly pending: () => Promise<never>
}
const fake = () => {
  let loads = 0
  let releases = 0
  let live = 0
  const load = (): Instance<FakeApi> => {
    loads++
    const instance = new WebAssembly.Instance(module)
    const value = instance.exports.value
    const trap = instance.exports.trap
    if (typeof value !== 'function' || typeof trap !== 'function') throw new Error('Invalid test wasm exports')
    const pending = new Set<(cause: unknown) => void>()
    return {
      api: {
        value: (input) => Number(value(input)),
        trap: () => { trap() },
        pending: () => new Promise<never>((_, reject) => { pending.add(reject); live++ }),
      },
      release: () => {
        releases++
        live -= pending.size
        for (const reject of pending) reject(new Error('Instance released'))
        pending.clear()
      },
    }
  }
  return { load, counts: () => ({ loads, releases, live }) }
}

const assertDefect = <T, TError>(exit: Exit.Exit<T, TError>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true)
}

describe('instance generations', () => {
  it.effect('traps kill every pending Effect, retire glue, and rebuild before the next call', () => Effect.gen(function* () {
    const fixture = fake()
    class Core extends Context.Service<Core, Runtime<FakeApi>>()('test/Core') {}
    const context = yield* Layer.build(wasmLayer.node(Core, { load: fixture.load, make: (runtime) => runtime }))
    const runtime = Context.get(context, Core)
    const waiting = yield* runtime.call(({ api }) => api.pending()).pipe(Effect.forkChild({ startImmediately: true }))
    expect((yield* runtime.snapshot).jobs).toBe(1)
    assertDefect(yield* Effect.exit(runtime.call(({ api }) => api.trap())))
    assertDefect(yield* Fiber.await(waiting))
    expect(yield* runtime.call(({ api }) => api.value(42))).toBe(42)
    expect(fixture.counts()).toEqual({ loads: 2, releases: 1, live: 0 })
    expect(yield* runtime.snapshot).toMatchObject({ generation: 2, jobs: 0, handles: 0, state: 'healthy' })
  }))

  it.effect('does not run Rust destructors through a handle poisoned by a wasm trap', () => Effect.gen(function* () {
    const fixture = fake()
    const runtime = yield* makeRuntime('test', { load: fixture.load })
    let destructors = 0
    const sink = runtime.inputSink(({ api }) => ({
      write: () => api.trap(),
      finish: () => 0,
      close: () => { destructors++ },
    }))
    assertDefect(yield* Effect.exit(Stream.run(Stream.make(new Uint8Array([1])), sink)))
    expect(destructors).toBe(0)
    expect(yield* runtime.call(({ api }) => api.value(17))).toBe(17)
    expect(fixture.counts().releases).toBe(1)
  }))

  it.effect('retire policy never reloads and rebuild failure is a defect, not Init', () => Effect.gen(function* () {
    const fixture = fake()
    const retired = yield* makeRuntime('test', { load: fixture.load, panicPolicy: 'retire' })
    assertDefect(yield* Effect.exit(retired.call(({ api }) => api.trap())))
    assertDefect(yield* Effect.exit(retired.call(({ api }) => api.value(7))))
    expect(fixture.counts().loads).toBe(1)
    let attempts = 0
    const runtime = yield* makeRuntime('test', { load: () => { if (attempts++ > 0) throw new Error('rebuild failed'); return fixture.load() } })
    assertDefect(yield* Effect.exit(runtime.call(({ api }) => api.trap())))
    assertDefect(yield* Effect.exit(runtime.call(({ api }) => api.value(7))))
    expect(attempts).toBe(2)
  }))

  it.effect('awaits Rust cancellation acknowledgment with no live handles after 1000 cycles', () => Effect.gen(function* () {
    const runtime = yield* makeRuntime('test', { load: () => ({ api: undefined, release: () => undefined }) })
    let live = 0
    for (let index = 0; index < 1000; index++) {
      const started = yield* Deferred.make<void>()
      const operation = runtime.call((): RustJob<number> => {
        live++
        Deferred.doneUnsafe(started, Effect.void)
        return { _tag: 'RustJob', mode: 'abortable', result: new Promise<number>(() => undefined), cancel: async () => { await Promise.resolve(); live-- } }
      })
      const fiber = yield* operation.pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      expect(live).toBe(0)
    }
    expect((yield* runtime.snapshot).jobs).toBe(0)
  }))

  it.effect('settle-only interruption waits for completion rather than leaving Rust live', () => Effect.gen(function* () {
    const runtime = yield* makeRuntime('test', { load: () => ({ api: undefined, release: () => undefined }) })
    const started = yield* Deferred.make<void>()
    let complete: (value: number) => void = () => undefined
    let live = 0
    const job = yield* runtime.call(() => {
      live++
      Deferred.doneUnsafe(started, Effect.void)
      return new Promise<number>((resolve) => { complete = (value) => { live--; resolve(value) } })
    }).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    let interrupted = false
    const interruption = yield* Fiber.interrupt(job).pipe(Effect.tap(() => Effect.sync(() => { interrupted = true })), Effect.forkChild({ startImmediately: true }))
    yield* Effect.yieldNow
    expect(interrupted).toBe(false)
    expect(live).toBe(1)
    complete(9)
    yield* Fiber.join(interruption)
    expect(interrupted).toBe(true)
    expect(live).toBe(0)
    expect((yield* runtime.snapshot).jobs).toBe(0)
  }))
})

describe('Sink and Stream byte backpressure', () => {
  it.effect('splits input by profile and waits for write acknowledgment before pulling again', () => Effect.gen(function* () {
    const runtime = yield* makeRuntime('test', { load: () => ({ api: undefined, release: () => undefined }), chunkProfile: 'latency', byteBudget: chunkProfiles.latency })
    const writing = yield* Deferred.make<void>()
    const proceed = yield* Deferred.make<void>()
    let pulled = 0
    const sizes: number[] = []
    let finished = false
    const sink = runtime.inputSink(() => ({
      write: (bytes) => {
        sizes.push(bytes.byteLength)
        if (sizes.length === 1) { Deferred.doneUnsafe(writing, Effect.void); return Effect.runPromise(Deferred.await(proceed)) }
        return undefined
      },
      finish: () => { finished = true; return sizes.reduce((sum, size) => sum + size, 0) },
      close: () => { throw new Error('finish consumes the handle; must not close twice') },
    }))
    const source = Stream.unfold(0, (index) => Effect.sync(() => {
      if (index === 2) return undefined
      pulled++
      return [new Uint8Array(chunkProfiles.latency + 17), index + 1] as const
    }))
    const fiber = yield* Stream.run(source, sink).pipe(Effect.forkChild)
    yield* Deferred.await(writing)
    expect(pulled).toBe(1)
    expect(sizes).toEqual([65536])
    yield* Deferred.succeed(proceed, undefined)
    expect(yield* Fiber.join(fiber)).toBe(2 * (65536 + 17))
    expect(sizes).toEqual([65536, 17, 65536, 17])
    expect(finished).toBe(true)
    expect((yield* runtime.snapshot).handles).toBe(0)
  }))

  it.effect('does not prefetch and shares a byte budget across concurrent output streams', () => Effect.gen(function* () {
    const runtime = yield* makeRuntime('test', { load: () => ({ api: undefined, release: () => undefined }), chunkProfile: 'bulk', byteBudget: chunkProfiles.bulk })
    const first = yield* Deferred.make<void>()
    const proceed = yield* Deferred.make<void>()
    let nextA = 0
    let nextB = 0
    let closed = 0
    const outputA = runtime.outputStream((_, profile) => {
      expect(profile).toBe(262144)
      return { next: (limit) => { nextA++; return nextA === 1 ? new Uint8Array(limit).fill(3) : undefined }, close: () => { closed++ } }
    })
    const outputB = runtime.outputStream(() => ({ next: (limit) => { nextB++; return nextB === 1 ? new Uint8Array(limit).fill(4) : undefined }, close: () => { closed++ } }))
    const a = yield* Stream.runForEach(outputA, (bytes) => Effect.gen(function* () {
      expect(bytes[0]).toBe(3)
      yield* Deferred.succeed(first, undefined)
      yield* Deferred.await(proceed)
    })).pipe(Effect.forkChild)
    yield* Deferred.await(first)
    const b = yield* Stream.runCollect(outputB).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Effect.yieldNow
    expect(nextA).toBe(1)
    expect(nextB).toBe(0)
    yield* Deferred.succeed(proceed, undefined)
    yield* Fiber.join(a)
    const bytes = yield* Fiber.join(b)
    expect(bytes[0]?.byteLength).toBe(262144)
    expect(bytes[0]?.[0]).toBe(4)
    expect(nextA).toBe(2)
    expect(nextB).toBe(2)
    expect(closed).toBe(2)
    expect((yield* runtime.snapshot).handles).toBe(0)
  }))

  it.effect('interrupted output consumers release their held byte budget and Rust handle', () => Effect.gen(function* () {
    const runtime = yield* makeRuntime('test', { load: () => ({ api: undefined, release: () => undefined }), byteBudget: chunkProfiles.latency })
    const consumed = yield* Deferred.make<void>()
    let closed = 0
    const output = runtime.outputStream(() => ({
      next: (limit) => new Uint8Array(limit).fill(7),
      close: () => { closed++ },
    }))
    const consumer = yield* Stream.runForEach(output, () => Deferred.succeed(consumed, undefined).pipe(Effect.andThen(Effect.never))).pipe(Effect.forkChild)
    yield* Deferred.await(consumed)
    yield* Fiber.interrupt(consumer)
    expect(closed).toBe(1)
    const next = yield* Stream.runCollect(output.pipe(Stream.take(1)))
    expect(next[0]?.[0]).toBe(7)
    expect(closed).toBe(2)
    expect((yield* runtime.snapshot).handles).toBe(0)
  }))
})
