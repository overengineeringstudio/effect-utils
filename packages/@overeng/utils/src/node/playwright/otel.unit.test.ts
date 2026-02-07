import { FetchHttpClient } from '@effect/platform'
import { Effect, Layer, Schema, Tracer } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import {
  currentParentSpanContextJson,
  makeOtelPlaywrightLayer,
  ParentSpanContextSchema,
  parentSpanFromEnv,
  PW_SPAN_CONTEXT_ENV_VAR,
} from './otel.ts'

Vitest.describe('playwright/otel', () => {
  Vitest.describe('ParentSpanContextSchema', () => {
    Vitest.it.effect(
      'validates valid parent span context',
      Effect.fnUntraced(function* () {
        const validContext = {
          traceId: '0af7651916cd43dd8448eb211c80319c',
          spanId: 'b7ad6b7169203331',
        }

        const result = yield* Schema.decodeUnknown(ParentSpanContextSchema)(validContext)
        expect(result).toEqual(validContext)
      }),
    )

    Vitest.it.effect(
      'accepts any string for traceId and spanId',
      Effect.fnUntraced(function* () {
        const context = {
          traceId: 'any-trace-id',
          spanId: 'any-span-id',
        }

        const result = yield* Schema.decodeUnknown(ParentSpanContextSchema)(context)
        expect(result).toEqual(context)
      }),
    )

    Vitest.it.effect(
      'rejects missing traceId',
      Effect.fnUntraced(function* () {
        const invalidContext = {
          spanId: 'b7ad6b7169203331',
        }

        const result = yield* Schema.decodeUnknown(ParentSpanContextSchema)(invalidContext).pipe(
          Effect.either,
        )
        expect(result._tag).toBe('Left')
      }),
    )

    Vitest.it.effect(
      'rejects missing spanId',
      Effect.fnUntraced(function* () {
        const invalidContext = {
          traceId: '0af7651916cd43dd8448eb211c80319c',
        }

        const result = yield* Schema.decodeUnknown(ParentSpanContextSchema)(invalidContext).pipe(
          Effect.either,
        )
        expect(result._tag).toBe('Left')
      }),
    )
  })

  Vitest.describe('currentParentSpanContextJson', () => {
    Vitest.it.effect(
      'returns undefined when no OTEL span is active',
      Effect.fnUntraced(function* () {
        // Run without any OTEL layer
        const result = yield* currentParentSpanContextJson
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns JSON string with span context when OTEL span is active',
      Effect.fnUntraced(function* () {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'

        const layer = makeOtelPlaywrightLayer({
          serviceName: 'test-pw',
          shutdownTimeout: 100,
          exportInterval: 60_000,
        })

        const result = yield* Effect.withSpan('test-span')(currentParentSpanContextJson).pipe(
          Effect.provide(Layer.mergeAll(layer, FetchHttpClient.layer)),
          Effect.scoped,
        )

        expect(result).toBeDefined()
        if (result) {
          const parsed = yield* Schema.decode(Schema.parseJson(ParentSpanContextSchema))(result)
          expect(parsed).toHaveProperty('traceId')
          expect(parsed).toHaveProperty('spanId')
          expect(typeof parsed.traceId).toBe('string')
          expect(typeof parsed.spanId).toBe('string')
        }

        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      }),
    )

    Vitest.it.effect(
      'returns valid schema-encoded JSON',
      Effect.fnUntraced(function* () {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'

        const layer = makeOtelPlaywrightLayer({
          serviceName: 'test-pw',
          shutdownTimeout: 100,
          exportInterval: 60_000,
        })

        const result = yield* Effect.withSpan('test-span')(currentParentSpanContextJson).pipe(
          Effect.provide(Layer.mergeAll(layer, FetchHttpClient.layer)),
          Effect.scoped,
        )

        expect(result).toBeDefined()
        if (result) {
          // Should be able to decode back to the schema
          const decoded = yield* Schema.decode(Schema.parseJson(ParentSpanContextSchema))(result)
          expect(decoded).toHaveProperty('traceId')
          expect(decoded).toHaveProperty('spanId')
        }

        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      }),
    )
  })

  Vitest.describe('parentSpanFromEnv', () => {
    Vitest.it.effect(
      'returns undefined when env var is not set',
      Effect.fnUntraced(function* () {
        delete process.env[PW_SPAN_CONTEXT_ENV_VAR]

        const result = yield* parentSpanFromEnv()
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns undefined when custom env var is not set',
      Effect.fnUntraced(function* () {
        delete process.env.CUSTOM_SPAN_CONTEXT

        const result = yield* parentSpanFromEnv('CUSTOM_SPAN_CONTEXT')
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'returns ExternalSpan for valid JSON',
      Effect.fnUntraced(function* () {
        const validContext = yield* Schema.encode(Schema.parseJson(ParentSpanContextSchema))({
          traceId: '0af7651916cd43dd8448eb211c80319c',
          spanId: 'b7ad6b7169203331',
        })
        process.env[PW_SPAN_CONTEXT_ENV_VAR] = validContext

        const result = yield* parentSpanFromEnv()
        expect(result).toBeDefined()
        expect(result?.traceId).toBe('0af7651916cd43dd8448eb211c80319c')
        expect(result?.spanId).toBe('b7ad6b7169203331')

        delete process.env[PW_SPAN_CONTEXT_ENV_VAR]
      }),
    )

    Vitest.it.effect(
      'returns ExternalSpan for valid JSON from custom env var',
      Effect.fnUntraced(function* () {
        const validContext = yield* Schema.encode(Schema.parseJson(ParentSpanContextSchema))({
          traceId: 'custom-trace-id',
          spanId: 'custom-span-id',
        })
        process.env.CUSTOM_SPAN_CONTEXT = validContext

        const result = yield* parentSpanFromEnv('CUSTOM_SPAN_CONTEXT')
        expect(result).toBeDefined()
        expect(result?.traceId).toBe('custom-trace-id')
        expect(result?.spanId).toBe('custom-span-id')

        delete process.env.CUSTOM_SPAN_CONTEXT
      }),
    )

    Vitest.it.effect(
      'dies on invalid JSON (orDie semantics)',
      Effect.fnUntraced(function* () {
        process.env[PW_SPAN_CONTEXT_ENV_VAR] = 'not-valid-json'

        const exit = yield* parentSpanFromEnv().pipe(Effect.exit)
        expect(exit._tag).toBe('Failure')

        delete process.env[PW_SPAN_CONTEXT_ENV_VAR]
      }),
    )

    Vitest.it.effect(
      'dies on malformed context (missing traceId)',
      Effect.fnUntraced(function* () {
        const malformedContext = yield* Schema.encode(
          Schema.parseJson(Schema.Struct({ spanId: Schema.String })),
        )({ spanId: 'b7ad6b7169203331' })
        process.env[PW_SPAN_CONTEXT_ENV_VAR] = malformedContext

        const exit = yield* parentSpanFromEnv().pipe(Effect.exit)
        expect(exit._tag).toBe('Failure')

        delete process.env[PW_SPAN_CONTEXT_ENV_VAR]
      }),
    )

    Vitest.it.effect(
      'dies on malformed context (missing spanId)',
      Effect.fnUntraced(function* () {
        const malformedContext = yield* Schema.encode(
          Schema.parseJson(Schema.Struct({ traceId: Schema.String })),
        )({ traceId: '0af7651916cd43dd8448eb211c80319c' })
        process.env[PW_SPAN_CONTEXT_ENV_VAR] = malformedContext

        const exit = yield* parentSpanFromEnv().pipe(Effect.exit)
        expect(exit._tag).toBe('Failure')

        delete process.env[PW_SPAN_CONTEXT_ENV_VAR]
      }),
    )
  })

  Vitest.describe('makeOtelPlaywrightLayer', () => {
    Vitest.it.effect(
      'creates layer without endpoint (no exporter)',
      Effect.fnUntraced(function* () {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        delete process.env[PW_SPAN_CONTEXT_ENV_VAR]

        const layer = makeOtelPlaywrightLayer()

        yield* Effect.gen(function* () {
          const tracer = yield* Effect.serviceOption(Tracer.Tracer)
          expect(tracer._tag).toBe('Some')
        }).pipe(Effect.provide(layer), Effect.scoped)
      }),
    )

    Vitest.it.effect(
      'creates layer with endpoint',
      Effect.fnUntraced(function* () {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
        delete process.env[PW_SPAN_CONTEXT_ENV_VAR]

        const layer = makeOtelPlaywrightLayer({
          shutdownTimeout: 100,
          exportInterval: 60_000,
        })

        yield* Effect.gen(function* () {
          const tracer = yield* Effect.serviceOption(Tracer.Tracer)
          expect(tracer._tag).toBe('Some')
        }).pipe(Effect.provide(Layer.mergeAll(layer, FetchHttpClient.layer)), Effect.scoped)

        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      }),
    )

    Vitest.it.effect(
      'uses custom service name',
      Effect.fnUntraced(function* () {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        delete process.env[PW_SPAN_CONTEXT_ENV_VAR]

        const layer = makeOtelPlaywrightLayer({ serviceName: 'my-custom-service' })

        yield* Effect.void.pipe(Effect.provide(layer), Effect.scoped)
      }),
    )

    Vitest.it.effect(
      'uses custom endpoint env var',
      Effect.fnUntraced(function* () {
        process.env.CUSTOM_OTEL_ENDPOINT = 'http://localhost:4318'
        delete process.env[PW_SPAN_CONTEXT_ENV_VAR]

        const layer = makeOtelPlaywrightLayer({
          endpointEnvVar: 'CUSTOM_OTEL_ENDPOINT',
          shutdownTimeout: 100,
          exportInterval: 60_000,
        })

        yield* Effect.void.pipe(
          Effect.provide(Layer.mergeAll(layer, FetchHttpClient.layer)),
          Effect.scoped,
        )

        delete process.env.CUSTOM_OTEL_ENDPOINT
      }),
    )

    Vitest.it.effect(
      'uses custom parent span env var',
      Effect.fnUntraced(function* () {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        const customParentSpan = yield* Schema.encode(Schema.parseJson(ParentSpanContextSchema))({
          traceId: '0af7651916cd43dd8448eb211c80319c',
          spanId: 'b7ad6b7169203331',
        })
        process.env.CUSTOM_PARENT_SPAN = customParentSpan

        const layer = makeOtelPlaywrightLayer({ parentSpanEnvVar: 'CUSTOM_PARENT_SPAN' })

        yield* Effect.void.pipe(Effect.provide(layer), Effect.scoped)

        delete process.env.CUSTOM_PARENT_SPAN
      }),
    )

    Vitest.it.effect(
      'uses custom export interval',
      Effect.fnUntraced(function* () {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
        delete process.env[PW_SPAN_CONTEXT_ENV_VAR]

        const layer = makeOtelPlaywrightLayer({ exportInterval: 500, shutdownTimeout: 100 })

        yield* Effect.void.pipe(
          Effect.provide(Layer.mergeAll(layer, FetchHttpClient.layer)),
          Effect.scoped,
        )

        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      }),
    )

    Vitest.it.effect(
      'includes parent span when env var is valid',
      Effect.fnUntraced(function* () {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
        const validContext = yield* Schema.encode(Schema.parseJson(ParentSpanContextSchema))({
          traceId: '0af7651916cd43dd8448eb211c80319c',
          spanId: 'b7ad6b7169203331',
        })
        process.env[PW_SPAN_CONTEXT_ENV_VAR] = validContext

        const layer = makeOtelPlaywrightLayer({
          shutdownTimeout: 100,
          exportInterval: 60_000,
        })

        yield* Effect.gen(function* () {
          const tracer = yield* Effect.serviceOption(Tracer.Tracer)
          expect(tracer._tag).toBe('Some')
        }).pipe(Effect.provide(Layer.mergeAll(layer, FetchHttpClient.layer)), Effect.scoped)

        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        delete process.env[PW_SPAN_CONTEXT_ENV_VAR]
      }),
    )

    Vitest.it.effect(
      'does not include parent span when env var is invalid',
      Effect.fnUntraced(function* () {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        process.env[PW_SPAN_CONTEXT_ENV_VAR] = 'invalid-json'

        // Layer creation should fail due to orDie
        const exit = yield* Effect.void.pipe(
          Effect.provide(makeOtelPlaywrightLayer()),
          Effect.scoped,
          Effect.exit,
        )

        expect(exit._tag).toBe('Failure')

        delete process.env[PW_SPAN_CONTEXT_ENV_VAR]
      }),
    )

    Vitest.it.effect(
      'can be combined with other layers',
      Effect.fnUntraced(function* () {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        delete process.env[PW_SPAN_CONTEXT_ENV_VAR]

        const otelLayer = makeOtelPlaywrightLayer()
        const testLayer = Layer.succeed('TestService' as any, { foo: 'bar' })
        const combined = Layer.mergeAll(otelLayer, testLayer)

        yield* Effect.void.pipe(Effect.provide(combined), Effect.scoped)
      }),
    )
  })

  Vitest.describe('integration: currentParentSpanContextJson + parentSpanFromEnv', () => {
    Vitest.it.effect(
      'round-trip span context through env var',
      Effect.fnUntraced(function* () {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
        delete process.env[PW_SPAN_CONTEXT_ENV_VAR]

        const layer = makeOtelPlaywrightLayer({
          serviceName: 'parent-process',
          shutdownTimeout: 100,
          exportInterval: 60_000,
        })

        // Simulate parent process
        const spanContextJson = yield* Effect.withSpan('parent-span')(
          currentParentSpanContextJson,
        ).pipe(Effect.provide(Layer.mergeAll(layer, FetchHttpClient.layer)), Effect.scoped)

        expect(spanContextJson).toBeDefined()

        if (spanContextJson) {
          // Simulate child process reading the env var
          process.env[PW_SPAN_CONTEXT_ENV_VAR] = spanContextJson

          const childLayer = makeOtelPlaywrightLayer({
            serviceName: 'child-process',
            shutdownTimeout: 100,
            exportInterval: 60_000,
          })

          yield* Effect.gen(function* () {
            const tracer = yield* Effect.serviceOption(Tracer.Tracer)
            expect(tracer._tag).toBe('Some')
          }).pipe(Effect.provide(Layer.mergeAll(childLayer, FetchHttpClient.layer)), Effect.scoped)
        }

        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        delete process.env[PW_SPAN_CONTEXT_ENV_VAR]
      }),
    )
  })
})
