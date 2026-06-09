/**
 * Classifying real HTTP outcomes from an `HttpClient` call (Molty consumer recipe
 * #3 — the union-member classification, made concrete). A handler that calls an
 * upstream HTTP API must decide, per response, whether the outcome is TERMINAL (no
 * retry can help) or TRANSIENT (a retry might). Restate has exactly two channels:
 *
 * - TERMINAL → a typed DOMAIN error in the handler's `E`. It crosses the wire as a
 *   `TerminalError` and the caller `catchTag`s it. NEVER retried.
 *     - HTTP 400 / 403 / 404 — a deterministic bad request / auth / not-found.
 *     - a MALFORMED success body (200 but the payload fails its Schema) — retrying
 *       the same upstream returns the same broken bytes, so it is terminal too.
 * - TRANSIENT → a retry MIGHT succeed. HTTP 429 / 5xx / a network timeout.
 *
 * This file shows the TWO idiomatic ways to drive the transient retry, because the
 * journal makes them genuinely different (and the difference is a real consumer
 * footgun):
 *
 * 1. {@link WidgetApiLive} `fetch` — the HTTP call is INSIDE `Restate.run`, and a
 *    transient FAILS the step so RESTATE'S DURABLE STEP RETRY re-fetches with
 *    backoff. A terminal/malformed outcome COMMITS to the journal (it is final) and
 *    the handler raises the typed terminal error. This is the right default for an
 *    idempotent read: the step re-executes on retry, so a 429-then-200 upstream
 *    eventually succeeds.
 *
 * 2. {@link WidgetApiLive} `fetchRetryable` — surfaces the transient as the
 *    `Restate.retryable` `UpstreamUnavailable` so the WHOLE invocation parks in
 *    `status = 'backing-off'` (operator-visible per `examples/13-admin-operations.ts`),
 *    with the 429's `Retry-After` PROJECTED onto the error as the next-attempt floor.
 *    The fetch is NOT wrapped in a committed `run` on the transient path: a journaled
 *    transient would REPLAY the stale 429 forever instead of re-fetching (verified —
 *    that is the footgun), so the handler-level retry re-fetches from the top.
 *
 * Both share the SAME realistic typed error union. Verified end-to-end by
 * `src/error/http-error-classification.integration.test.ts`, which boots a native
 * `restate-server` via `./testing`, serves these handlers against a tiny in-process
 * upstream returning controlled statuses, and asserts each union member lands in the
 * right channel. Skips when no native server is available.
 */
import { HttpClient, HttpClientRequest, type HttpClientResponse } from '@effect/platform'
import { Effect, ParseResult, Schema } from 'effect'

import { Restate, RestateService } from '../src/mod.ts'

/* ── The upstream success payload (what a 2xx body must decode into) ────────── */

export const Widget = Schema.Struct({ id: Schema.String, name: Schema.String })
export type Widget = Schema.Schema.Type<typeof Widget>

/* ════════════════════════════════════════════════════════════════════════
 * The typed error union — a REALISTIC mix of terminal + retryable members.
 * ════════════════════════════════════════════════════════════════════════ */

/** TERMINAL: a deterministic bad request (HTTP 400). No retry can help. */
export class BadRequest extends Schema.TaggedError<BadRequest>('http/BadRequest')('BadRequest', {
  detail: Schema.String,
}) {}
export const BadRequestTerminal = Restate.terminal(BadRequest, { errorCode: 400 })

/** TERMINAL: not authorized (HTTP 403). */
export class Forbidden extends Schema.TaggedError<Forbidden>('http/Forbidden')('Forbidden', {}) {}
export const ForbiddenTerminal = Restate.terminal(Forbidden, { errorCode: 403 })

/** TERMINAL: the resource does not exist (HTTP 404). */
export class NotFound extends Schema.TaggedError<NotFound>('http/NotFound')('NotFound', {
  widgetId: Schema.String,
}) {}
export const NotFoundTerminal = Restate.terminal(NotFound, { errorCode: 404 })

/**
 * TERMINAL: the upstream returned 200 but the body did not match `Widget`. Retrying
 * the same upstream returns the same broken bytes, so a malformed payload is a
 * terminal DOMAIN error (a 502-style "bad gateway from us to our caller"), NOT a
 * retryable one — distinct from a transient 5xx.
 */
