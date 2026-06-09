/**
 * Verifies `examples/14-http-error-classification.ts` end-to-end against a real
 * native `restate-server`: an `HttpClient` call classifying each response status
 * into the right channel, across BOTH handlers —
 *
 * - 2xx valid body → typed success;
 * - 400 / 403 / 404 → the matching TERMINAL domain error (no retry), decoded back
 *   into the tagged error on the caller side;
 * - a 200 with a malformed body → a TERMINAL `MalformedUpstream` (no retry);
 * - 429 / 5xx → a TRANSIENT retry: `fetch` rides Restate's durable STEP retry (the
 *   `run` re-fetches), `fetchRetryable` parks the invocation in `backing-off` via
 *   the `Restate.retryable` error. A 429-then-200 upstream eventually SUCCEEDS on
 *   both, proving the transient path RE-FETCHES (the upstream hit count climbs).
 *
 * The upstream is a tiny in-process Node HTTP server returning controlled statuses
 * per widget id; the handler's `HttpClient` comes from `FetchHttpClient.layer`
 * threaded in as the harness `appLayer`. Skips when no native server is available.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { FetchHttpClient } from '@effect/platform'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { afterAll, beforeAll, describe, expect } from 'vitest'

import {
  type BadRequest,
  type Forbidden,
  type MalformedUpstream,
  type NotFound,
  WidgetApi,
  WidgetApiLive,
} from '../../examples/14-http-error-classification.ts'
import { liveSleep, RestateTestHarness, serverAvailable } from '../testing/testing.ts'

/* Per-widget upstream hit counters — module-level so the in-process upstream and
 * the test share them across the native server's retries (the upstream runs here). */
const hits: Record<string, number> = {}
const bump = (id: string): number => {
  hits[id] = (hits[id] ?? 0) + 1
  return hits[id]!
}

/**
 * The controlled upstream. The widget id selects the response:
 * - `ok-*`        → 200 with a valid `Widget`
 * - `garbage-*`   → 200 with a body that does NOT match `Widget` (malformed)
 * - `bad-*`       → 400
 * - `forbidden-*` → 403
 * - `missing-*`   → 404
 * - `throttled-*` → 429 ALWAYS, with `Retry-After: 1`
 * - `flaky-*`     → 429 (Retry-After: 1) on the first two hits, then 200
 * - anything else → 503 ALWAYS
 */
const upstream: Server = createServer((req, res) => {
  const id = (req.url ?? '').replace('/widgets/', '')
  const n = bump(id)
  const send = (status: number, body: string, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(body)
  }
  if (id.startsWith('ok-')) return send(200, JSON.stringify({ id, name: `Widget ${id}` }))
  if (id.startsWith('garbage-')) return send(200, JSON.stringify({ nope: true }))
  if (id.startsWith('bad-')) return send(400, JSON.stringify({ error: 'bad request' }))
  if (id.startsWith('forbidden-')) return send(403, '{}')
  if (id.startsWith('missing-')) return send(404, '{}')
  if (id.startsWith('throttled-')) return send(429, '{}', { 'retry-after': '1' })
  if (id.startsWith('flaky-')) {
    return n <= 2
      ? send(429, '{}', { 'retry-after': '1' })
      : send(200, JSON.stringify({ id, name: `Widget ${id}` }))
  }
  return send(503, '{}')
})

let baseUrl = ''
beforeAll(
  () =>
    new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => {
        const { port } = upstream.address() as AddressInfo
        baseUrl = `http://127.0.0.1:${port}`
        resolve()
      })
    }),
)
afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())))

/* The handler needs an `HttpClient`; provide it via `FetchHttpClient.layer`. The
 * default policy is left ON so the transient (429/5xx) paths actually retry. */
const Harness = RestateTestHarness.layer({
  services: [WidgetApiLive],
  appLayer: FetchHttpClient.layer,
})

/** Wait until a counter climbs past one (a durable retry fired) within a window. */
const climbsPastOne = (read: () => number): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (let i = 0; i < 80; i++) {
      if (read() > 1) return true
      yield* liveSleep(250)
    }
    return read() > 1
  })

