/**
 * Telemetry contract for Buck evidence projection — span names, attribute
 * keys, bounded metric vocabulary, and the dedicated service identity
 * (BUCK.OBS-R05 / BUCK.OBS-R06).
 *
 * Decisions recorded here (lane-local authority, see module jsdoc in
 * `projection.ts`):
 *
 * - **Service identity** is minted through `@overeng/otel-contract`'s
 *   `serviceIdentityFromBinding`: project `effect-utils`, role `buck2`, so
 *   `service.name = "effect-utils-buck2"` is validated by the shared naming
 *   law at the composition root, never hand-assembled.
 * - **Metric labels are exactly the four bounded dimensions**
 *   (`operation-kind`, `result-class`, `platform-class`, `cache-class`),
 *   authored as schema literals so any wider value fails at authoring time.
 *   Invocation IDs, digests, paths, labels, and evidence URLs have no label
 *   slot at all; the runtime negative scan lives in `evidence-expect.ts`.
 */
import type { Effect } from 'effect'
import type { ParseResult } from 'effect'
import { Schema } from 'effect'

import {
  OtelAttr,
  OtelMetric,
  serviceIdentityFromBinding,
  type ServiceIdentity,
} from '@overeng/otel-contract'

// ---------------------------------------------------------------------------
// Service identity (minted via @overeng/otel-contract)
// ---------------------------------------------------------------------------

/** The binding values this lane contributes to the private fleet config shape. */
export const BuckEvidenceServiceBinding = {
  namespace: 'overeng-build',
  project: 'effect-utils',
  role: 'buck2',
  version: '0.1.0',
} as const

/**
 * Mint the validated {@link ServiceIdentity}. Exposed as a function (not a
 * top-level constant) so a malformed binding fails loudly at the composition
 * root instead of at import time.
 */
export const mintBuckEvidenceServiceIdentity = (): Effect.Effect<
  ServiceIdentity,
  ParseResult.ParseError
> => serviceIdentityFromBinding(BuckEvidenceServiceBinding)

// ---------------------------------------------------------------------------
// Span names + attribute keys (spec "Signals")
// ---------------------------------------------------------------------------

/** Canonical span names for the evidence trace shape (spec "Ownership and Trace Shape"). */
export const SpanNames = {
  /** One rich-tier action span per admitted event-log action record. */
  action: 'buck.action',
  /** Post-exit normalization/decoding of native evidence. */
  evidenceDecode: 'buck.evidence.decode',
  /** The independent Nix import span; LINKS to the invocation span. */
  import: 'nix.import',
  /** The invocation span itself (CLIENT kind, below the control-plane task span). */
  invocation: 'buck.invocation',
} as const

/**
 * Span attribute keys. Span-level attributes may carry sanitized
 * high-cardinality correlation data (invocation ID, digests, evidence
 * locations) — they are correlation attributes, never trace identity.
 */
export const SpanAttrKeys = {
  cacheClass: 'buck.action.cache_class',
  commandKind: 'buck.command.kind',
  digest: 'buck.product.digest',
  envCount: 'buck.env.count',
  eventLogPath: 'buck.evidence.event_log.path',
  buildReportPath: 'buck.evidence.build_report.path',
  invocationId: 'buck.invocation.id',
  linkSpanId: 'evidence.link.span_id',
  linkTraceId: 'evidence.link.trace_id',
  platformClass: 'buck.platform.class',
  productLabel: 'buck.product.label',
  resultClass: 'buck.result.class',
  target: 'buck.target.label',
  verdict: 'buck.evidence.verdict',
} as const

/** Attribute keys reserved for the sanitized argv/env capture on spans. */
export const SanitizedAttrKeys = {
  argv: 'buck.argv.sanitized_json',
} as const

// ---------------------------------------------------------------------------
// Bounded metric vocabulary (BUCK.OBS-R06)
// ---------------------------------------------------------------------------

const MetricLabels = Schema.Struct({
  'cache-class': OtelAttr.literal('cache-class', 'hit', 'miss', 'partial', 'unknown'),
  'operation-kind': OtelAttr.literal('operation-kind', 'build', 'test', 'run'),
  'platform-class': OtelAttr.literal(
    'platform-class',
    'linux-x64',
    'macos-arm64',
    'macos-x64',
    'other',
  ),
  'result-class': OtelAttr.literal('result-class', 'success', 'failure', 'canceled', 'no-verdict'),
})

/** The bounded metric label vocabulary — exactly these four keys exist. */
export type BuckMetricLabels = Schema.Schema.Type<typeof MetricLabels>

/** Invocation count by bounded class. No other label dimension exists. */
export const BuckInvocationCount = OtelMetric.counter({
  name: 'buck2_invocations_total',
  description:
    'Buck invocations observed through native evidence, labelled only by bounded operation/result/platform/cache classes.',
  labels: MetricLabels,
})

/** Invocation duration histogram (ms) by the same bounded classes. */
export const BuckInvocationDurationMs = OtelMetric.histogram({
  name: 'buck2_invocation_duration_ms',
  description: 'Wall-clock duration of decoded Buck invocations, in milliseconds.',
  labels: MetricLabels,
})

/** Runtime bridge for the invocation counter; trusted variant dies on encode failure. */
export const BuckInvocationCountBridge = OtelMetric.effect.counter(BuckInvocationCount)
/** Runtime bridge for the duration histogram; trusted variant dies on encode failure. */
export const BuckInvocationDurationMsBridge = OtelMetric.effect.histogram(BuckInvocationDurationMs)
