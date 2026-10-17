import { Effect, Option, Schema } from 'effect'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import * as Traceparent from './Traceparent.ts'

const { describe, expect, it } = Vitest

const traceId = '0af7651916cd43dd8448eb211c80319c'
const spanId = 'b7ad6b7169203331'
const valid = `00-${traceId}-${spanId}-01`

describe('Traceparent codec', () => {
  it('decodes the remote parent including the sampled flag', () => {
    const sampled = Traceparent.decode(valid)
    expect(Option.getOrThrow(sampled)).toMatchObject({ traceId, spanId, sampled: true })
    expect(Option.getOrThrow(Traceparent.decode(`00-${traceId}-${spanId}-00`)).sampled).toBe(false)
  })

  it.each([
    ['uppercase hex', `00-${traceId.toUpperCase()}-${spanId}-01`],
    ['unknown version', `ff-${traceId}-${spanId}-01`],
    ['all-zero trace id', `00-${'0'.repeat(32)}-${spanId}-01`],
    ['all-zero span id', `00-${traceId}-${'0'.repeat(16)}-01`],
    ['short trace id', `00-${traceId.slice(1)}-${spanId}-01`],
    ['trailing data', `${valid}-extra`],
  ])('rejects %s', (_, value) => {
    expect(Option.isNone(Traceparent.decode(value))).toBe(true)
    expect(Schema.is(Traceparent.Traceparent)(value)).toBe(false)
  })

  it.effect('never encodes the noop span Effect uses when tracing is disabled', () =>
    Effect.gen(function* () {
      const inSpan = yield* Traceparent.current.pipe(Effect.withSpan('op'))
      expect(Option.isSome(inSpan)).toBe(true)
      const disabled = yield* Traceparent.current.pipe(
        Effect.withSpan('op'),
        Effect.withTracerEnabled(false),
      )
      expect(Option.isNone(disabled)).toBe(true)
      expect(Option.isNone(yield* Traceparent.current)).toBe(true)
    }),
  )
})

describe('WebSocket carriers', () => {
  it.effect(
    'upgrade URL: ws scheme + traceparent param that the server decodes to the client span',
    () =>
      Effect.gen(function* () {
        const span = yield* Effect.currentSpan
        const url = yield* Traceparent.wsUrl({
          url: 'https://gw.example/v1/client/collections/stream?x=1',
        })
        expect(url.protocol).toBe('wss:')
        expect(url.searchParams.get('x')).toBe('1')
        const parent = Option.getOrThrow(Traceparent.fromUrl({ url }))
        expect([parent.traceId, parent.spanId, parent.sampled]).toEqual([
          span.traceId,
          span.spanId,
          true,
        ])
      }).pipe(Effect.withSpan('collections.connect')),
  )

  it.effect('upgrade URL outside a span carries no param', () =>
    Effect.gen(function* () {
      const url = yield* Traceparent.wsUrl({ url: 'http://localhost:5173/stream' })
      expect(url.toString()).toBe('ws://localhost:5173/stream')
    }),
  )

  it.effect('subscribe command: field added inside a span, key absent outside', () =>
    Effect.gen(function* () {
      const command = { type: 'subscribe', key: 'agents' } as const
      const outside = yield* Traceparent.withField({ message: command })
      expect('traceparent' in outside).toBe(false)
      const inside = yield* Traceparent.withField({ message: command }).pipe(
        Effect.withSpan('subscription.open'),
      )
      const parent = Option.getOrThrow(Traceparent.fromField({ message: inside }))
      expect(inside.traceparent).toBe(`00-${parent.traceId}-${parent.spanId}-01`)
      expect(Option.isNone(Traceparent.fromField({ message: { traceparent: 'garbage' } }))).toBe(
        true,
      )
    }),
  )

  it.effect('unsampled traces propagate the 00 flag', () =>
    Effect.gen(function* () {
      const value = yield* Traceparent.current.pipe(Effect.withSpan('op', { sampled: false }))
      expect(Option.getOrThrow(value).endsWith('-00')).toBe(true)
    }),
  )
})

describe('HTTP carrier', () => {
  it.effect('raw fetch headers are W3C-only', () =>
    Effect.gen(function* () {
      const headers = yield* Traceparent.headers.pipe(Effect.withSpan('op'))
      expect(Object.keys(headers)).toEqual(['traceparent'])
      expect(Schema.is(Traceparent.Traceparent)(headers.traceparent)).toBe(true)
      expect(yield* Traceparent.headers).toEqual({})
    }),
  )
})