describe.skipIf(!serverAvailable)('14-http-error-classification (verified end-to-end)', () => {
  it.layer(Harness, { timeout: 120_000 })('classifies each HTTP outcome', (it) => {
    /* ── Deterministic single-shot outcomes (both share `fetch`). ───────────── */

    it.effect('2xx valid body → typed success', () =>
      Effect.gen(function* () {
        const h = yield* RestateTestHarness
        const ok = yield* h.ingress.callTyped(WidgetApi, 'fetch', { baseUrl, widgetId: 'ok-1' })
        expect(ok).toEqual({ id: 'ok-1', name: 'Widget ok-1' })
      }),
    )

    it.effect('400 → terminal BadRequest (decoded back into the tagged error)', () =>
      Effect.gen(function* () {
        const h = yield* RestateTestHarness
        const recovered = yield* h.ingress
          .callTyped(WidgetApi, 'fetch', { baseUrl, widgetId: 'bad-1' })
          .pipe(Effect.catchTag('BadRequest', (e: BadRequest) => Effect.succeed(e._tag)))
        expect(recovered).toBe('BadRequest')
      }),
    )

    it.effect('403 → terminal Forbidden', () =>
      Effect.gen(function* () {
        const h = yield* RestateTestHarness
        const recovered = yield* h.ingress
          .callTyped(WidgetApi, 'fetch', { baseUrl, widgetId: 'forbidden-1' })
          .pipe(Effect.catchTag('Forbidden', (e: Forbidden) => Effect.succeed(e._tag)))
        expect(recovered).toBe('Forbidden')
      }),
    )

    it.effect('404 → terminal NotFound carrying the widget id', () =>
      Effect.gen(function* () {
        const h = yield* RestateTestHarness
        const recovered = yield* h.ingress
          .callTyped(WidgetApi, 'fetch', { baseUrl, widgetId: 'missing-1' })
          .pipe(Effect.catchTag('NotFound', (e: NotFound) => Effect.succeed(e.widgetId)))
        expect(recovered).toBe('missing-1')
      }),
    )

    it.effect('200 with a malformed body → terminal MalformedUpstream (no retry)', () =>
      Effect.gen(function* () {
        const h = yield* RestateTestHarness
        const recovered = yield* h.ingress
          .callTyped(WidgetApi, 'fetch', { baseUrl, widgetId: 'garbage-1' })
          .pipe(
            Effect.catchTag('MalformedUpstream', (e: MalformedUpstream) => Effect.succeed(e._tag)),
          )
        expect(recovered).toBe('MalformedUpstream')
        /* Terminal: the upstream was hit EXACTLY once (no durable retry). */
        expect(hits['garbage-1']).toBe(1)
      }),
    )

    /* ── `fetch`: transients ride Restate's durable STEP retry (re-fetch). ──── */

    it.effect('fetch: 429-then-200 → the run STEP re-fetches and SUCCEEDS', () =>
      Effect.gen(function* () {
        const h = yield* RestateTestHarness
        const ok = yield* h.ingress.callTyped(WidgetApi, 'fetch', {
          baseUrl,
          widgetId: 'flaky-step',
        })
        expect(ok).toEqual({ id: 'flaky-step', name: 'Widget flaky-step' })
        expect(hits['flaky-step']! >= 3).toBe(true)
      }),
    )

    /* ── `fetchRetryable`: transient → backing-off; the handler re-fetches. ── */

    it.effect('fetchRetryable: 429 → the handler is RETRIED (hit count climbs)', () =>
      Effect.gen(function* () {
        const h = yield* RestateTestHarness
        /* Forked: parked in `backing-off`, retrying — assert via the climbing count. */
        yield* h.ingress
          .callTyped(WidgetApi, 'fetchRetryable', { baseUrl, widgetId: 'throttled-1' })
          .pipe(Effect.ignore, Effect.fork)
        expect(yield* climbsPastOne(() => hits['throttled-1'] ?? 0)).toBe(true)
      }),
    )

    it.effect('fetchRetryable: 429-then-200 → handler retry re-fetches and SUCCEEDS', () =>
      Effect.gen(function* () {
        const h = yield* RestateTestHarness
        const ok = yield* h.ingress.callTyped(WidgetApi, 'fetchRetryable', {
          baseUrl,
          widgetId: 'flaky-handler',
        })
        expect(ok).toEqual({ id: 'flaky-handler', name: 'Widget flaky-handler' })
        expect(hits['flaky-handler']! >= 3).toBe(true)
      }),
    )
  })
})
