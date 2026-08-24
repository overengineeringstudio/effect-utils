/**
 * `buck2-tools/evidence` — launcher-free native-evidence decoding and
 * telemetry projection for Buck invocations.
 *
 * Authority: context/buck2/05-evidence-verification/{spec,requirements}.md
 * (BUCK.OBS-R01..R11) and decision 0011 (direct Buck + caller-owned OTel; NO
 * resident observer; a Rust observer is admissible only behind a measured gap
 * and full parity proof — this module deliberately does not build one).
 *
 * Layout:
 * - `model.ts`      — verdicts + typed evidence views (two tiers)
 * - `decoder.ts`    — stable build-report tier (additive-tolerant) + version-bound event-log tier
 * - `verdict.ts`    — PASS / FAIL / NO_VERDICT evaluation (honest degradation)
 * - `sanitize.ts`   — explicit argv/env/host-path export policy (R07)
 * - `telemetry.ts`  — service identity, span/attr vocabulary, bounded metric contracts (R05/R06)
 * - `projection.ts` — evidence → spans/metrics (R04/R08)
 * - `evidence-expect.ts` — otelite round-trip assertion helpers incl. the metric cardinality guard
 */
export * from './model.ts'
export * from './decoder.ts'
export {
  richClaimsAvailable,
  verdictFor,
} from './verdict.ts'
export {
  defaultSanitizationPolicy,
  sanitizeArgv,
  sanitizeEnv,
  sanitizeHostPath,
  type SanitizationPolicy,
} from './sanitize.ts'
export {
  BuckEvidenceServiceBinding,
  BuckInvocationCount,
  BuckInvocationCountBridge,
  BuckInvocationDurationMs,
  BuckInvocationDurationMsBridge,
  mintBuckEvidenceServiceIdentity,
  SanitizedAttrKeys,
  SpanAttrKeys,
  SpanNames,
} from './telemetry.ts'
export {
  cacheClassFor,
  projectInvocation,
  resultClassFor,
  type InvocationObservation,
} from './projection.ts'
export {
  BoundedMetricLabelKeys,
  expectExactlyOneInvocation,
  expectNoRichSpans,
  guardMetricCardinality,
  readSpanLinksFromCapture,
  type CapturedLink,
} from './evidence-expect.ts'
