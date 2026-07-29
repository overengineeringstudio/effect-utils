import { Schema } from 'effect'

import {
  OtelAttr,
  OtelAttrs,
  OtelOperation,
  type OtelHistogramDefinition,
} from '@overeng/otel-contract'

import {
  AttemptsTotalMetric,
  AwakeableWaitMsMetric,
  DurableStepsTotalMetric,
  InvocationDurationMsMetric,
  InvocationsTotalMetric,
  PollLoopCyclesTotalMetric,
  RestateErrorClass,
  RestateErrorTag,
  RestateHandler,
  RestateIdempotencyKey,
  RestateObjectKey,
  RestateService,
  RestateWorkflowId,
} from './restate.contract.ts'

const RestateOperationAttributes = Schema.Struct({
  label: OtelAttr.drop(Schema.NonEmptyString),
})

/**
 * Build a named otel-contract operation for an in-handler Restate span; `label`
 * is `drop`ped from the attribute set so it only feeds the `span.label`
 * convention, never a stored span attribute.
 */
export const restateOperation = (name: string) =>
  OtelOperation.define({
    name,
    schema: RestateOperationAttributes,
    label: ({ label }) => label,
  })

/**
 * The handler-entry attempt-span identity attributes (`restate.service`/`handler`
 * and the high-cardinality object/workflow/idempotency keys) the boundary
 * observer stamps onto the hook-owned attempt span (decision 0014).
 */
export const BoundaryAttemptAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    service: RestateService,
    handler: RestateHandler,
    objectKey: Schema.optional(RestateObjectKey),
    workflowId: Schema.optional(RestateWorkflowId),
    idempotencyKey: Schema.optional(RestateIdempotencyKey),
  }),
)

/**
 * The handler-exit failure-classification span attributes (`restate.error.class`
 * = terminal/retryable/cancelled and the domain `restate.error.tag`), stamped
 * only on a failure so error-rate panels can split by classification without
 * re-deriving it.
 */
export const BoundaryOutcomeAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    errorClass: Schema.optional(RestateErrorClass),
    errorTag: Schema.optional(RestateErrorTag),
  }),
)

/**
 * The otel-contract metric definitions backing the replay-aware baseline metrics
 * (decision 0014), DERIVED from the registered seam contract (`./restate.contract.ts`) — the single
 * SSOT for BOTH the Weaver registry projection AND these runtime definitions (SC-R13/R14). The
 * emitted label keys are the namespaced catalog keys (`restate.service`/`restate.handler`/
 * `restate.outcome`/`restate.step`/`restate.name`); the two histogram `.metric`s are narrowed from
 * the DSL's general `OtelMetricDefinition` for the `OtelMetric.effect.histogram` bridge in
 * `Metrics.ts`. The label struct FIELD names stay `service`/`handler`/… so the emit helpers are
 * unchanged; only the encoded wire keys are namespaced.
 */
export const RestateMetrics = {
  invocationsTotal: InvocationsTotalMetric.metric,
  invocationDurationMs: InvocationDurationMsMetric.metric as OtelHistogramDefinition<
    Schema.Codec<unknown, unknown, never, never>
  >,
  attemptsTotal: AttemptsTotalMetric.metric,
  durableStepsTotal: DurableStepsTotalMetric.metric,
  awakeableWaitMs: AwakeableWaitMsMetric.metric as OtelHistogramDefinition<
    Schema.Codec<unknown, unknown, never, never>
  >,
  pollLoopCyclesTotal: PollLoopCyclesTotalMetric.metric,
} as const
