/**
 * SEAM member contract for the `restate.*` telemetry namespace (decision 0005) — restate-effect's
 * OWN observability catalog, authored via the Layer-2 `@overeng/otel-contract/registry` surface.
 * This is the single home for restate-effect's telemetry attribute catalog: the Weaver registry
 * projection AND the runtime encoders (`./contract.ts`) both derive from it (SC-R13/R14).
 *
 * This is a `*.contract.ts` seam file, so it is exempt from the `otel-contract-in-seam-file` lint
 * and MUST be registered in the root aggregator's `memberSeamPaths` (a colocated no-orphan-seam
 * test asserts this).
 *
 * Placement: `src/observability/` (beside `contract.ts`, which already imports `@overeng/otel-contract`
 * at runtime), so this file's `./registry` import is dependency-safe.
 *
 * SPAN ATTRS reach telemetry through a DYNAMIC-NAME bridge span the Restate SDK hook owns
 * (`attempt <target>`, stamped by the boundary observer) or the dynamic in-handler
 * `restateOperation(name)` span — neither has a stable single-signal registry projection (SC-DQ5,
 * mirroring genie's `cli.mode` and megarepo's dynamic bridges). So those catalog keys reach the
 * registry via `docOnlyAttributes` for completeness (SC-R13), and the runtime bridges stay legacy
 * inline in `contract.ts`, rebuilt from the IMPORTED catalog schemas below (identical encode —
 * proven by the colocated equivalence property test).
 *
 * METRICS MIGRATED (BREAKING label rename, APPROVED). restate-effect's replay-aware baseline metrics
 * (`restate_invocations_total`, …, `Metrics.ts`) historically carried UNPREFIXED Prometheus-style
 * label keys (`service`, `handler`, `outcome`, `step`, `name`). They are now authored as registry
 * `metric(...)` SIGNALS below, so their emitted label keys are the namespaced catalog keys
 * (`restate.service`, `restate.handler`, `restate.outcome`, `restate.step`, `restate.name`) — the
 * same move megarepo made for `repo_concurrency` (retention-first: the old bare labels stop being
 * emitted, the new `restate.*` labels emit). The runtime metric definitions in `./contract.ts` are
 * DERIVED from these seam signals (`.metric`), bridged to Effect `Metric`s in `Metrics.ts`.
 */
import { attr, defineOtelContract, metric, required } from '@overeng/otel-contract/registry'

// ---------------------------------------------------------------------------
// attributes (annotated Effect Schemas; the restate.* catalog SSOT)
// ---------------------------------------------------------------------------

/** Restate construct (service/object/workflow) name a handler belongs to. */
export const RestateService = attr.string({
  key: 'restate.service',
  cardinality: 'bounded',
  brief: 'Restate construct (service/object/workflow) name a handler belongs to.',
  stability: 'development',
  examples: ['greeter', 'orders'],
})

/** Restate handler name within a construct. */
export const RestateHandler = attr.string({
  key: 'restate.handler',
  cardinality: 'bounded',
  brief: 'Restate handler name within a construct.',
  stability: 'development',
  examples: ['greet', 'submit'],
})

/** Virtual-Object key of the invocation (omitted for plain Services). */
export const RestateObjectKey = attr.string({
  key: 'restate.object.key',
  cardinality: 'high',
  brief: 'Virtual-Object key of the invocation (omitted for plain Services).',
  stability: 'development',
  examples: ['user-42'],
})

/** Workflow key of the invocation (omitted for Services/Objects). */
export const RestateWorkflowId = attr.string({
  key: 'restate.workflow.id',
  cardinality: 'high',
  brief: 'Workflow key of the invocation (omitted for Services/Objects).',
  stability: 'development',
  examples: ['wf-2026-07-01'],
})

/** Original-invocation idempotency key (omitted when none was supplied). */
export const RestateIdempotencyKey = attr.string({
  key: 'restate.idempotency.key',
  cardinality: 'high',
  brief: 'Original-invocation idempotency key (omitted when none was supplied).',
  stability: 'development',
  examples: ['idem-abc123'],
})

/** Boundary failure classification stamped on a handler-exit failure. */
export const RestateErrorClass = attr.enum({
  key: 'restate.error.class',
  values: ['terminal', 'retryable', 'cancelled'],
  briefs: {
    terminal: 'A terminal error (not retried).',
    retryable: 'A retryable error (the invocation will be retried).',
    cancelled: 'The invocation was cancelled.',
  },
  brief: 'Boundary failure classification stamped on a handler-exit failure.',
  stability: 'development',
})

/** Domain error `_tag` of a failing handler (the boundary error classification). */
export const RestateErrorTag = attr.string({
  key: 'restate.error.tag',
  cardinality: 'bounded',
  brief: 'Domain error `_tag` of a failing handler (the boundary error classification).',
  stability: 'development',
  examples: ['ValidationError', 'NotFoundError'],
})

/**
 * Terminal classification of a metered execution — a BOUNDED string, not an enum: the invocation
 * metrics use `success`/`terminal`/`retryable`/`cancelled`, while the `pollLoop` cycle counter uses
 * `ok`/`error`/`stopped`. The two disjoint value domains share one namespaced catalog key.
 */
export const RestateOutcome = attr.string({
  key: 'restate.outcome',
  cardinality: 'bounded',
  brief: 'Terminal classification of a metered execution (invocation outcome or poll-loop cycle).',
  stability: 'development',
  examples: ['success', 'retryable', 'ok', 'stopped'],
})

