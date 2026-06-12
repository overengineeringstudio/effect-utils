/**
 * The replay-aware baseline metrics (R23, docs/vrs/08-observability/spec.md, decision 0014). These are
 * Effect `Metric`s — `effect` is a CORE dependency, so the definitions live here
 * with no heavy OTel SDK import; `./otel`'s `RestateOtel.layer` binds Effect's
 * `Metric` to an OTel `MeterProvider` (`@effect/opentelemetry`'s `Metrics.layer`)
 * so the same counters/histograms export over OTLP. Without that Layer the metrics
 * are still valid Effect metrics (in-memory), so the core stays dependency-light.
 *
 * The SUBTLE part is exactly-once-on-replay (R24, R25): an invocation re-runs its
 * handler on every attempt and on replay, so a naive increment double-counts. The
 * single seam is {@link emitWhenProcessing} — it gates the increment on the SDK's
 * `ctx.isProcessing()` (the same non-replay signal the hook uses for span-event
 * suppression), so the metric fires once per REAL execution slice, never on a
 * journal replay. Each metric below documents WHERE it is emitted and WHY that
 * seam is exactly-once.
 */
import type * as restate from '@restatedev/restate-sdk'
import { Effect, type Schema } from 'effect'

import { OtelMetric, OtelSpan } from '@overeng/otel-contract'

import { findSensitiveFields } from '../schema/Redaction.ts'
import { RestateMetrics } from './contract.ts'

/**
 * Per-invocation OUTCOME counter (`restate_invocations_total`), labelled
 * `service` / `handler` / `outcome` (`success` | `terminal` | `retryable` |
 * `cancelled`). Emitted at the boundary's FINAL classification (one per real
 * attempt that produces a terminal outcome), gated on non-replay so replays do
 * NOT re-increment. A `retryable` attempt counts on every real failed attempt —
 * that is the retry-pressure signal (retries derive as the `retryable` rate).
 */
const invocationsTotalBridge = OtelMetric.effect.counter(RestateMetrics.invocationsTotal)
export const invocationsTotal = invocationsTotalBridge.metric

/** Per-invocation DURATION histogram (`restate_invocation_duration_ms`), gated on non-replay. */
const invocationDurationMsBridge = OtelMetric.effect.histogram(RestateMetrics.invocationDurationMs)
export const invocationDurationMs = invocationDurationMsBridge.metric

/**
 * Per-ATTEMPT counter (`restate_attempts_total`), labelled `service` / `handler`.
 * Emitted at the boundary on every REAL (processing) handler entry, so the retry
 * count derives as `attempts_total - invocations_total{outcome=success|terminal}`
 * (the extra attempts are the retries). Gated on non-replay so a journal replay —
 * which re-runs the handler body without being a new attempt — is not counted.
 */
const attemptsTotalBridge = OtelMetric.effect.counter(RestateMetrics.attemptsTotal)
export const attemptsTotal = attemptsTotalBridge.metric

/**
 * Durable-step counter (`restate_durable_steps_total`), labelled `step` (the
 * `Restate.run` name). Emitted at the `Restate.run` seam gated on non-replay: the
 * journaled `ctx.run` body runs once on real execution and is skipped on replay,
 * so gating the increment on `isProcessing()` makes the step counted exactly once
 * across all attempts. Not labelled by service/handler (the invocation span
 * already carries those) to keep cardinality bounded.
 */
const durableStepsTotalBridge = OtelMetric.effect.counter(RestateMetrics.durableStepsTotal)
export const durableStepsTotal = durableStepsTotalBridge.metric

/**
 * Awakeable wait-latency histogram (`restate_awakeable_wait_ms`). Emitted when an
 * awakeable `promise` resolves, measuring the real wall-clock wait, gated on
 * non-replay (a replay reproduces the journaled completion instantly — not a real
 * wait). Captures external-completion latency (e.g. a webhook callback round-trip).
 */
const awakeableWaitMsBridge = OtelMetric.effect.histogram(RestateMetrics.awakeableWaitMs)
export const awakeableWaitMs = awakeableWaitMsBridge.metric

