/**
 * @overeng/otel-cli
 *
 * TUI React CLI for OTEL trace inspection and observability stack management.
 */

export { otelCommand } from './cli.ts'

export {
  CollectorError,
  checkCollectorHealth,
  sendTestSpan,
  GrafanaError,
  checkGrafanaHealth,
  getTempoUid,
  listDashboards,
  listDatasources,
  searchTraces,
  type GrafanaDashboard,
  type GrafanaDatasource,
  type GrafanaHealthResponse,
  type TraceSearchResult,
  OtelConfig,
  type OtelConfigData,
  TempoError,
  checkTempoReady,
  getTrace,
  type TempoTraceResponse,
} from './services/mod.ts'

export {
  validateTraceStructure,
  type TraceValidationFinding,
  type TraceValidationResult,
} from './lib/trace-validate.ts'
