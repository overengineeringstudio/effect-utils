/**
 * `@overeng/utils-dev/otelite` — a thin, Effect-native wrapper around the
 * `otelite` CLI (the Rust local-OTLP-capture binary in this repo).
 *
 * The CLI's machine-readable JSON output is the single source of truth: this
 * package shells out via `@effect/platform` `Command`, decodes the contract
 * with `Schema`, and exposes it as an `Effect.Service` with tagged errors on
 * the error channel. It never reimplements capture/inspect logic.
 *
 * Requires a `CommandExecutor` + `FileSystem` in context (e.g.
 * `NodeContext.layer` from `@effect/platform-node`) and the `otelite` binary on
 * `PATH`, or an absolute binary path in `OTELITE_BIN`.
 */
export { Otelite } from './Otelite.ts'
export type { CaptureHandle, CaptureOptions, RunOptions, Signal } from './Otelite.ts'
export {
  OteliteSpawnError,
  OteliteChildFailed,
  OteliteCliError,
  OteliteDecodeError,
  cliReasonForExitCode,
} from './errors.ts'
export {
  Summary,
  SpanRow,
  MetricRow,
  LogRow,
  TraceSummary,
  MetricSummary,
  LogSummary,
  Endpoints,
  EndpointsEvent,
  CaptureFiles,
  Counts,
  Child,
} from './schema.ts'
export { OteliteCapture, makeOteliteCaptureLayer, flushCaptureSpans } from './vitest-bridge.ts'
export type { OteliteCaptureLayerOptions } from './vitest-bridge.ts'
export {
  captureEnvTrace,
  captureInProcessTrace,
  captureTest,
  OteliteTestHarness,
} from './test-harness.ts'
export type {
  OteliteEnvOptions,
  OteliteTestHandle,
  OteliteTestHarnessOptions,
  OteliteTraceOptions,
  TraceInspectOptions,
} from './test-harness.ts'
export { attr, expectTrace, spanLabel, TraceExpect, TraceExpectError } from './trace-expect.ts'
export type {
  AttrExpectations,
  AttrMatcher,
  AttrPredicate,
  AttrPrimitive,
  ContractAttributesSelector,
  ContractSpanSelector,
  OtelAttrsContract,
  OtelSpanContract,
  SpanSelector,
} from './trace-expect.ts'
export {
  expectLogs,
  expectMetrics,
  LogExpect,
  metricValue,
  MetricExpect,
  telemetryAttr,
  TelemetryExpectError,
} from './signal-expect.ts'
export type {
  ContractMetricSelector,
  LogSelector,
  MetricSelector,
  MetricValueMatcher,
  OtelMetricLabelsContract,
  TelemetryAttrExpectations,
  TelemetryAttrMatcher,
  TelemetryAttrPredicate,
  TelemetryAttrPrimitive,
} from './signal-expect.ts'
