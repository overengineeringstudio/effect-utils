/**
 * `@overeng/restate-effect/testing` — a FAITHFUL in-memory `RestateContext` for
 * SERVER-FREE unit tests of handler LOGIC and State transitions (decision 0013,
 * spec §11.5). It is a real in-memory implementation of the durable `ctx`, NOT a
 * stub: State is a real `Map`, `ctx.run(name, …)` executes once and MEMOIZES (so a
 * re-`run` of the same name returns the journaled value), `ctx.date`/`ctx.rand`
 * are deterministic (seeded), and `ctx.sleep` is a controllable no-op. The same
 * `Restate.run` / `Restate.sleep` / `State.*` / `Restate.key` / awakeable
 * combinators run verbatim against it — no special-casing — because it implements
 * the same `restate.ObjectContext` surface the real boundary provides.
 *
 * ```ts
 * const state = new Map<string, unknown>()
 * const out = yield* myHandler(input).pipe(
 *   Effect.provide(makeTestContextLayer({ state, key: 'cart-1' })),
 * )
 * // assert on `out` AND on the resulting `state` Map (a State transition)
 * ```
 *
 * What it FAITHFULLY models (fast logic tests): handler control flow, typed State
 * read-modify-write (round-tripped through the SAME serde the real handler uses),
 * `Restate.run` journaled-once memoization, deterministic time/random, the
 * capability gating (the right markers are provided per `handlerKind`), and
 * in-handler awakeable resolve/await.
 *
 * What it explicitly does NOT model — use `RestateTestHarness` (a real
 * `restate-server`) for any of these:
 *
 * - DURABILITY / REPLAY: there is no journal, no suspension, no re-attempt. A
 *   crash mid-handler is just a thrown error here; it does not replay.
 * - SINGLE-WRITER / per-key concurrency: no write lock, no exclusive/shared
 *   serialization, no cross-invocation ordering.
 * - Cross-handler / cross-invocation effects: `Restate.call`/`send`,
 *   `Restate.reschedule`, delayed self-sends, durable promises resolved by ANOTHER
 *   invocation, and `pollLoop` recurrence — none of these route anywhere (there is
 *   no server to deliver to). Test those against the harness.
 * - JOURNAL SHAPE / determinism-divergence hunting (`alwaysReplay`): there is no
 *   journal to diverge.
 *
 * This is the `unit` row of the test-layering table (spec §11.3): server-free
 * handler-logic tests. The `contract` and `integration` rows still need the real
 * harness.
 */
import * as restate from '@restatedev/restate-sdk'
import { Context, Layer } from 'effect'

import {
  DurablePromise,
  ObjectKey,
  RestateContext,
  StateRead,
  StateWrite,
} from '../authoring/RestateContext.ts'

/* The capability markers gate type-legality only; the provided value is a phantom
 * empty marker (same as the real boundary in `Endpoint.ts`). */
const emptyMarker = {} as never

/**
 * Which handler kind to emulate — selects WHICH capability markers the layer
 * provides, exactly mirroring the real boundary (`Endpoint.materialize*`):
 *
 * - `service` — `RestateContext` only (no State, no key).
 * - `objectShared` — `RestateContext + ObjectKey + StateRead` (read-only State).
 * - `objectExclusive` — adds `StateWrite` (read-modify-write State).
 * - `workflowShared` — `objectShared` + `DurablePromise` (read State + promises).
 * - `workflowRun` — the full set (`StateWrite` + `DurablePromise`).
 *
 * Pick the kind matching the handler under test so the SAME capability gating
 * applies (a `State.set` in an `objectShared` handler is still a compile error).
 */
export type TestHandlerKind =
  | 'service'
  | 'objectShared'
  | 'objectExclusive'
  | 'workflowShared'
  | 'workflowRun'

