/**
 * Minimal SDK for Vitest's native OpenTelemetry runner spans.
 *
 * Vitest loads this module outside the TypeScript transform pipeline and awaits
 * the default export's `shutdown()`. Registering the provider also installs the
 * AsyncLocalStorage context manager used by the Effect parent bridge.
 */
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

const shutdownBudgetMs = 2_000

export default (() => {
  const provider = new NodeTracerProvider({
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ timeoutMillis: shutdownBudgetMs }), {
        exportTimeoutMillis: shutdownBudgetMs,
      }),
    ],
  })
  provider.register()

  // Runner telemetry must not turn an unavailable collector into a failed or
  // minute-long test teardown. Vitest awaits this seam, so bound it explicitly.
  const realShutdown = provider.shutdown.bind(provider)
  provider.shutdown = () =>
    Promise.race([
      realShutdown().catch(() => {}),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, shutdownBudgetMs)
        timer.unref()
      }),
    ])

  return provider
})()
