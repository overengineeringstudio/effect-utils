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
 *
 * Fail-fast teardown budget. Vitest AWAITS this provider's `shutdown()` before
 * terminating each worker, and `shutdown()` drives the BatchSpanProcessor's final
 * flush/export. Against an unreachable or packet-dropping collector that flush
 * blocks on the exporter's connect + retry/backoff, stalling worker teardown for
 * ~60s until the vitest-pool terminate timeout fires and FAILS the whole run —
 * even though every test already passed. Runner OTEL is an observability feature
 * and must never affect test correctness or timing, so we bound teardown at the
 * shutdown seam: `shutdown()` races the real provider shutdown against a short
 * budget, guaranteeing it resolves within the budget regardless of internal
 * exporter retry logic. A reachable localhost collector flushes well inside the
 * budget (spans are tiny), while an unreachable one can no longer hang the worker.
 * The exporter's own per-request timeout is lowered to the same budget so a single
 * attempt cannot exceed it and the background promise settles promptly after the
 * fork is reaped. This is a robustness bound only — it does NOT change WHEN runner
 * OTEL is enabled (that gate stays as specified: VITEST_OTEL_RUNNER).
 */
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

const SHUTDOWN_BUDGET_MS = 2000

const provider = new NodeTracerProvider({
  spanProcessors: [
    new BatchSpanProcessor(new OTLPTraceExporter({ timeoutMillis: SHUTDOWN_BUDGET_MS }), {
      exportTimeoutMillis: SHUTDOWN_BUDGET_MS,
    }),
  ],
})
provider.register()

// Bound shutdown at the seam Vitest awaits. Capture the real shutdown first (the
// override must not call itself), swallow export errors so the race always
// resolves, and unref the budget timer so it never itself keeps the worker's
// event loop alive past a real shutdown.
const realShutdown = provider.shutdown.bind(provider)
provider.shutdown = () =>
  Promise.race([
    realShutdown().catch(() => {}),
    new Promise((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_BUDGET_MS)
      if (typeof timer.unref === 'function') timer.unref()
    }),
  ])

export default provider