/** Options for the in-memory test context. */
export interface TestContextOptions {
  /**
   * The backing State `Map` (key → the SERDE-ENCODED value, exactly as the real
   * `ctx.set` stores it). Seed it before the run to set up pre-conditions; read it
   * after to assert State transitions. Defaults to a fresh empty `Map`.
   */
  readonly state?: Map<string, unknown>
  /** The Object / Workflow invocation key (`Restate.key` / capability `ObjectKey`). Defaults to `'test-key'`. */
  readonly key?: string
  /** Which handler kind to emulate (selects the provided capability markers). Defaults to `'objectExclusive'`. */
  readonly handlerKind?: TestHandlerKind
  /**
   * The base wall-clock millis for the deterministic `ctx.date` (and the journaled
   * Clock seed). Defaults to a fixed epoch so a test is reproducible. `ctx.date`
   * advances by `clockStepMillis` per read.
   */
  readonly nowMillis?: number
  /** How many millis `ctx.date.now()` advances per read (deterministic monotonic clock). Defaults to `0` (frozen). */
  readonly clockStepMillis?: number
  /** Seed for the deterministic PRNG behind `ctx.rand`. Defaults to `42`. */
  readonly randomSeed?: number
  /**
   * Handler for `ctx.sleep(millis)`. Defaults to a no-op (resolves immediately) so
   * a durable timer does not actually wait in a unit test. Provide a custom impl to
   * observe / control sleeps (e.g. record the requested durations).
   */
  readonly onSleep?: (millis: number, name?: string) => Promise<void>
  /**
   * A SHARED awakeable registry (id → resolve/reject hooks). Pass one to bridge a
   * `ctx.awakeable()` created INSIDE a handler to a resolve issued OUTSIDE it (e.g.
   * `RestateTestEnv.mock`'s env-scoped `resolveAwakeable` completing a suspended
   * handler — honest, since an awakeable is just a promise). Defaults to a fresh
   * per-context registry (the awakeable resolves only from within the same handler).
   */
  readonly awakeables?: AwakeableRegistry
}

/** The completion hooks for one pending awakeable id (used by the shared registry). */
export interface AwakeableCompletion {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
}

/**
 * A shared awakeable registry: id → completion hooks, plus a monotonic counter for
 * fresh ids. Threaded across {@link makeTestContext} calls so a resolve from
 * "outside" a handler (env-scoped, in `RestateTestEnv.mock`) completes a promise an
 * INSIDE-handler `ctx.awakeable()` is suspended on.
 */
export interface AwakeableRegistry {
  readonly pending: Map<string, AwakeableCompletion>
  next: number
}

/** Build a fresh shared awakeable registry (for `RestateTestEnv.mock`'s env scope). */
export const makeAwakeableRegistry = (): AwakeableRegistry => ({
  pending: new Map(),
  next: 0,
})

/* A small deterministic PRNG (mulberry32) — seeded, uniform `[0, 1)`, replayable.
 * Mirrors `ctx.rand.random()`'s contract (deterministic, seeded, not crypto). */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* Format a uniform float as a v4-shaped uuid (deterministic; mirrors `rand.uuidv4`). */
