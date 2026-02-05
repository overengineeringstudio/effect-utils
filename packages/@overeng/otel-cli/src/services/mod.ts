/**
 * OTEL CLI Services
 *
 * Re-exports all service modules for convenient access.
 */

export {
  CollectorError,
  checkHealth as checkCollectorHealth,
  sendTestSpan,
} from './CollectorClient.ts'
export {
  GrafanaError,
  checkHealth as checkGrafanaHealth,
  getTempoUid,
  listDashboards,
  listDatasources,
  searchTraces,
  type GrafanaDashboard,
  type GrafanaDatasource,
  type GrafanaHealthResponse,
  type TraceSearchResult,
} from './GrafanaClient.ts'
export { OtelConfig, type OtelConfigData } from './OtelConfig.ts'
export {
  TempoError,
  checkReady as checkTempoReady,
  getTrace,
  type TempoTraceResponse,
} from './TempoClient.ts'
