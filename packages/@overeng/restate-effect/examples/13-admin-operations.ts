/**
 * Operating a deployment with the `./admin` management API — the Molty
 * notifications runbook, made concrete (decision 0018, spec §12).
 *
 * A production consumer (Molty notifications) needs to OPERATE a running
 * deployment, not just invoke it. This recipe models the two constructs such a
 * consumer runs — an `incident` Virtual Object (a single-writer state machine
 * keyed by incident id) and a `delivery` Workflow (durable Discord delivery that
 * can WEDGE on a retryable error) — and the admin flows an operator uses against
 * them:
 *
 * - LIST invocations, filtered by service + status (`SELECT … FROM sys_invocation`).
 * - INSPECT a workflow's State (`stateOf` / `SELECT … FROM state`).
 * - QUERY a Virtual-Object (incident) key's State.
 * - SURFACE STUCK deliveries — workflows parked on a RETRYABLE error
 *   (`status = 'backing-off'`, a non-zero `retry_count`, a `last_failure`).
 * - CANCEL / KILL a wedged invocation, and RESTART-as-new.
 *
 * The admin surface is wired through `RestateAdmin.layer({ adminUrl })` — pointing
 * at the server's ADMIN url, NOT the ingress url. SECURITY: the admin API is
 * unauthenticated by default; never expose it publicly (see `./admin`'s doc).
 *
 * Verified end-to-end by `src/admin.integration.test.ts`, which boots a native
 * server via `./testing`, drives these contracts, and runs the admin flows against
 * the harness's admin endpoint.
 */
import { Effect, Schema } from 'effect'

import { DurablePromise, Restate, RestateObject, RestateWorkflow, State } from '../src/mod.ts'

/* ════════════════════════════════════════════════════════════════════════
 * The incident Virtual Object — a single-writer state machine keyed by id.
 * ════════════════════════════════════════════════════════════════════════ */

export const IncidentState = {
  /** The incident lifecycle the operator inspects via `QUERY object state`. */
  status: Schema.Literal('open', 'acknowledged', 'resolved'),
  /** A free-form human note recorded on the last transition. */
  note: Schema.String,
} as const

const Incident = State.for(IncidentState)

export const IncidentObj = RestateObject.contract('incident', {
  state: IncidentState,
  handlers: {
    /** Open (or re-open) the incident — exclusive single-writer transition. */
    open: { input: Schema.String, success: Schema.Void },
    /** Acknowledge — exclusive transition. */
    acknowledge: { input: Schema.String, success: Schema.Void },
    /** Read the current status — shared, read-only (a `State.set` here is a compile error). */
    status: { input: Schema.Void, success: Schema.String, shared: true },
  },
})

export const IncidentLive = RestateObject.implement<typeof IncidentObj>(IncidentObj, {
  open: (note) =>
    Effect.gen(function* () {
      yield* Incident.set('status', 'open')
      yield* Incident.set('note', note)
    }),
  acknowledge: (note) =>
    Effect.gen(function* () {
      yield* Incident.set('status', 'acknowledged')
      yield* Incident.set('note', note)
    }),
  status: () => Incident.get('status').pipe(Effect.map((s) => s ?? 'open')),
})

/* ════════════════════════════════════════════════════════════════════════
 * The delivery Workflow — durable Discord delivery that can WEDGE.
 * ════════════════════════════════════════════════════════════════════════ */

export const DeliveryState = {
  /** Where the delivery is in its lifecycle — inspected via `INSPECT workflow state`. */
  phase: Schema.Literal('delivering', 'delivered', 'gave-up'),
} as const

const Delivery = State.for(DeliveryState)

/* A signal the operator (or an upstream system) sends to UNWEDGE a delivery
 * parked on the durable promise — the rendezvous between `run` and the signal. */
const Release = DurablePromise.for(Schema.Struct({ go: Schema.Boolean }))

/**
 * A RETRYABLE delivery failure (a transient Discord 429 / 5xx). `Restate.retryable`
 * marks it so `toTerminal` throws it NON-terminally — Restate then DURABLY backs
 * off and retries, parking the invocation in `status = 'backing-off'`, which is
 * exactly the "stuck delivery" an operator surfaces (see {@link stuckDeliveriesSql})
 * and then cancels/kills. The `retryAfter` floor is PROJECTED off the actual
 * failing error (a 429's `retryAfterMillis`). Exported as the annotated schema the
 * contract's `error` references (the binding reads the annotation at the boundary).
 */
