/**
 * Shared Vitest `experimental.openTelemetry.sdkPath` module.
 *
 * Emits Vitest's runner-mechanics span tree (`vitest.worker` → `runtime.run` →
 * `test.runner.run.{module,spec,test}` → `test.callback`, plus transform/collect)
 * to the OTLP endpoint. Deliberately minimal: a NodeTracerProvider with a batch
 * OTLP/HTTP exporter and NO auto-instrumentations (those instrument fs/http/etc.
 * inside the test process — noisy and slow).
 *
 * Vitest requires the default export to expose `shutdown()` so it can flush
 * before the process exits. register() installs the global provider + an
 * AsyncLocalStorage context manager, which is what makes Vitest's per-test
 * callback span the ambient `context.active()` span — the seam the
 * Vitest→Effect parent bridge reads (see `withTestCtx`).
 *
 * The exporter honors the standard `OTEL_EXPORTER_OTLP_ENDPOINT` /
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` env vars, so it points at whatever
 * collector the devenv OTEL module configured.
 */
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

const provider = new NodeTracerProvider({
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
})
provider.register()

export default provider
