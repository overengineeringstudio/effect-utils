import { Schema } from 'effect'

import { OtelAttr, OtelAttrs, OtelMetric, OtelOperation } from '@overeng/otel-contract'

export const RestateOperationAttributes = Schema.Struct({
  label: OtelAttr.drop(Schema.NonEmptyString),
})

export const restateOperation = (name: string) =>
  OtelOperation.define({
    name,
    schema: RestateOperationAttributes,
    label: ({ label }) => label,
  })

export const BoundaryAttemptAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    service: OtelAttr.string('restate.service', { cardinality: 'bounded' }),
    handler: OtelAttr.string('restate.handler', { cardinality: 'bounded' }),
    objectKey: Schema.optional(OtelAttr.string('restate.object.key', { cardinality: 'high' })),
    workflowId: Schema.optional(OtelAttr.string('restate.workflow.id', { cardinality: 'high' })),
    idempotencyKey: Schema.optional(
      OtelAttr.string('restate.idempotency.key', { cardinality: 'high' }),
    ),
  }),
)

export const BoundaryOutcomeAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    errorClass: Schema.optional(
      OtelAttr.literal('restate.error.class', 'terminal', 'retryable', 'cancelled'),
    ),
    errorTag: Schema.optional(OtelAttr.string('restate.error.tag', { cardinality: 'bounded' })),
  }),
)

const InvocationLabels = Schema.Struct({
  service: OtelAttr.string('service', { cardinality: 'bounded' }),
  handler: OtelAttr.string('handler', { cardinality: 'bounded' }),
  outcome: OtelAttr.literal('outcome', 'success', 'terminal', 'retryable', 'cancelled'),
})

const HandlerLabels = Schema.Struct({
  service: OtelAttr.string('service', { cardinality: 'bounded' }),
  handler: OtelAttr.string('handler', { cardinality: 'bounded' }),
})

const DurableStepLabels = Schema.Struct({
  step: OtelAttr.string('step', { cardinality: 'bounded' }),
})

const NoLabels = Schema.Struct({})

const PollLoopCycleLabels = Schema.Struct({
  name: OtelAttr.string('name', { cardinality: 'bounded' }),
  outcome: OtelAttr.literal('outcome', 'ok', 'error', 'stopped'),
})

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
    labels: NoLabels,
  }),
  pollLoopCyclesTotal: OtelMetric.counter({
    name: 'restate_poll_loop_cycles_total',
    description: 'Scheduled `pollLoop` cycles executed, by loop name and cycle outcome.',
    labels: PollLoopCycleLabels,
  }),
} as const