/** Durable `Restate.run` step name a `restate_durable_steps_total` increment is labelled by. */
export const RestateStep = attr.string({
  key: 'restate.step',
  cardinality: 'bounded',
  brief: 'Durable `Restate.run` step name.',
  stability: 'development',
  examples: ['charge', 'delta'],
})

/** Scheduled `pollLoop` instance name a `restate_poll_loop_cycles_total` increment is labelled by. */
export const RestateName = attr.string({
  key: 'restate.name',
  cardinality: 'bounded',
  brief: 'Scheduled `pollLoop` instance name.',
  stability: 'development',
  examples: ['invoice-poller'],
})

// ---------------------------------------------------------------------------
// metrics (labels reference the SAME catalog attributes as the span bridges; decision 0003).
// The replay-aware baseline metrics (`Metrics.ts`). Their emitted label keys are the namespaced
// catalog keys (a BREAKING wire rename from the old bare `service`/`handler`/… labels, approved).
// ---------------------------------------------------------------------------

/** Millisecond-latency histogram buckets shared by the two duration/wait histograms. */
const RestateDurationBoundariesMs = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 300_000,
] as const

/** `restate_invocations_total` — per-invocation outcome counter, by service/handler/outcome. */
export const InvocationsTotalMetric = metric({
  id: 'metric.restate.invocations_total',
  name: 'restate_invocations_total',
  instrument: 'counter',
  unit: '{invocation}',
  brief: 'Restate invocations by service, handler, and terminal outcome.',
  stability: 'development',
  labels: {
    service: required(RestateService),
    handler: required(RestateHandler),
    outcome: required(RestateOutcome),
  },
})

/** `restate_invocation_duration_ms` — per-attempt wall-clock histogram, by service/handler/outcome. */
export const InvocationDurationMsMetric = metric({
  id: 'metric.restate.invocation_duration_ms',
  name: 'restate_invocation_duration_ms',
  instrument: 'histogram',
  unit: 'ms',
  brief: 'Wall-clock duration of a real invocation attempt (ms), by service/handler/outcome.',
  stability: 'development',
  boundaries: RestateDurationBoundariesMs,
  labels: {
    service: required(RestateService),
    handler: required(RestateHandler),
    outcome: required(RestateOutcome),
  },
})

/** `restate_attempts_total` — per-attempt counter (drives the retry count), by service/handler. */
export const AttemptsTotalMetric = metric({
  id: 'metric.restate.attempts_total',
  name: 'restate_attempts_total',
  instrument: 'counter',
  unit: '{attempt}',
  brief: 'Restate handler attempts by service and handler (drives the retry count).',
  stability: 'development',
  labels: {
    service: required(RestateService),
    handler: required(RestateHandler),
  },
})

/** `restate_durable_steps_total` — durable-step counter (exactly-once across replays), by step. */
export const DurableStepsTotalMetric = metric({
  id: 'metric.restate.durable_steps_total',
  name: 'restate_durable_steps_total',
  instrument: 'counter',
  unit: '{step}',
  brief: 'Durable `Restate.run` steps executed (exactly-once across replays), by step name.',
  stability: 'development',
  labels: {
    step: required(RestateStep),
  },
})

/** `restate_awakeable_wait_ms` — external-completion wait histogram (unlabelled). */
export const AwakeableWaitMsMetric = metric({
  id: 'metric.restate.awakeable_wait_ms',
  name: 'restate_awakeable_wait_ms',
  instrument: 'histogram',
  unit: 'ms',
  brief: 'Wall-clock wait for an awakeable to be externally resolved (ms).',
  stability: 'development',
  boundaries: RestateDurationBoundariesMs,
  labels: {},
})

/** `restate_poll_loop_cycles_total` — scheduled `pollLoop` cycle counter, by name/outcome. */
export const PollLoopCyclesTotalMetric = metric({
  id: 'metric.restate.poll_loop_cycles_total',
  name: 'restate_poll_loop_cycles_total',
  instrument: 'counter',
  unit: '{cycle}',
  brief: 'Scheduled `pollLoop` cycles executed, by loop name and cycle outcome.',
  stability: 'development',
  labels: {
    name: required(RestateName),
    outcome: required(RestateOutcome),
  },
})

// ---------------------------------------------------------------------------
// contract seam (namespace `restate`, derived).
// ---------------------------------------------------------------------------

export default defineOtelContract({
  memberPath: 'packages/@overeng/restate-effect',
  displayName: 'Restate Attributes',
  // The replay-aware baseline metrics are real signals; `restate.outcome`/`restate.step`/
  // `restate.name` reach the catalog as own keys via these metric label refs.
  signals: [
    InvocationsTotalMetric,
    InvocationDurationMsMetric,
    AttemptsTotalMetric,
    DurableStepsTotalMetric,
    AwakeableWaitMsMetric,
    PollLoopCyclesTotalMetric,
  ],
  // The span-identity keys reach telemetry ONLY via a DYNAMIC-NAME bridge span (the hook-owned
  // `attempt <target>` span or the dynamic `restateOperation(name)` span), which has no stable
  // single-signal projection — so they reach the catalog via `docOnlyAttributes` (SC-R13).
  docOnlyAttributes: [
    RestateService,
    RestateHandler,
    RestateObjectKey,
    RestateWorkflowId,
    RestateIdempotencyKey,
    RestateErrorClass,
    RestateErrorTag,
  ],
})
