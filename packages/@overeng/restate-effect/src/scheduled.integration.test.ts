/**
 * Integration stress-tests for the self-reschedule surface (#4, decision 0012)
 * against a real native `restate-server` via the `./testing` harness:
 *
 *  - `RestateScheduled.make` (`Restate.pollLoop`) — the narrow durable
 *    recurring-loop primitive: basic recurrence as a chain of BOUNDED self-sends
 *    (journal does not grow with cycle count), `maxIterations` / data-driven stop,
 *    external stop→restart, generation-token idempotency (a duplicate `start`
 *    never produces overlapping chains), and the `skipToNext` / `stopLoop` error
 *    policies.
 *  - `Restate.reschedule` — the building block, driving the hand-rolled
 *    `RawWatcherObj` from the example.
 *
 * These productize the spike stress runs (`tmp/restate-spike-reschedule-{a,b}`).
 * Waits POLL the observable status/State (durable timer actually fired) rather
 * than fixed sleeps. Gracefully skips without a native `restate-server`.
 */
import { Clock, Context, Effect, Exit, Layer, Schema, Scope } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { NotionWatcher, RawWatcherObj, RawWatcherLive } from '../examples/12-self-reschedule.ts'
import { Restate, RestateObject, RestateScheduled, State } from './mod.ts'
import { RestateTestHarness, type RestateTestHarnessService, serverAvailable } from './testing.ts'

/* ── test watchers (distinct names so they coexist on one deployment) ─────── */

const CounterState = { n: Schema.Number } as const
const C = State.for(CounterState)

/* A read-only probe contract over the DOMAIN state. A scheduled watcher's domain
 * cursor lives in the SAME Object state map as the control plane, but under a
 * different `State.for` block; the primitive's contract only declares the control
 * plane. This same-named contract lets `harness.stateOf` read the domain `n` key
 * to assert exactly-once (cursor == iteration). */
const DomainProbe = (name: string) =>
  RestateObject.contract(name, {
    state: CounterState,
    handlers: { noop: { input: Schema.Void, success: Schema.Void, shared: true } },
  })
const BasicDomain = DomainProbe('sched-basic')

/* A plain recurring watcher: each cycle bumps a journaled counter. */
const Basic = RestateScheduled.make<typeof CounterState>({
  name: 'sched-basic',
  domainState: CounterState,
  schedule: RestateScheduled.Schedule.fixedDelay(60),
  cycle: ({ key }) =>
    Effect.gen(function* () {
      const n = (yield* C.get('n')) ?? 0
      yield* Restate.run(
        `work(${key}@${n})`,
        Effect.sync(() => n),
        { maxRetryAttempts: 1 },
      )
      yield* C.set('n', n + 1)
      return { stop: false }
    }),
})

/* maxIterations: exactly N cycles, then status `completed`. */
const Bounded = RestateScheduled.make<typeof CounterState>({
  name: 'sched-bounded',
  domainState: CounterState,
  schedule: RestateScheduled.Schedule.fixedDelay(40),
  maxIterations: 3,
  cycle: () =>
    Effect.gen(function* () {
      const n = (yield* C.get('n')) ?? 0
      yield* C.set('n', n + 1)
      return { stop: false }
    }),
})

/* Data-driven stop: the cycle returns `{ stop: true }` at iteration 2. */
const DataStop = RestateScheduled.make<typeof CounterState>({
  name: 'sched-data-stop',
  domainState: CounterState,
  schedule: RestateScheduled.Schedule.fixedDelay(40),
  cycle: ({ iteration }) => Effect.succeed(iteration >= 2 ? { stop: true } : { stop: false }),
})

/* skipToNext (default): the cycle's bounded `Restate.run` throws on iteration 1.
 * The give-up surfaces as a `RestateError` DEFECT (clean `E`), which the policy
 * catches and swallows; the loop keeps advancing past it. */
const Skip = RestateScheduled.make<typeof CounterState>({
  name: 'sched-skip',
  domainState: CounterState,
  schedule: RestateScheduled.Schedule.fixedDelay(40),
  onCycleError: RestateScheduled.OnCycleError.skipToNext(),
  cycle: ({ iteration }) =>
    Effect.gen(function* () {
      yield* Restate.run(
        `skip-poll@${iteration}`,
        Effect.sync(() => {
          if (iteration === 1) throw new Error('transient blip at iteration 1')
          return 0
        }),
        { maxRetryAttempts: 1 },
      )
      return { stop: false }
    }),
})

/* stopLoop: the first failing cycle stops the whole loop (status `failed`). */
const StopOnError = RestateScheduled.make<typeof CounterState>({
  name: 'sched-stop',
  domainState: CounterState,
  schedule: RestateScheduled.Schedule.fixedDelay(40),
  onCycleError: RestateScheduled.OnCycleError.stopLoop(),
  cycle: ({ iteration }) =>
    Effect.gen(function* () {
      yield* Restate.run(
        `stop-poll@${iteration}`,
        Effect.sync(() => {
          if (iteration === 2) throw new Error('fatal at iteration 2')
          return 0
        }),
        { maxRetryAttempts: 1 },
      )
      return { stop: false }
    }),
})

