import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { otlpTracesUrl } from '../node-vitest/Vitest.ts'
import { captureInProcessTrace, OteliteTestHarness } from './test-harness.ts'

describe('OteliteTestHarness', () => {
  it.scopedLive(
    'captures in-process spans through the provided OTLP layer',
    () =>
      Effect.gen(function* () {
        const harness = yield* OteliteTestHarness
        const otel = yield* harness.capture({
          serviceName: 'otelite-test-harness',
          rootSpanName: 'otelite-test-harness.root',
          exportInterval: 50,
        })

        yield* otel.runInProcess(
          Effect.void.pipe(
            Effect.withSpan('otelite-test-harness.child', {
              attributes: { 'span.label': 'child' },
            }),
          ),
        )
        yield* otel.flush

        const trace = yield* otel.trace()
        const root = trace.expectOne({ name: 'otelite-test-harness.root' })
        const child = trace.expectOne({ name: 'otelite-test-harness.child' })
        expect(root.attrs['span.label']).toBe('otelite-test-harness')
        expect(child.service).toBe('otelite-test-harness')
        expect(child.attrs['span.label']).toBe('child')
        expect(trace.expectSameTrace([{ name: root.name }, { name: child.name }])).toBe(
          child.trace_id,
        )
      }).pipe(Effect.provide(OteliteTestHarness.Default)),
    30_000,
  )

  it.scopedLive(
    'returns trace expectations from the ergonomic capture helper',
    () =>
      Effect.gen(function* () {
        const trace = yield* captureInProcessTrace(
          {
            serviceName: 'otelite-test-harness-helper',
            rootSpanName: 'otelite-test-harness-helper.root',
            exportInterval: 50,
          },
          Effect.void.pipe(
            Effect.withSpan('otelite-test-harness-helper.child', {
              attributes: { 'span.label': 'helper' },
            }),
          ),
        )

        expect(
          trace.expectOne({
            name: 'otelite-test-harness-helper.child',
            attrs: { 'span.label': 'helper' },
          }).service,
        ).toBe('otelite-test-harness-helper')
      }),
    30_000,
  )

  it.scopedLive(
    'restores endpoint environment after scoped use',
    () =>
      Effect.gen(function* () {
        const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        const previousService = process.env.OTEL_SERVICE_NAME
        const previousCustomEndpoint = process.env.OTELITE_TEST_ENDPOINT
        const previousCustomService = process.env.OTELITE_TEST_SERVICE
        const previousExtra = process.env.OTELITE_TEST_EXTRA
        const harness = yield* OteliteTestHarness
        const otel = yield* harness.capture({
          serviceName: 'otelite-env-harness',
          exportInterval: 50,
        })

        yield* otel.withEnv(
          Effect.sync(() => {
            expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(otel.capture.endpoints.http)
            expect(process.env.OTEL_SERVICE_NAME).toBe('otelite-env-harness')
          }),
        )

        expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(previousEndpoint)
        expect(process.env.OTEL_SERVICE_NAME).toBe(previousService)

        yield* otel.withEnv(
          Effect.sync(() => {
            expect(process.env.OTELITE_TEST_ENDPOINT).toBe(otel.capture.endpoints.http)
            expect(process.env.OTELITE_TEST_SERVICE).toBe('otelite-env-harness')
            expect(process.env.OTELITE_TEST_EXTRA).toBe('extra')
          }),
          {
            endpointVar: 'OTELITE_TEST_ENDPOINT',
            serviceNameVar: 'OTELITE_TEST_SERVICE',
            extra: { OTELITE_TEST_EXTRA: 'extra' },
          },
        )

        expect(process.env.OTELITE_TEST_ENDPOINT).toBe(previousCustomEndpoint)
        expect(process.env.OTELITE_TEST_SERVICE).toBe(previousCustomService)
        expect(process.env.OTELITE_TEST_EXTRA).toBe(previousExtra)

        const previousPerSignalEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
        yield* otel.withEnv(
          Effect.sync(() => {
            expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(
              otlpTracesUrl(otel.capture.endpoints.http),
            )
          }),
          { endpointVar: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT' },
        )

        expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(previousPerSignalEndpoint)
      }).pipe(Effect.provide(OteliteTestHarness.Default)),
    30_000,
  )
})
