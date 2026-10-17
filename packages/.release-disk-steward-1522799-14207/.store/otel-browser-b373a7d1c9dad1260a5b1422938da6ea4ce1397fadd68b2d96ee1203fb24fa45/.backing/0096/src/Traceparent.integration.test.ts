import { Effect, Layer, Option, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'

import { ServiceIdentity } from '@overeng/otel-contract'
import * as Traceparent from '@overeng/otel-contract/Traceparent'
import { Vitest } from '@overeng/utils-dev/node-vitest'

import * as BrowserTelemetry from './BrowserTelemetry.ts'
import { makeTestPlatform } from './test-platform.ts'

const { describe, expect, it } = Vitest

describe('shared HTTP trace context', () => {
  it.live(
    'Effect HttpClient under BrowserTelemetry sends a W3C traceparent child of the caller span',
    () =>
      Effect.gen(function* () {
        const seen: Array<Record<string, string>> = []
        const receiver = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              port: 0,
              fetch: (request) => {
                seen.push(Object.fromEntries(request.headers.entries()))
                return Response.json({})
              },
            }),
          ),
          (server) => Effect.promise(() => server.stop(true)),
        )
        const caller = yield* Effect.gen(function* () {
          const span = yield* Effect.currentSpan
          const client = yield* HttpClient.HttpClient
          yield* client.get(new URL('/api/actions', receiver.url).toString())
          return span
        }).pipe(
          Effect.withSpan('example.action', { root: true }),
          Effect.provide(FetchHttpClient.layer),
        )
        const parent = Option.getOrThrow(Traceparent.decode(seen[0]?.traceparent))
        expect(parent.traceId).toBe(caller.traceId)
        const ring = (yield* BrowserTelemetry.BrowserTelemetry).ring.getSnapshot().spans
        const clientSpan = ring.find((span) => span.spanId === parent.spanId)
        expect(clientSpan?.parentSpanId).toBe(caller.spanId)
      }).pipe(
        Effect.provide(
          BrowserTelemetry.layer({
            identity: Schema.decodeSync(ServiceIdentity)({
              name: 'test-web',
              namespace: 'test',
              version: '1',
            }),
            environment: 'test',
            endpoint: undefined,
          }).pipe(Layer.provide(makeTestPlatform({ origin: 'https://app.example' }).layer)),
        ),
        Effect.scoped,
      ),
  )
})