export class MalformedUpstream extends Schema.TaggedError<MalformedUpstream>(
  'http/MalformedUpstream',
)('MalformedUpstream', { detail: Schema.String }) {}
export const MalformedUpstreamTerminal = Restate.terminal(MalformedUpstream, { errorCode: 502 })

/**
 * RETRYABLE: a transient upstream failure (HTTP 429 / 5xx / network timeout).
 * `Restate.retryable` makes the boundary throw it non-terminally — Restate durably
 * backs off and retries, parking the invocation in `status = 'backing-off'`. The
 * `retryAfter` floor is PROJECTED off this very error instance: a 429's `Retry-After`
 * header is decoded into `retryAfterMillis` and becomes the next attempt's floor
 * (a 5xx / timeout carries `0`, falling back to Restate's default backoff).
 */
export class UpstreamUnavailable extends Schema.TaggedError<UpstreamUnavailable>(
  'http/UpstreamUnavailable',
)('UpstreamUnavailable', {
  status: Schema.Number,
  retryAfterMillis: Schema.Number,
}) {}
export const UpstreamUnavailableRetryable = Restate.retryable(UpstreamUnavailable, {
  /* `e: UpstreamUnavailable` — typed because the class is named. `0` → default backoff. */
  retryAfter: (e: UpstreamUnavailable) => (e.retryAfterMillis > 0 ? e.retryAfterMillis : undefined),
})

/** The terminal-only members both handlers can raise from a definitive response. */
export type TerminalError = BadRequest | Forbidden | NotFound | MalformedUpstream

/* ════════════════════════════════════════════════════════════════════════
 * Response classification (shared by both handlers).
 * ════════════════════════════════════════════════════════════════════════ */

/** Parse a `Retry-After` header (delta-seconds form) into milliseconds; `0` if absent. */
const retryAfterMillisOf = (header: string | undefined): number => {
  if (header === undefined) return 0
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0
}

/** A 4xx the binding treats as DETERMINISTIC (no retry): 400 / 403 / 404. */
const isTerminalStatus = (status: number): boolean =>
  status === 400 || status === 403 || status === 404

/** Map a terminal HTTP status to its typed domain error. */
const terminalError = (
  status: number,
  detail: string,
  widgetId: string,
): Effect.Effect<never, BadRequest | Forbidden | NotFound> => {
  switch (status) {
    case 403:
      return new Forbidden()
    case 404:
      return new NotFound({ widgetId })
    default:
      /* 400 → a bad request the caller owns. */
      return new BadRequest({ detail })
  }
}

/**
 * Decode a 200 body into a `Widget`, or fail with `MalformedUpstream`. A non-JSON
 * body (`ResponseError`) OR a `Widget` decode mismatch (`ParseError`) is terminal —
 * the same bytes fail identically on a retry.
 */
const decodeWidget = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<Widget, MalformedUpstream> =>
  response.json.pipe(
    Effect.flatMap(Schema.decodeUnknown(Widget)),
    Effect.catchAll(
      (e) =>
        new MalformedUpstream({
          detail: ParseResult.isParseError(e) ? 'body did not match Widget schema' : String(e),
        }),
    ),
  )

/* ════════════════════════════════════════════════════════════════════════
 * The contract — both handlers share the same I/O and the full typed union.
 * ════════════════════════════════════════════════════════════════════════ */

const FetchInput = Schema.Struct({ baseUrl: Schema.String, widgetId: Schema.String })
const FetchErrorUnion = Schema.Union(
  BadRequestTerminal,
  ForbiddenTerminal,
  NotFoundTerminal,
  MalformedUpstreamTerminal,
  UpstreamUnavailableRetryable,
)

export const WidgetApi = RestateService.contract('widget-api', {
  /** Idempotent read; transient retries ride Restate's durable STEP retry. */
  fetch: { input: FetchInput, success: Widget, error: FetchErrorUnion },
  /** Same union, but a transient surfaces as the caller-visible `retryable` error. */
  fetchRetryable: { input: FetchInput, success: Widget, error: FetchErrorUnion },
})

/**
 * The discriminated outcome the committed `Restate.run` step journals for the
 * DEFINITIVE cases (`fetch`). The transient case never reaches here — it fails the
 * step (below) so Restate's durable step retry re-fetches.
 */
type Definitive =
  | { readonly _tag: 'ok'; readonly widget: Widget }
  | { readonly _tag: 'terminal'; readonly status: number; readonly detail: string }
  | { readonly _tag: 'malformed'; readonly detail: string }