/**
 * `pollLoop` cycle counter (`restate_poll_loop_cycles_total`), labelled `name`
 * (the scheduled-loop instance) and `outcome` (`ok` | `error` | `stopped`).
 * Emitted inside the loop's exclusive `cycle` handler gated on non-replay, so each
 * real cycle execution is counted exactly once.
 */
const pollLoopCyclesTotalBridge = OtelMetric.effect.counter(RestateMetrics.pollLoopCyclesTotal)
export const pollLoopCyclesTotal = pollLoopCyclesTotalBridge.metric

/**
 * A MONOTONIC wall-clock reading (milliseconds) for duration measurement. Uses
 * `process.hrtime.bigint()` — NOT `Date.now()` — deliberately: it is monotonic
 * (immune to wall-clock adjustments) AND it is NOT a journaled source, which is
 * correct here because the value only ever feeds a metric recorded gated on
 * non-replay (it never influences journaled state / control flow, so it does not
 * break deterministic replay — the `overeng/no-raw-nondeterminism` lint targets
 * `Date.now()` reads that could leak into the journal, which this is not).
 */
export const monotonicMs = (): number => Number(process.hrtime.bigint() / 1_000_000n)

/**
 * Whether the invocation is REALLY processing (not replaying journaled work),
 * read from the raw `restate.Context`'s `isProcessing()` (backed by the SDK's VM).
 * `true` when the method is unavailable (a future SDK) so gating degrades to
 * "emit" rather than silently dropping every metric.
 */
export const isProcessing = (ctx: restate.Context): boolean => {
  const probe = (ctx as { isProcessing?: () => boolean }).isProcessing
  return typeof probe === 'function' ? probe.call(ctx) === true : true
}

/**
 * The exactly-once metric seam (R24, R25): run `emit` ONLY when the invocation is
 * really processing (not replaying). This is the single gate every auto baseline
 * metric routes through so a journal replay never double-counts. A no-op (and no
 * `RestateContext` read) when replaying.
 */
export const emitWhenProcessing = (
  ctx: restate.Context,
  emit: Effect.Effect<void>,
): Effect.Effect<void> => (isProcessing(ctx) === true ? emit : Effect.void)

/**
 * Emit the per-invocation outcome counter + duration histogram + the per-attempt
 * counter for ONE real attempt, gated on non-replay. `outcome` is the boundary's
 * final classification label; `durationMs` is the attempt wall-clock.
 */
export const emitInvocationMetrics = (
  ctx: restate.Context,
  args: {
    readonly service: string
    readonly handler: string
    readonly outcome: 'success' | 'terminal' | 'retryable' | 'cancelled'
    readonly durationMs: number
  },
): Effect.Effect<void> => {
  return emitWhenProcessing(
    ctx,
    Effect.all(
      [
        invocationsTotalBridge.trustedIncrement({
          service: args.service,
          handler: args.handler,
          outcome: args.outcome,
        }),
        invocationDurationMsBridge.trustedRecord(
          {
            service: args.service,
            handler: args.handler,
            outcome: args.outcome,
          },
          args.durationMs,
        ),
      ],
      { discard: true },
    ),
  )
}

/** Emit the per-attempt counter for ONE real handler entry, gated on non-replay. */
export const emitAttempt = (
  ctx: restate.Context,
  args: { readonly service: string; readonly handler: string },
): Effect.Effect<void> =>
  emitWhenProcessing(
    ctx,
    attemptsTotalBridge.trustedIncrement({
      service: args.service,
      handler: args.handler,
    }),
  )

/** Emit the durable-step counter for ONE real `Restate.run`, gated on non-replay. */
export const emitDurableStep = (ctx: restate.Context, step: string): Effect.Effect<void> =>
  emitWhenProcessing(
    ctx,
    durableStepsTotalBridge.trustedIncrement({
      step,
    }),
  )

/** Record an awakeable wait latency, gated on non-replay. */
export const emitAwakeableWait = (ctx: restate.Context, waitMs: number): Effect.Effect<void> =>
  emitWhenProcessing(ctx, awakeableWaitMsBridge.trustedRecord({}, waitMs))

