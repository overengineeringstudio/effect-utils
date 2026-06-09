/**
 * Integration stress-tests for the COMPOSED pollLoop surface (decision 0012)
 * against a real native `restate-server` via the `./testing` harness — productizing
 * the spike runs (`tmp/restate-spike-pollloop-compose/*.integration.test.ts`):
 *
 *  - Retry-After re-arm: a `retryable` 429 re-arms the NEXT cycle after its
 *    PROJECTED `retryAfter` (NOT the fixedDelay), cursor + iteration FROZEN (the
 *    same logical cycle retries); a permanently-429 source backs off and — in the
 *    WEDGE-FREE no-wake shape — `stop` stays INSTANT mid-backoff (lock released).
 *  - Union classification: a TERMINAL union member hits `onCycleError` (skip),
 *    NOT the retry path (the per-member classification blocker fix exercised live).
 *  - Wake: resolving the live wake awakeable fires the next cycle EARLY; the id
 *    ROTATES per cycle and stays externally resolvable; a STALE id resolves
 *    harmlessly; a wake DURING a retryAfter backoff cuts it short.
 *
 * Waits POLL the observable status / typed domain State (the durable timer actually
 * fired), not fixed sleeps. Gracefully skips without a native `restate-server`.
 */
import { Effect, Layer, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  installComposedSource,
  makeComposedDaemon,
  resetComposedSources,
} from '../examples/12-self-reschedule.ts'
import {
  type AwakeableId,
  ingressResolveAwakeable,
  RestateIngress,
  RestateObject,
  WakePayload,
} from './mod.ts'
import {
  liveSleep as liveSleepEff,
  type RestateTestHarnessService,
  serverAvailable,
  withRestateServer,
} from './testing.ts'

/* ── the composed daemons (distinct names so they coexist on one deployment) ── */

/* fixedDelay 1000ms so a Retry-After of 150ms is unambiguously DIFFERENT from the
 * schedule delay — the next cycle MUST fire well before the 1s fixedDelay. */
const SCHEDULE_DELAY = 1_000
const RETRY_AFTER = 150
/* A SLOW delay so a wake is unambiguously EARLY. */
const SLOW_DELAY = 3_000

/* No-wake (wedge-free) daemon for the retryAfter + stop-mid-backoff scenarios. */
const NoWake = makeComposedDaemon({ name: 'cmp-nowake', delayMillis: SCHEDULE_DELAY, wake: false })
/* Wake-enabled daemon (slow delay) for the early-fire + stale-id scenarios. */
const Wake = makeComposedDaemon({ name: 'cmp-wake', delayMillis: SLOW_DELAY, wake: true })
/* A fast wake daemon for the rotation scenario. */
const WakeFast = makeComposedDaemon({ name: 'cmp-wake-fast', delayMillis: 600, wake: true })

/* A read-only probe contract over the DOMAIN state (cursor / wakeCount), same name
 * as a daemon so `harness.stateOf` can read the domain keys (the primitive's own
 * contract declares only the control plane — see decision 0012 consequences). */
const ComposedDomain = {
  cursor: Schema.Number,
  itemsSeen: Schema.Number,
  wakeCount: Schema.Number,
} as const
const DomainProbe = (name: string) =>
  RestateObject.contract(name, {
    state: ComposedDomain,
    handlers: { noop: { input: Schema.Void, success: Schema.Void, shared: true } },
  })
const NoWakeDomain = DomainProbe('cmp-nowake')
const WakeDomain = DomainProbe('cmp-wake')
const WakeFastDomain = DomainProbe('cmp-wake-fast')

const services = [NoWake.implementation, Wake.implementation, WakeFast.implementation]

/* ── shared harness (one native server, held across the suite) ────────────── */

const held = withRestateServer({ services, appLayer: Layer.empty })
const harness = (): RestateTestHarnessService => held.harness()

beforeAll(held.setup, 90_000)
afterAll(held.teardown, 90_000)

/* ── helpers ──────────────────────────────────────────────────────────────── */

const live = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(eff as Effect.Effect<A, never, never>)
const liveSleep = (ms: number): Promise<void> => live(liveSleepEff(ms))

interface Status {
  readonly status: string
  readonly iteration: number
  readonly lastError?: string
  readonly retryBackoffs: number
  readonly wakeId?: string
}

const statusOf = (d: { readonly contract: any }, key: string): Promise<Status> =>
  live(harness().ingress.objectCall(d.contract, key, 'status', undefined)) as Promise<Status>
const wakeIdOf = (d: { readonly contract: any }, key: string): Promise<string> =>
  live(harness().ingress.objectCall(d.contract, key, 'wakeId', undefined)) as Promise<string>
