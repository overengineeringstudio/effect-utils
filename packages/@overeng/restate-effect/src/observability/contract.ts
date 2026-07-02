import { Schema } from 'effect'

import { OtelAttr, OtelAttrs, OtelMetric, OtelOperation } from '@overeng/otel-contract'

import {
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

const InvocationLabels = Schema.Struct({
  service: OtelAttr.string({ key: 'service', metadata: { cardinality: 'bounded' } }),
  handler: OtelAttr.string({ key: 'handler', metadata: { cardinality: 'bounded' } }),
  outcome: OtelAttr.literal('outcome', 'success', 'terminal', 'retryable', 'cancelled'),
})

const HandlerLabels = Schema.Struct({
  service: OtelAttr.string({ key: 'service', metadata: { cardinality: 'bounded' } }),
  handler: OtelAttr.string({ key: 'handler', metadata: { cardinality: 'bounded' } }),
})

const DurableStepLabels = Schema.Struct({
  step: OtelAttr.string({ key: 'step', metadata: { cardinality: 'bounded' } }),
})

const NoLabels = Schema.Struct({})

const PollLoopCycleLabels = Schema.Struct({
  name: OtelAttr.string({ key: 'name', metadata: { cardinality: 'bounded' } }),
  outcome: OtelAttr.literal('outcome', 'ok', 'error', 'stopped'),
})

const RestateDurationMetricBoundariesMs = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 300_000,
] as const

/**
 * The otel-contract metric definitions backing the replay-aware baseline metrics
 * (decision 0014): the names, units, histogram boundaries, and label schemas are
 * declared ONCE here and bridged to Effect `Metric`s in `Metrics.ts`.
 */
export const RestateMetrics = {
  invocationsTotal: OtelMetric.counter({
    name: 'restate_invocations_total',
    description: 'Restate invocations by service, handler, and terminal outcome.',
    labels: InvocationLabels,
  }),
  invocationDurationMs: OtelMetric.histogram({
    name: 'restate_invocation_duration_ms',
    description:
      'Wall-clock duration of a real invocation attempt (ms), by service/handler/outcome.',
    unit: 'ms',
    boundaries: RestateDurationMetricBoundariesMs,
    labels: InvocationLabels,
  }),
  attemptsTotal: OtelMetric.counter({
    name: 'restate_attempts_total',
    description: 'Restate handler attempts by service and handler (drives the retry count).',
    labels: HandlerLabels,
  }),
  durableStepsTotal: OtelMetric.counter({
    name: 'restate_durable_steps_total',
    description:
      'Durable `Restate.run` steps executed (exactly-once across replays), by step name.',
    labels: DurableStepLabels,
  }),
  awakeableWaitMs: OtelMetric.histogram({
    name: 'restate_awakeable_wait_ms',
    description: 'Wall-clock wait for an awakeable to be externally resolved (ms).',
    unit: 'ms',
    boundaries: RestateDurationMetricBoundariesMs,
    labels: NoLabels,
  }),
  pollLoopCyclesTotal: OtelMetric.counter({
    name: 'restate_poll_loop_cycles_total',
    description: 'Scheduled `pollLoop` cycles executed, by loop name and cycle outcome.',
    labels: PollLoopCycleLabels,
  }),
} as const