/**
 * `AppR = HttpClient.HttpClient`: both handlers need an `HttpClient` from the
 * application Layer (a `FetchHttpClient.layer` in production / the test). It is
 * provided ONCE at the endpoint and shared by every invocation.
 */
export const WidgetApiLive = RestateService.implement<typeof WidgetApi, HttpClient.HttpClient>(
  WidgetApi,
  {
    /**
     * RECOMMENDED for an idempotent read. The fetch is a JOURNALED `Restate.run`
     * step. A DEFINITIVE outcome (2xx / 4xx-terminal) COMMITS — a replay reproduces
     * it. A TRANSIENT (429 / 5xx / network) FAILS the step, so it is NOT committed
     * and RESTATE'S DURABLE STEP RETRY re-fetches with backoff (the give-up after
     * `maxRetryAttempts` becomes a defect Restate retries at the invocation level).
     * A `Widget` decode mismatch is a `MalformedUpstream` failure inside the closure,
     * which the handler observes via `runExit` and re-raises terminally.
     */
    fetch: ({ baseUrl, widgetId }) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        /* The fetch step: commit a definitive outcome, or FAIL on a transient so the
         * step retries (re-fetching). A decode mismatch fails terminally too. */
        const outcome = yield* Restate.run(
          `fetch-${widgetId}`,
          client.execute(HttpClientRequest.get(`${baseUrl}/widgets/${widgetId}`)).pipe(
            Effect.flatMap((response): Effect.Effect<Definitive> => {
              const status = response.status
              if (status === 200)
                /* Commit a definitive `ok` OR `malformed` — a decode mismatch is
                 * final (the same bytes fail identically on a retry). */
                return decodeWidget(response).pipe(
                  Effect.map((widget): Definitive => ({ _tag: 'ok', widget })),
                  Effect.catchAll((e) =>
                    Effect.succeed<Definitive>({ _tag: 'malformed', detail: e.detail }),
                  ),
                )
              if (isTerminalStatus(status))
                return Effect.succeed<Definitive>({
                  _tag: 'terminal',
                  status,
                  detail: `HTTP ${status}`,
                })
              /* TRANSIENT (429 / 5xx) → FAIL the step (die) so Restate re-fetches. */
              return Effect.die(new Error(`transient upstream: HTTP ${status}`))
            }),
            /* A transport-level failure (refused / timeout) → also FAIL the step. */
            Effect.catchTag('RequestError', (e) => Effect.die(e)),
            Effect.catchTag('ResponseError', (e) => Effect.die(e)),
          ),
        )
        switch (outcome._tag) {
          case 'ok':
            return outcome.widget
          case 'malformed':
            return yield* new MalformedUpstream({ detail: outcome.detail })
          case 'terminal':
            return yield* terminalError(outcome.status, outcome.detail, widgetId)
        }
      }),

    /**
     * For when you want the transient to be CALLER-VISIBLE as the `retryable`
     * `UpstreamUnavailable` with the 429's `Retry-After` projected (so the whole
     * invocation parks in `backing-off`, not just a step). The fetch is performed in
     * the handler body — NOT a committed `run` for the transient path — because a
     * journaled transient would REPLAY the stale 429 forever instead of re-fetching.
     * Definitive successes/terminals are still classified the same way.
     */
    fetchRetryable: ({ baseUrl, widgetId }) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        /* The fetch runs each handler attempt (re-fetching on retry); only the
         * transport failure is treated as transient via `catchTag`. */
        const response = yield* client
          .execute(HttpClientRequest.get(`${baseUrl}/widgets/${widgetId}`))
          .pipe(
            /* No usable response (refused / timeout / broken stream) → transient with
             * default backoff; `HttpClientError` is `RequestError | ResponseError`. */
            Effect.catchTag(
              'RequestError',
              () => new UpstreamUnavailable({ status: 0, retryAfterMillis: 0 }),
            ),
            Effect.catchTag(
              'ResponseError',
              () => new UpstreamUnavailable({ status: 0, retryAfterMillis: 0 }),
            ),
          )
        const status = response.status
        if (status === 200) return yield* decodeWidget(response)
        if (isTerminalStatus(status))
          return yield* terminalError(status, `HTTP ${status}`, widgetId)
        /* TRANSIENT (429 / 5xx) → the retryable error, `Retry-After` projected. */
        return yield* new UpstreamUnavailable({
          status,
          retryAfterMillis: retryAfterMillisOf(response.headers['retry-after']),
        })
      }),
  },
)