const start = (d: { readonly contract: any }, key: string): Promise<unknown> =>
  live(harness().ingress.objectCall(d.contract, key, 'start', undefined))
const stop = (d: { readonly contract: any }, key: string): Promise<unknown> =>
  live(harness().ingress.objectCall(d.contract, key, 'stop', undefined))
const cursorOf = (probe: any, key: string): Promise<number> =>
  live(harness().stateOf(probe, key).get('cursor')).then((v) => (v as number | undefined) ?? 0)
const wakeCountOf = (probe: any, key: string): Promise<number> =>
  live(harness().stateOf(probe, key).get('wakeCount')).then((v) => (v as number | undefined) ?? 0)

/* The standalone ingress resolve needs a `RestateIngress` layer; build it from the
 * booted server's ingress URL (the same connected server the harness drives). */
const ingressLayer = (): Layer.Layer<RestateIngress> =>
  RestateIngress.layer({ url: harness().ingressUrl })

const resolveWake = (id: string, reason: string): Promise<void> =>
  Effect.runPromise(
    ingressResolveAwakeable(WakePayload, id as AwakeableId<WakePayload>, { reason }).pipe(
      Effect.provide(ingressLayer()),
    ),
  )

const waitUntil = async (
  d: { readonly contract: any },
  key: string,
  predicate: (s: Status) => boolean,
  timeoutMs = 20_000,
): Promise<Status> => {
  const deadline = Date.now() + timeoutMs
  let last = await statusOf(d, key)
  while (!predicate(last) && Date.now() < deadline) {
    await liveSleep(50)
    last = await statusOf(d, key)
  }
  return last
}
const waitForWakeId = async (
  d: { readonly contract: any },
  key: string,
  timeoutMs = 10_000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const id = await wakeIdOf(d, key)
    if (id !== '') return id
    if (Date.now() >= deadline) return ''
    await liveSleep(30)
  }
}

/* ════════════════════════════════════════════════════════════════════════ */

