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
 * ATTRS-ONLY MEMBER (no `signals`). Every `restate.*` attribute reaches telemetry through a
 * DYNAMIC-NAME bridge span the Restate SDK hook owns (`attempt <target>`, stamped by the boundary
 * observer) or the dynamic in-handler `restateOperation(name)` span — neither has a stable
 * single-signal registry projection (SC-DQ5, mirroring genie's `cli.mode` and megarepo's dynamic
 * bridges). So the catalog keys reach the registry via `docOnlyAttributes` for completeness
 * (SC-R13), and the runtime bridges stay legacy inline in `contract.ts`, rebuilt from the IMPORTED
 * catalog schemas below (identical encode — proven by the colocated equivalence property test).
 *
 * METRICS DEFERRED (bare-label flag, NOT migrated). restate-effect's replay-aware baseline metrics
 * (`restate_invocations_total`, …, `Metrics.ts`) carry UNPREFIXED Prometheus-style label keys
 * (`service`, `handler`, `outcome`, `step`, `name`). Routing them through the registry `metric(...)`
 * DSL would rename the emitted label keys to their namespaced catalog keys (`restate.service`, …) —
 * a BREAKING wire rename (the same move megarepo made for `repo_concurrency`, with sign-off). Per
 * the behavior-preserving constraint (SC-R14, "do NOT silently rename"), the metrics stay as raw
 * `OtelMetric` definitions in `./contract.ts` and are FLAGGED for a follow-up sign-off decision.
 */
import { attr, defineOtelContract } from '@overeng/otel-contract/registry'

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

// ---------------------------------------------------------------------------
// contract seam (namespace `restate`, derived). Attrs-only member — see file docstring.
// ---------------------------------------------------------------------------

export default defineOtelContract({
  memberPath: 'packages/@overeng/restate-effect',
  displayName: 'Restate Attributes',
  // No `signals`: every restate.* key reaches telemetry via a DYNAMIC-NAME bridge span (the
  // hook-owned `attempt <target>` span or the dynamic `restateOperation(name)` span), which has no
  // stable single-signal projection. Keys reach the catalog via `docOnlyAttributes` (SC-R13).
  signals: [],
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