const randomUuid = (next: () => number): string => {
  const hex = (n: number): string =>
    Math.floor(next() * 16 ** n)
      .toString(16)
      .padStart(n, '0')
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${((Math.floor(next() * 4) + 8).toString(16) + hex(3)).slice(0, 4)}-${hex(8)}${hex(4)}`
}

/**
 * The faithful in-memory `restate.ObjectContext` (also valid as a
 * `WorkflowContext` for read State + in-memory durable promises). Backs the
 * combinators verbatim:
 *
 * - State (`get`/`set`/`clear`/`clearAll`/`stateKeys`) over a real `Map`.
 * - `run(name, action)` executes the action ONCE and MEMOIZES the result by
 *   `name` (journaled-once: a re-`run` of the same name returns the stored value,
 *   never re-executes — the in-memory analogue of replay).
 * - `sleep` → the controllable `onSleep` (no-op by default).
 * - `date` → a deterministic monotonic clock; `rand` → a seeded PRNG.
 * - `awakeable` + `resolveAwakeable`/`rejectAwakeable` over an in-memory registry
 *   (a same-handler resolve completes the awaited promise).
 *
 * Returned alongside the `state` Map (so a caller that did not pass one can read
 * it back) and the awakeable registry (rarely needed directly).
 */
export interface TestContextHandle {
  /** The fake context value (provide via `RestateContext`). */
  readonly context: restate.ObjectContext
  /** The backing State map (key → serde-encoded value). */
  readonly state: Map<string, unknown>
  /** The `run`-memoization journal (name → the once-executed result). */
  readonly journal: Map<string, unknown>
  /** The awakeable registry backing this context (shared when one was passed in). */
  readonly awakeables: AwakeableRegistry
}

/* eslint-disable @typescript-eslint/no-explicit-any -- emulating the loosely-typed raw SDK `ctx` surface */

/**
 * Build the faithful in-memory `restate.ObjectContext`. See {@link TestContextHandle}
 * for the modeled surface. Most callers want {@link makeTestContextLayer}, which
 * wraps this in a `Layer` providing `RestateContext` + the capability markers.
 */
export const makeTestContext = (options: TestContextOptions = {}): TestContextHandle => {
  const state = options.state ?? new Map<string, unknown>()
  const journal = new Map<string, unknown>()
  const key = options.key ?? 'test-key'
  const baseMillis = options.nowMillis ?? 1_700_000_000_000
  const step = options.clockStepMillis ?? 0
  const nextRandom = mulberry32(options.randomSeed ?? 42)
  const onSleep = options.onSleep ?? (() => Promise.resolve())

  /* Deterministic monotonic clock: a read returns the base + N steps. */
  let clockReads = 0
  const nowMillis = (): number => {
    const value = baseMillis + clockReads * step
    clockReads += 1
    return value
  }

  /* In-memory awakeable registry: a token's promise is completed by a
   * same-handler resolve/reject — OR, when a SHARED registry is passed (the
   * `RestateTestEnv.mock` env scope), by a resolve issued from OUTSIDE the handler.
   * The completion bridges a manual promise either way. */
  const registry = options.awakeables ?? makeAwakeableRegistry()
  const awakeables = registry.pending

  const rand: restate.Rand = {
    random: () => nextRandom(),
    uuidv4: () => randomUuid(nextRandom),
  }

  const date: restate.ContextDate = {
    now: () => Promise.resolve(nowMillis()),
    toJSON: () => Promise.resolve(new Date(nowMillis()).toJSON()),
  }

  /* `ctx.run`: execute the action ONCE, memoize by name (journaled-once). A
   * re-`run` of the same name returns the stored value without re-executing — the
   * in-memory analogue of Restate replaying a journaled step. */
  const run = (...args: any[]): restate.RestatePromise<any> => {
    const [name, action] = typeof args[0] === 'string' ? [args[0], args[1]] : [undefined, args[0]]
    const journalKey = typeof name === 'string' ? name : `run#${journal.size}`
    if (typeof name === 'string' && journal.has(journalKey) === true) {
      return restate.RestatePromise.resolve(journal.get(journalKey))
    }
    return restate.RestatePromise.resolve(
      Promise.resolve(action()).then((value: unknown) => {
        if (typeof name === 'string') journal.set(journalKey, value)
        return value
      }),
    )
  }

  const sleep = (duration: number, name?: string): restate.RestatePromise<void> =>
    restate.RestatePromise.resolve(onSleep(typeof duration === 'number' ? duration : 0, name))

  const awakeable = <T>(): { id: string; promise: restate.RestatePromise<T> } => {
    registry.next += 1
    const id = `test-awakeable-${registry.next}`
    const promise = new Promise<T>((resolve, reject) => {
      awakeables.set(id, { resolve: resolve as (v: unknown) => void, reject })
    })
    return { id, promise: restate.RestatePromise.resolve(promise) }
  }

  const resolveAwakeable = <T>(id: string, payload?: T): void => {
    awakeables.get(id)?.resolve(payload)
  }

  const rejectAwakeable = (id: string, reason: string): void => {
    awakeables.get(id)?.reject(new restate.TerminalError(reason))
  }

  /* The `request()` handle — `attemptCompletedSignal` never aborts (no
   * cancellation/suspension in-memory), so `withAttemptInterruption` is inert. */
  const abortController = new AbortController()
  const request = (): restate.Request =>
    ({
      target: { service: 'test', handler: 'test', key, toString: () => `test/${key}` },
      id: 'inv_test' as unknown as restate.InvocationId,
      headers: new Map(),
      attemptHeaders: new Map(),
      body: new Uint8Array(),
      extraArgs: [],
      attemptCompletedSignal: abortController.signal,
    }) as restate.Request

  const context = {
    key,
    rand,
    date,
    console,
    run,
    sleep,
    awakeable,
    resolveAwakeable,
    rejectAwakeable,
    request,
    /* State KV (real Map). `get` returns the stored value or `null` (the SDK's
     * "unset" sentinel the combinator maps to `undefined`). */
    get: (name: string) => Promise.resolve(state.has(name) === true ? state.get(name) : null),
    set: (name: string, value: unknown) => {
      state.set(name, value)
    },
    clear: (name: string) => {
      state.delete(name)
    },
    clearAll: () => {
      state.clear()
    },
    stateKeys: () => Promise.resolve([...state.keys()]),
  } as unknown as restate.ObjectContext

  return { context, state, journal, awakeables: registry }
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/** The full Context value provided by the in-memory test layer (markers union). */
type TestContextServices = RestateContext | ObjectKey | StateRead | StateWrite | DurablePromise

