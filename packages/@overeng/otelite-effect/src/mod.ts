/**
 * `@overeng/otelite-effect` — a thin, Effect-native wrapper around the
 * `otelite` CLI (the Rust local-OTLP-capture binary in this repo).
 *
 * The CLI's machine-readable JSON output is the single source of truth: this
 * package shells out via `@effect/platform` `Command`, decodes the contract
 * with `Schema`, and exposes it as an `Effect.Service` with tagged errors on
 * the error channel. It never reimplements capture/inspect logic.
 *
 * Requires a `CommandExecutor` + `FileSystem` in context (e.g.
 * `NodeContext.layer` from `@effect/platform-node`) and the `otelite` binary on
 * `PATH`.
 */
export { Otelite } from './Otelite.ts'
export type { RunOptions, Signal } from './Otelite.ts'
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
  CaptureFiles,
  Counts,
  Child,
} from './schema.ts'
