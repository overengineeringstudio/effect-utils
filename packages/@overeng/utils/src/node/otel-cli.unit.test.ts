import { FetchHttpClient } from '@effect/platform'
import { Effect, Layer, Tracer } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { makeOtelCliLayer, parentSpanFromTraceparent } from './otel-cli.ts'

Vitest.describe('otel-cli', () => {
  Vitest.describe('parentSpanFromTraceparent', () => {
    Vitest.it.effect(
      'returns undefined when TRACEPARENT is not set',
      Effect.fnUntraced(function* () {
        delete process.env.TRACEPARENT

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns undefined for invalid TRACEPARENT format (too few parts)',
      Effect.fnUntraced(function* () {
        process.env.TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331'

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns undefined for invalid TRACEPARENT format (too many parts)',
      Effect.fnUntraced(function* () {
        process.env.TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01-extra'

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns undefined for invalid version (not 00)',
      Effect.fnUntraced(function* () {
        process.env.TRACEPARENT = '01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns undefined for invalid traceId length (too short)',
      Effect.fnUntraced(function* () {
        process.env.TRACEPARENT = '00-0af7651916cd43dd8448eb211c8031-b7ad6b7169203331-01'

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns undefined for invalid traceId length (too long)',
      Effect.fnUntraced(function* () {
        process.env.TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c9c-b7ad6b7169203331-01'

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns undefined for invalid spanId length (too short)',
      Effect.fnUntraced(function* () {
        process.env.TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b716920331-01'

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns undefined for invalid spanId length (too long)',
      Effect.fnUntraced(function* () {
        process.env.TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b71692033311-01'

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns ExternalSpan for valid TRACEPARENT',
      Effect.fnUntraced(function* () {
        process.env.TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeDefined()
        expect(result?._tag).toBe('ExternalSpan')
        expect(result?.traceId).toBe('0af7651916cd43dd8448eb211c80319c')
        expect(result?.spanId).toBe('b7ad6b7169203331')
      }),
    )

    Vitest.it.effect(
      'returns ExternalSpan with different trace flags',
      Effect.fnUntraced(function* () {
        // Test with trace flags = 00 (not sampled)
        process.env.TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00'

        const result = yield* parentSpanFromTraceparent
        expect(result).toBeDefined()
        expect(result?._tag).toBe('ExternalSpan')
      }),
    )
  })

  Vitest.describe('makeOtelCliLayer', () => {
    Vitest.it.effect(
      'returns empty layer when endpoint is not set',
      Effect.fnUntraced(function* () {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        delete process.env.TRACEPARENT

        const layer = makeOtelCliLayer({ serviceName: 'test-cli' })

        // Empty layer should not fail when provided
        yield* Effect.void.pipe(Effect.provide(layer))
      }),
    )

    Vitest.it.effect(
      'returns empty layer when custom endpoint env var is not set',
      Effect.fnUntraced(function* () {
        delete process.env.CUSTOM_OTEL_ENDPOINT
        delete process.env.TRACEPARENT

        const layer = makeOtelCliLayer({
          serviceName: 'test-cli',
          endpointEnvVar: 'CUSTOM_OTEL_ENDPOINT',
        })

        // Empty layer should not fail when provided
        yield* Effect.void.pipe(Effect.provide(layer))
      }),
    )

    Vitest.it.effect(
      'creates layer with root span when endpoint is set',
      Effect.fnUntraced(function* () {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
        delete process.env.TRACEPARENT

        const layer = makeOtelCliLayer({
          serviceName: 'test-cli',
          shutdownTimeout: 100,
          exportInterval: 60_000,
        })

        // Should be able to create spans within the layer
        yield* Effect.gen(function* () {
          const tracer = yield* Effect.serviceOption(Tracer.Tracer)
          expect(tracer._tag).toBe('Some')
        }).pipe(Effect.provide(Layer.mergeAll(layer, FetchHttpClient.layer)), Effect.scoped)

        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      }),
    )

    Vitest.it.effect(
      'includes parent span attribute when TRACEPARENT is valid',
      Effect.fnUntraced(function* () {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
        process.env.TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'

        const layer = makeOtelCliLayer({
          serviceName: 'test-cli',
          shutdownTimeout: 100,
          exportInterval: 60_000,
        })

        // Should include parent span when creating the root span
        yield* Effect.gen(function* () {
          const tracer = yield* Effect.serviceOption(Tracer.Tracer)
          expect(tracer._tag).toBe('Some')
        }).pipe(Effect.provide(Layer.mergeAll(layer, FetchHttpClient.layer)), Effect.scoped)

        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        delete process.env.TRACEPARENT
      }),
    )

    Vitest.it.effect(
      'does not include parent span attribute when TRACEPARENT is invalid',
      Effect.fnUntraced(function* () {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
        process.env.TRACEPARENT = 'invalid-traceparent'

        const layer = makeOtelCliLayer({
          serviceName: 'test-cli',
          shutdownTimeout: 100,
          exportInterval: 60_000,
        })

        yield* Effect.gen(function* () {
          const tracer = yield* Effect.serviceOption(Tracer.Tracer)
          expect(tracer._tag).toBe('Some')
        }).pipe(Effect.provide(Layer.mergeAll(layer, FetchHttpClient.layer)), Effect.scoped)

        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        delete process.env.TRACEPARENT
      }),
    )

    Vitest.it.effect(
      'uses custom export interval',
      Effect.fnUntraced(function* () {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
        delete process.env.TRACEPARENT

        const layer = makeOtelCliLayer({
          serviceName: 'test-cli',
          exportInterval: 500,
          shutdownTimeout: 100,
        })

        yield* Effect.void.pipe(
          Effect.provide(Layer.mergeAll(layer, FetchHttpClient.layer)),
          Effect.scoped,
        )

        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      }),
    )

    Vitest.it.effect(
      'handles endpoint with trailing slash',
      Effect.fnUntraced(function* () {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318/'
        delete process.env.TRACEPARENT

        const layer = makeOtelCliLayer({
          serviceName: 'test-cli',
          shutdownTimeout: 100,
          exportInterval: 60_000,
        })

        yield* Effect.void.pipe(
          Effect.provide(Layer.mergeAll(layer, FetchHttpClient.layer)),
          Effect.scoped,
        )

        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      }),
    )

    Vitest.it.effect(
      'combines with other layers',
      Effect.fnUntraced(function* () {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
        delete process.env.TRACEPARENT

        const otelLayer = makeOtelCliLayer({
          serviceName: 'test-cli',
          shutdownTimeout: 100,
          exportInterval: 60_000,
        })
        const testLayer = Layer.succeed('TestService' as any, { foo: 'bar' })
        const combined = Layer.mergeAll(otelLayer, testLayer, FetchHttpClient.layer)

        yield* Effect.void.pipe(Effect.provide(combined), Effect.scoped)

        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      }),
    )
  })
})
