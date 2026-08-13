/* oxlint-disable overeng/jsdoc-require-exports -- Contract declarations carry their public documentation in the required brief and stability metadata. */
import { Schema } from 'effect'

/** Schema foundation only: the launcher does not emit OTLP at runtime yet. */
import { OtelAttr } from '@overeng/otel-contract'
import {
  attr,
  defineOtelContract,
  metric,
  operation,
  required,
} from '@overeng/otel-contract/registry'

export const BuckCommand = attr.enum({
  key: 'buck.command',
  values: ['build', 'test', 'run', 'install', 'other'],
  brief: 'Bounded Buck command kind.',
  briefs: {
    build: 'Build.',
    test: 'Test.',
    run: 'Run.',
    install: 'Install.',
    other: 'Another Buck command.',
  },
  stability: 'development',
})
export const BuckStatus = attr.enum({
  key: 'buck.status',
  values: ['success', 'failure'],
  brief: 'Buck invocation status.',
  briefs: { success: 'Succeeded.', failure: 'Failed.' },
  stability: 'development',
})
export const BuckExecutionOutcome = attr.enum({
  key: 'buck.execution.outcome',
  values: [
    'dice_reuse',
    'local_cache_hit',
    'local_cache_miss',
    'remote_cache_hit',
    'remote_cache_miss',
    'local_execution',
    'remote_execution',
    'materialized_only',
    'failed',
    'cancelled',
    'unknown',
  ],
  brief: 'Observed Buck action or graph outcome; DICE reuse is distinct from a cache hit.',
  briefs: Object.fromEntries(
    [
      'dice_reuse',
      'local_cache_hit',
      'local_cache_miss',
      'remote_cache_hit',
      'remote_cache_miss',
      'local_execution',
      'remote_execution',
      'materialized_only',
      'failed',
      'cancelled',
      'unknown',
    ].map((value) => [value, value]),
  ) as Record<string, string>,
  stability: 'development',
})
export const BuckInvocationId = attr.string({
  key: 'buck.invocation.id',
  cardinality: 'high',
  brief: 'Buck invocation UUID; trace-only and never a metric label.',
  stability: 'development',
  examples: ['80c8c3ec-bd2b-44e0-a500-bf108f21ed28'],
})
export const BuckTargetLabel = attr.string({
  key: 'buck.target.label',
  cardinality: 'high',
  brief: 'Configured or unconfigured Buck target label; trace-only.',
  stability: 'development',
  examples: ['root//packages/example:check'],
})
export const DependencyClosureDigest = attr.string({
  key: 'buck.dependency.closure.digest',
  cardinality: 'high',
  brief: 'Content digest of the exact external dependency closure manifest; trace-only.',
  stability: 'development',
  examples: ['sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'],
})

export const BuckInvocation = operation({
  id: 'span.buck.invocation',
  name: 'buck.invocation',
  brief: 'One bounded Buck CLI invocation.',
  stability: 'development',
  attributes: {
    command: required(BuckCommand),
    status: required(BuckStatus),
    invocationId: required(BuckInvocationId),
  },
  labelFields: { label: OtelAttr.drop(Schema.NonEmptyString) },
  label: (value: { command: string }) => value.command,
})

export const BuckActions = metric({
  id: 'metric.buck.actions',
  name: 'buck.actions',
  instrument: 'counter',
  unit: '{action}',
  brief: 'Buck action and graph outcomes.',
  stability: 'development',
  labels: { outcome: required(BuckExecutionOutcome) },
})

export default defineOtelContract({
  memberPath: 'packages/@overeng/buck2-launcher',
  displayName: 'Buck2 launcher',
  signals: [BuckInvocation, BuckActions],
  docOnlyAttributes: [BuckTargetLabel, DependencyClosureDigest],
})