const services = [
  Basic.implementation,
  Bounded.implementation,
  DataStop.implementation,
  Skip.implementation,
  StopOnError.implementation,
  NotionWatcher.implementation,
  RawWatcherLive,
]

const HarnessLayer = RestateTestHarness.layer({ services, appLayer: Layer.empty })

/* ── shared harness (one native server on a manually-held scope) ──────────── */

let harness: RestateTestHarnessService
let scope: Scope.CloseableScope

beforeAll(async () => {
  if (!serverAvailable) return
  scope = await Effect.runPromise(Scope.make())
  harness = await Effect.runPromise(
    Layer.buildWithScope(HarnessLayer, scope).pipe(
      Effect.map((ctx) => Context.get(ctx, RestateTestHarness)),
    ),
  )
}, 90_000)

afterAll(async () => {
  if (scope !== undefined) await Effect.runPromise(Scope.close(scope, Exit.void))
}, 90_000)

/* ── helpers ──────────────────────────────────────────────────────────────── */

const live = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(eff as Effect.Effect<A, never, never>)

const liveSleep = (ms: number): Promise<void> =>
  live(Effect.sleep(ms).pipe(Effect.withClock(Clock.make())))

type Status = { readonly status: string; readonly iteration: number; readonly lastError?: string }

const statusOf = (scheduled: { readonly contract: any }, key: string): Promise<Status> =>
  live(harness.ingress.objectCall(scheduled.contract, key, 'status', undefined)) as Promise<Status>

const start = (scheduled: { readonly contract: any }, key: string): Promise<unknown> =>
  live(harness.ingress.objectCall(scheduled.contract, key, 'start', undefined))
const stop = (scheduled: { readonly contract: any }, key: string): Promise<unknown> =>
  live(harness.ingress.objectCall(scheduled.contract, key, 'stop', undefined))

const waitUntil = async (
  scheduled: { readonly contract: any },
  key: string,
  predicate: (s: Status) => boolean,
  timeoutMs = 12_000,
): Promise<Status> => {
  const deadline = Date.now() + timeoutMs
  let last = await statusOf(scheduled, key)
  while (!predicate(last) && Date.now() < deadline) {
    await liveSleep(60)
    last = await statusOf(scheduled, key)
  }
  return last
}

/* ════════════════════════════════════════════════════════════════════════ */

