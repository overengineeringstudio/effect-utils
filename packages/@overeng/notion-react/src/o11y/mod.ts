/* Convenience barrel re-exporting both o11y adapters. Sub-paths
 * (`/o11y/effect`, `/o11y/otel`) are preferred for tree-shaking. */
export {
  DEFAULT_SERVICE_NAME as DEFAULT_EFFECT_SERVICE_NAME,
  instrumentedSync,
  makeEffectSpanHandler,
  type EffectSpanHandlerConfig,
} from './effect-adapter.ts'
export {
  createOtelEventHandler,
  DEFAULT_SERVICE_NAME as DEFAULT_OTEL_SERVICE_NAME,
  type OtelEventHandlerConfig,
} from './otel-adapter.ts'
