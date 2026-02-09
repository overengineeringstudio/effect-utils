import { Effect } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { makeOtelCliLayer, parentSpanFromTraceparent } from './otel.ts'

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
  })
})