/* Build the full Context value (RestateContext + the kind's markers) eagerly, the
 * SAME subset the real boundary provides per handler kind — so a `State.set` in an
 * `objectShared`/`workflowShared` test still fails to compile (no `StateWrite`).
 * The markers are phantom empty values; only their presence gates type-legality. */
const buildContext = (
  context: restate.ObjectContext,
  kind: TestHandlerKind,
  key: string,
): Context.Context<TestContextServices> => {
  let ctx = Context.make(RestateContext, context) as Context.Context<TestContextServices>
  if (kind !== 'service') {
    ctx = Context.add(ctx, ObjectKey, { key })
    ctx = Context.add(ctx, StateRead, emptyMarker)
  }
  if (kind === 'objectExclusive' || kind === 'workflowRun') {
    ctx = Context.add(ctx, StateWrite, emptyMarker)
  }
  if (kind === 'workflowShared' || kind === 'workflowRun') {
    ctx = Context.add(ctx, DurablePromise, emptyMarker)
  }
  return ctx
}

/**
 * A `Layer` providing the faithful in-memory `RestateContext` + the capability
 * markers for the chosen `handlerKind` — the server-free analogue of what
 * `Endpoint.materialize*` provides per call. Provide it over a handler effect to
 * unit-test its logic + State transitions WITHOUT a server:
 *
 * ```ts
 * const state = new Map<string, unknown>()
 * const next = yield* bumpHandler(undefined).pipe(
 *   Effect.provide(makeTestContextLayer({ state, key: 'cart-1' })),
 * )
 * expect(next).toBe(1)
 * ```
 *
 * It does NOT provide the journaled Clock/Random determinism Layer (the in-memory
 * `ctx.date`/`ctx.rand` are themselves deterministic, and a bare `Effect.sleep`
 * stays the real in-process timer in a unit test). It provides exactly the
 * capability markers for `handlerKind` (default `objectExclusive`), so the same
 * capability gating applies as in a real handler.
 *
 * NOT a substitute for `RestateTestHarness` — see the module docs for what this
 * deliberately does not model (durability/replay/single-writer/cross-invocation).
 */
export const makeTestContextLayer = (
  options: TestContextOptions = {},
): Layer.Layer<TestContextServices> =>
  Layer.succeedContext(
    buildContext(
      makeTestContext(options).context,
      options.handlerKind ?? 'objectExclusive',
      options.key ?? 'test-key',
    ),
  )