export class DiscordUnavailable extends Schema.TaggedError<DiscordUnavailable>(
  'example/DiscordUnavailable',
)('DiscordUnavailable', { retryAfterMillis: Schema.Number }) {}

export const DiscordUnavailableRetryable = Restate.retryable(DiscordUnavailable, {
  retryAfter: (e: DiscordUnavailable) => e.retryAfterMillis,
})

export const DeliveryWf = RestateWorkflow.contract('delivery', {
  state: DeliveryState,
  payload: { input: Schema.Struct({ wedge: Schema.Boolean }), success: Schema.Boolean },
  signals: {
    /** Release a wedged delivery — resolves the durable promise so `run` proceeds. */
    release: { input: Schema.Void, success: Schema.Void },
  },
  queries: {
    /** Read the delivery phase — shared, read-only. */
    phase: { input: Schema.Void, success: Schema.String },
  },
})

export const DeliveryLive = RestateWorkflow.implement<typeof DeliveryWf>(DeliveryWf, {
  /**
   * The single `run`. When `wedge` is set it parks on a long DURABLE SLEEP — the
   * invocation durably SUSPENDS (`sys_invocation.status = 'suspended'`), modeling a
   * delivery blocked on a long backoff/dependency wait, the realistic "stuck
   * delivery" shape an operator surfaces and then CANCELS (the cancel surfaces as an
   * interruption so finalizers run, R31). Otherwise it delivers immediately. A real
   * consumer would instead `Restate.run` the HttpClient Discord call and fail with
   * {@link DiscordUnavailable} on a 429/5xx (Restate then backs off + retries,
   * landing in `status = 'backing-off'`) — see `examples/14-http-error-classification.ts`.
   */
  run: ({ wedge }) =>
    Effect.gen(function* () {
      yield* Delivery.set('phase', 'delivering')
      if (wedge) {
        /* Suspend on a long durable timer until the operator cancels/kills the
         * invocation (or it eventually fires). */
        yield* Restate.sleep(600_000, 'delivery-backoff')
      }
      yield* Delivery.set('phase', 'delivered')
      return true
    }),
  /* A `release` signal resolves a durable promise — the rendezvous shape used when
   * a delivery waits on an UPSTREAM dependency rather than a timer. Kept as the
   * unwedge building block for that variant. */
  release: () => Release.resolve('release', { go: true }),
  phase: () => Delivery.get('phase').pipe(Effect.map((p) => p ?? 'delivering')),
})

/* ════════════════════════════════════════════════════════════════════════
 * The SQL the runbook uses against `sys_invocation` (admin `/query`).
 * ════════════════════════════════════════════════════════════════════════ */

/** A row shape the operator decodes invocation rows into (the caller owns this Schema). */
export const InvocationRow = Schema.Struct({
  id: Schema.String,
  target_service_name: Schema.String,
  target_handler_name: Schema.String,
  status: Schema.String,
  retry_count: Schema.optional(Schema.NullishOr(Schema.Number)),
})
export type InvocationRow = Schema.Schema.Type<typeof InvocationRow>

/** LIST invocations for one service (filter by `target_service_name`). */
export const listByServiceSql = (service: string): string =>
  `SELECT id, target_service_name, target_handler_name, status, retry_count
   FROM sys_invocation
   WHERE target_service_name = '${service}'`

/**
 * SURFACE STUCK deliveries: invocations that are NOT making forward progress, i.e.
 * non-TERMINAL (anything but `completed`). The non-terminal statuses an operator
 * triages, VERIFIED against restate-server 1.6.2:
 *
 * - `backing-off` — parked on a RETRYABLE error (a Discord 429 / 5xx surfaced as
 *   {@link DiscordUnavailable}); the SDK is durably retrying. `retry_count` climbs.
 * - `suspended` — a stateless Service / Virtual Object handler parked on a durable
 *   wait (sleep / awakeable / call).
 * - `running` — note: a WORKFLOW `run` blocked on a long durable wait reports
 *   `running` on 1.6.2 (it does NOT flip to `suspended` like an Object handler does),
 *   so a long-`running` delivery `run` is itself a stuck signal.
 *
 * The query returns every non-terminal delivery; the operator then inspects state,
 * `release`s (unwedge), or `cancel`/`kill`s. `retry_count` ranks the most-stuck.
 */
export const stuckDeliveriesSql = (service: string): string =>
  `SELECT id, target_service_name, target_handler_name, status, retry_count
   FROM sys_invocation
   WHERE target_service_name = '${service}'
     AND status != 'completed'
   ORDER BY retry_count DESC`