describe.skipIf(!serverAvailable)('self-reschedule (pollLoop + reschedule)', () => {
  it('basic recurrence: a chain of bounded self-sends advances; stop halts it', async () => {
    const key = 'basic-1'
    await start(Basic, key)
    const s = await waitUntil(Basic, key, (st) => st.iteration >= 4)
    expect(s.iteration).toBeGreaterThanOrEqual(4)
    expect(s.status).toBe('running')
    /* Exactly-once: the journaled counter equals the iteration count (no cycle ran
     * twice or was skipped — proven against the durable counter in State). */
    expect((await live(harness.stateOf(BasicDomain, key).get('n'))) ?? 0).toBe(s.iteration)
    await stop(Basic, key)
    const stopped = await waitUntil(Basic, key, (st) => st.status === 'stopped')
    expect(stopped.status).toBe('stopped')
    /* After stop the chain is dead: iteration stabilizes. */
    const a = stopped.iteration
    await liveSleep(400)
    expect((await statusOf(Basic, key)).iteration).toBe(a)
  }, 40_000)

  it('maxIterations: runs exactly N cycles, then completed', async () => {
    const key = 'bounded-1'
    await start(Bounded, key)
    const s = await waitUntil(Bounded, key, (st) => st.status === 'completed')
    expect(s.status).toBe('completed')
    expect(s.iteration).toBe(3)
  }, 40_000)

  it('data-driven stop: cycle returns { stop: true } → completed', async () => {
    const key = 'data-1'
    await start(DataStop, key)
    const s = await waitUntil(DataStop, key, (st) => st.status === 'completed')
    expect(s.status).toBe('completed')
    /* iterations 0,1 continue; iteration 2 returns stop:true → 3 cycles attempted. */
    expect(s.iteration).toBe(3)
  }, 40_000)

  it('stop then restart resumes the chain (generation re-arm)', async () => {
    const key = 'restart-1'
    await start(Basic, key)
    await waitUntil(Basic, key, (st) => st.iteration >= 2)
    await stop(Basic, key)
    const stopped = await waitUntil(Basic, key, (st) => st.status === 'stopped')
    expect(stopped.status).toBe('stopped')
    /* Restart: start resets the counter to 0 and re-arms under a NEW generation —
     * the stale pre-stop re-arm (old generation) no-ops when it lands. */
    await start(Basic, key)
    const resumed = await waitUntil(
      Basic,
      key,
      (st) => st.status === 'running' && st.iteration >= 2,
    )
    expect(resumed.status).toBe('running')
    expect(resumed.iteration).toBeGreaterThanOrEqual(2)
    await stop(Basic, key)
  }, 40_000)

  it('generation idempotency: a duplicate start never overlaps the chain', async () => {
    const key = 'dup-1'
    const readN = (): Promise<number> =>
      live(harness.stateOf(BasicDomain, key).get('n')).then((v) => v ?? 0)
    await start(Basic, key)
    await waitUntil(Basic, key, (st) => st.iteration >= 2)
    /* A duplicate start bumps the generation and re-arms; the per-key write lock +
     * the generation guard mean the two chains never run concurrently. `start`
     * re-bases the control-plane `iteration` to 0 (the domain cursor `n` keeps
     * climbing — the user owns it), so the overlap proof is that AFTER the
     * duplicate, the domain `n` advances by EXACTLY the same amount as the
     * control-plane `iteration` (one cycle = one n-bump = one iteration). An
     * overlapping stale chain would bump `n` faster than `iteration`. */
    await start(Basic, key)
    const afterDup = await waitUntil(Basic, key, (st) => st.iteration >= 1)
    const nAfterDup = await readN()
    const later = await waitUntil(Basic, key, (st) => st.iteration >= afterDup.iteration + 3)
    const nLater = await readN()
    await stop(Basic, key)
    /* Single-chain rate: the per-cycle n-delta tracks the iteration-delta within a
     * 1-cycle sampling skew (the two endpoint reads aren't perfectly simultaneous).
     * An overlapping stale chain would roughly DOUBLE the n-rate, far exceeding 1. */
    const nDelta = nLater - nAfterDup
    const iterDelta = later.iteration - afterDup.iteration
    expect(iterDelta).toBeGreaterThanOrEqual(3)
    expect(Math.abs(nDelta - iterDelta)).toBeLessThanOrEqual(1)
  }, 40_000)

  it('skipToNext: a failing cycle is swallowed and the loop continues', async () => {
    const key = 'skip-1'
    await start(Skip, key)
    /* The loop must get PAST iteration 1 (which fails) and keep climbing. */
    const s = await waitUntil(Skip, key, (st) => st.iteration >= 4)
    expect(s.iteration).toBeGreaterThanOrEqual(4)
    expect(s.status).toBe('running')
    await stop(Skip, key)
  }, 40_000)

  it('stopLoop: a failing cycle stops the whole loop (status failed)', async () => {
    const key = 'stop-1'
    await start(StopOnError, key)
    const s = await waitUntil(StopOnError, key, (st) => st.status === 'failed')
    expect(s.status).toBe('failed')
    expect(s.lastError).toContain('fatal at iteration 2')
    /* It stopped AT iteration 2 (cycles 0,1 advanced, cycle 2 failed). */
    expect(s.iteration).toBe(3)
  }, 40_000)

  it('example NotionWatcher: the README headline polls to a data-driven stop', async () => {
    /* Drives the EXACT exported example so the README snippet is CI-verified. The
     * default stub source reports `done` at cursor >= 4 → the loop ends cleanly. */
    const key = 'notion-1'
    await live(harness.ingress.objectCall(NotionWatcher.contract, key, 'start', undefined))
    const s = await waitUntil(NotionWatcher, key, (st) => st.status === 'completed')
    expect(s.status).toBe('completed')
    expect(s.iteration).toBeGreaterThanOrEqual(5)
  }, 40_000)

  it('reschedule building block: the hand-rolled RawWatcher loops and stops', async () => {
    const key = 'raw-1'
    const read = (): Promise<{ running: boolean; cursor: number }> =>
      live(harness.ingress.objectCall(RawWatcherObj, key, 'read', undefined)) as Promise<{
        running: boolean
        cursor: number
      }>
    await live(harness.ingress.objectCall(RawWatcherObj, key, 'start', undefined))
    const deadline = Date.now() + 12_000
    let snap = await read()
    while (snap.cursor < 4 && Date.now() < deadline) {
      await liveSleep(80)
      snap = await read()
    }
    expect(snap.cursor).toBeGreaterThanOrEqual(4)
    expect(snap.running).toBe(true)
    await live(harness.ingress.objectCall(RawWatcherObj, key, 'stop', undefined))
    await liveSleep(500)
    const after = await read()
    expect(after.running).toBe(false)
    /* After stop the chain is dead: cursor stabilizes. */
    const c = after.cursor
    await liveSleep(400)
    expect((await read()).cursor).toBe(c)
  }, 40_000)
})