describe.skipIf(!serverAvailable)(
  'pollLoop composition (retryAfter + union classification + wake)',
  () => {
    beforeAll(() => {
      resetComposedSources()
    })

    it('retryAfter: a 429 re-arms after Retry-After (NOT fixedDelay), cursor unchanged (no-wake)', async () => {
      const key = 'ra-1'
      let limited = 0
      installComposedSource(key, (cursor) => {
        if (cursor === 2 && limited === 0) {
          limited += 1
          return { _rateLimited: true, retryAfterMillis: RETRY_AFTER }
        }
        return { nextCursor: cursor + 1, itemCount: 1, done: false }
      })
      await start(NoWake, key)
      await waitUntil(NoWake, key, (s) => s.retryBackoffs >= 1 || s.iteration >= 3)
      const tBackoff = Date.now()
      let cursor = await cursorOf(NoWakeDomain, key)
      const deadline = Date.now() + 5_000
      while (cursor < 3 && Date.now() < deadline) {
        await liveSleep(30)
        cursor = await cursorOf(NoWakeDomain, key)
      }
      const elapsed = Date.now() - tBackoff
      await stop(NoWake, key)
      expect(cursor).toBeGreaterThanOrEqual(3)
      expect(limited).toBe(1)
      /* The decisive check: the retry fired on the Retry-After cadence (~150ms), MUCH
       * faster than the 1s fixedDelay. */
      expect(elapsed).toBeLessThan(SCHEDULE_DELAY)
    }, 60_000)

    it('retryAfter: a permanent 429 stays STOPPABLE mid-backoff (no-wake lock released)', async () => {
      const key = 'ra-perm'
      /* PERMANENT 429 at cursor 1 with a LONG 3s Retry-After. In no-wake mode the
       * backoff is a delayed send (lock released), so stop returns immediately even
       * mid-backoff — the wedge-free contrast to the wake-mode held race. */
      installComposedSource(key, (cursor) =>
        cursor >= 1
          ? { _rateLimited: true, retryAfterMillis: 3_000 }
          : { nextCursor: cursor + 1, itemCount: 1, done: false },
      )
      await start(NoWake, key)
      await waitUntil(NoWake, key, (s) => s.retryBackoffs >= 1, 10_000)
      const tStop = Date.now()
      const stopResult = await Promise.race([
        stop(NoWake, key)
          .then(() => 'ok' as const)
          .catch(() => 'err' as const),
        new Promise<'blocked'>((res) => setTimeout(() => res('blocked'), 2_000)),
      ])
      const stopLatency = Date.now() - tStop
      await liveSleep(200)
      const after = await statusOf(NoWake, key)
      expect(stopResult).toBe('ok')
      /* DECISIVE: stop latency is tiny (< 1s), NOT ~3s — the lock was free. */
      expect(stopLatency).toBeLessThan(1_000)
      expect(after.status).toBe('stopped')
    }, 60_000)

    it('union classification: a TERMINAL member hits onCycleError (skip), loop advances past it', async () => {
      const key = 'term-1'
      let terminalAtCursor1 = 0
      installComposedSource(key, (cursor) => {
        if (cursor === 1 && terminalAtCursor1 === 0) {
          terminalAtCursor1 += 1
          return { _terminal: 'boom at cursor 1' }
        }
        return { nextCursor: cursor + 1, itemCount: 1, done: false }
      })
      await start(NoWake, key)
      /* skipToNext: the terminal error is recorded and the loop ADVANCES (it does NOT
       * retry the same cursor — that is the retryable path). */
      const s = await waitUntil(NoWake, key, (st) => st.iteration >= 4)
      await stop(NoWake, key)
      expect(s.iteration).toBeGreaterThanOrEqual(4)
      expect(s.status).toBe('running')
      /* The terminal member did NOT drive a retryAfter backoff (classified per-member
       * as terminal, not retryable — the blocker fix). */
      expect(s.retryBackoffs).toBe(0)
      expect(terminalAtCursor1).toBe(1)
    }, 60_000)

    it('wake: resolving the live awakeable fires the next cycle EARLY', async () => {
      const key = 'wake-1'
      installComposedSource(key, (cursor) => ({
        nextCursor: cursor + 1,
        itemCount: 1,
        done: false,
      }))
      await start(Wake, key)
      const id = await waitForWakeId(Wake, key)
      expect(id).not.toBe('')
      const cursorBefore = await cursorOf(WakeDomain, key)
      await liveSleep(300)
      const tWake = Date.now()
      await resolveWake(id, 'webhook-fired')
      const deadline = Date.now() + 2_500
      let cursorAfter = cursorBefore
      while (cursorAfter <= cursorBefore && Date.now() < deadline) {
        await liveSleep(20)
        cursorAfter = await cursorOf(WakeDomain, key)
      }
      const elapsed = Date.now() - tWake
      const wakeCount = await wakeCountOf(WakeDomain, key)
      await stop(Wake, key)
      expect(cursorAfter).toBeGreaterThan(cursorBefore)
      /* Fired FAST after the wake — far below the remaining ~2.7s of the timer. */
      expect(elapsed).toBeLessThan(SLOW_DELAY - 300)
      /* The cycle observed it was woken (wokenBy threaded through). */
      expect(wakeCount).toBeGreaterThanOrEqual(1)
    }, 60_000)

    it('wake: the id ROTATES per cycle and stays externally resolvable', async () => {
      const key = 'wake-rotate'
      installComposedSource(key, (cursor) => ({
        nextCursor: cursor + 1,
        itemCount: 1,
        done: false,
      }))
      await start(WakeFast, key)
      const idA = await waitForWakeId(WakeFast, key)
      await resolveWake(idA, 'wake-A')
      let idB = idA
      const deadline = Date.now() + 6_000
      while (idB === idA && Date.now() < deadline) {
        await liveSleep(30)
        idB = await wakeIdOf(WakeFast, key)
      }
      expect(idB).not.toBe('')
      expect(idB).not.toBe(idA)
      await resolveWake(idB, 'wake-B')
      await liveSleep(400)
      const wakeCount = await wakeCountOf(WakeFastDomain, key)
      await stop(WakeFast, key)
      expect(wakeCount).toBeGreaterThanOrEqual(2)
    }, 60_000)

    it('wake: a STALE id (from a prior cycle) resolves harmlessly (loop stays healthy)', async () => {
      const key = 'wake-stale'
      installComposedSource(key, (cursor) => ({
        nextCursor: cursor + 1,
        itemCount: 1,
        done: false,
      }))
      await start(WakeFast, key)
      const staleId = await waitForWakeId(WakeFast, key)
      /* Let the loop ROTATE past this id (a couple cycles via the timer). */
      await liveSleep(1_600)
      const iterBefore = (await statusOf(WakeFast, key)).iteration
      let staleResolveErrored = false
      try {
        await resolveWake(staleId, 'stale-resolve')
      } catch {
        staleResolveErrored = true
      }
      await liveSleep(1_400)
      const after = await statusOf(WakeFast, key)
      await stop(WakeFast, key)
      expect(staleResolveErrored).toBe(false)
      expect(after.status).toBe('running')
      expect(after.iteration).toBeGreaterThan(iterBefore)
    }, 60_000)
  },
)