/** Emit a `pollLoop` cycle outcome counter, gated on non-replay. */
export const emitPollLoopCycle = (
  ctx: restate.Context,
  args: { readonly name: string; readonly outcome: 'ok' | 'error' | 'stopped' },
): Effect.Effect<void> =>
  emitWhenProcessing(
    ctx,
    pollLoopCyclesTotalBridge.trustedIncrement({
      name: args.name,
      outcome: args.outcome,
    }),
  )

/** A dynamic span-attribute value accepted by the contract's map annotation helper. */
type AttributeValue = string | number | boolean

const annotateDynamicSpanMap = (
  attributes: Readonly<Record<string, AttributeValue>>,
): Effect.Effect<void> => OtelSpan.annotateMap(attributes)

/**
 * Stamp custom BUSINESS attributes on the CURRENT span — the user path for
 * slicing in Tempo/Grafana (R23, docs/vrs/08-observability/spec.md, decision 0014). In a handler
 * the current span is the Effect span reparented under the hook's `attempt <target>`
 * span (the inbound bridge), so the attributes ride the one coherent trace. Exported
 * as `Restate.annotateSpan`.
 *
 * Use the `span.label` Grafana convention where it fits (a single primary label),
 * and plain keys for slicing dimensions (e.g. `dataSourceId`):
 *
 * ```ts
 * yield* Restate.annotateSpan({ dataSourceId, 'span.label': dataSourceId })
 * ```
 *
 * Attributes are NOT replay-suppressed (unlike span EVENTS), so prefer stable
 * identity values here; for side-effecting telemetry use a metric / span event
 * gated through `Restate.run`.
 *
 * REDACTION (decision 0014): a span attribute is PLAINTEXT — the serde's
 * field-level redaction does NOT apply here, so NEVER hand this a value read from a
 * `sensitive`/`redacted` schema field (that would leak the plaintext onto the span,
 * bypassing the encrypt-at-encode transform). This surface takes raw primitives and
 * cannot detect sensitivity; when annotating a PROJECTION of a decoded struct, use
 * {@link annotateSpanFrom}, which strips the schema's sensitive fields by
 * construction.
 */
export const annotateSpan = (
  attributes: Readonly<Record<string, AttributeValue>>,
): Effect.Effect<void> => annotateDynamicSpanMap(attributes)

/**
 * Stamp span attributes PROJECTED from a decoded struct value — SAFE BY DEFAULT
 * against the redaction rule (decision 0014): every field annotated by
 * {@link Restate.sensitive}/`redacted` on `schema` is STRIPPED, so a sensitive
 * value can never reach the span even if the caller forgot to exclude it. This is
 * the schema-aware counterpart to {@link annotateSpan} for the common "annotate a
 * few non-secret fields of my decoded input/state" case — the same
 * `findSensitiveFields` walk the serde redaction uses is the single source of truth
 * for which fields are sensitive, so the span projection and the serde can never
 * disagree about what is secret.
 *
 * Only primitive (`string`/`number`/`boolean`) field values are stamped; an
 * `undefined`/absent field is skipped, and a non-primitive field (object/array) is
 * skipped (a span attribute is a scalar). Pass `pick` to annotate a SUBSET of the
 * non-sensitive fields; omit it to annotate every non-sensitive primitive field.
 *
 * ```ts
 * // `apiToken` is `Restate.sensitive(Schema.String)` — it is NEVER stamped.
 * yield* Restate.annotateSpanFrom(InputSchema, decodedInput, ['dataSourceId'])
 * ```
 */
export const annotateSpanFrom = <A, I>(
  schema: Schema.Schema<A, I>,
  value: A,
  pick?: ReadonlyArray<keyof A & string>,
): Effect.Effect<void> => {
  if (typeof value !== 'object' || value === null) return Effect.void
  const sensitive = new Set<string>(findSensitiveFields(schema.ast))
  const record = value as Record<string, unknown>
  const keys: ReadonlyArray<string> = pick ?? Object.keys(record)
  const safe: Array<readonly [string, AttributeValue]> = []
  for (const key of keys) {
    /* A sensitive field is NEVER stamped — even if the caller explicitly `pick`ed it
     * (the redaction rule wins over an accidental projection). */
    if (sensitive.has(key) === true) continue
    const v = record[key]
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      safe.push([key, v])
    }
  }
  return annotateDynamicSpanMap(Object.fromEntries(safe))
}
