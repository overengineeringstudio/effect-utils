import { NodeServices } from '@effect/platform-node'
import { Effect, Layer, Redacted } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'
import { Otelite } from '@overeng/utils-dev/otelite'

import { producerTelemetryLayer } from './otlp-producer.ts'

Vitest.describe('authenticated producer exporters', () => {
  Vitest.it.effect('flushes real trace and log JSON through explicit loopback transport', () =>
    Effect.gen(function* () {
      const collector = yield* Otelite
      const capture = yield* collector.capture({})
      yield* Effect.scoped(
        Effect.log('producer integration record').pipe(
          Effect.withSpan('producer.integration', { root: true }),
          Effect.provide(
            producerTelemetryLayer({
              transport: { kind: 'fabric', endpoint: capture.endpoints.http },
              bearer: Redacted.make('test-only-bearer'),
              serviceName: 'producer-integration',
              build: { machineVersion: '1.0.0+test' },
            }),
          ),
        ),
      )
      expect(
        (yield* capture.inspect({ signal: 'traces', service: 'producer-integration' })).length,
      ).toBeGreaterThan(0)
      expect(
        (yield* capture.inspect({ signal: 'logs', service: 'producer-integration' })).length,
      ).toBeGreaterThan(0)
      expect(
        (yield* capture.inspect({ signal: 'metrics', service: 'producer-integration' })).length,
      ).toBe(0)
    }).pipe(Effect.provide(Layer.provideMerge(Otelite.layer, NodeServices.layer))),
  )
})
