import { Context, Effect, Exit, Layer, Option, Schema, Scope } from 'effect'

import { ServiceIdentity } from '@overeng/otel-contract'
import { Vitest } from '@overeng/utils-dev/node-vitest'

const { describe, expect, it } = Vitest
import { TestClock } from 'effect/testing'

import type { BrowserPlatform } from '../BrowserPlatform.ts'
import * as BrowserTelemetry from '../BrowserTelemetry.ts'
import { makeTestPlatform } from '../test-platform.ts'
import * as Interactions from './Interactions.ts'
import * as LongFrames from './LongFrames.ts'
import * as WebVitals from './WebVitals.ts'

/** In-memory telemetry (no endpoint): the span ring is the exporter under test. */
const inMemory = (platform: Layer.Layer<BrowserPlatform>) =>
  Layer.mergeAll(Interactions.layer({ settleMs: 500 }), LongFrames.layer, WebVitals.layer).pipe(
    Layer.provideMerge(
      BrowserTelemetry.layer({
        identity: Schema.decodeSync(ServiceIdentity)({
          name: 'test-web',
          namespace: 'test',
          version: '1',
        }),
        environment: 'test',
        endpoint: undefined,
      }),
    ),
    Layer.provide(platform),
  )

const spansNamed = (name: string) =>
  Effect.gen(function* () {
    const telemetry = yield* BrowserTelemetry.BrowserTelemetry
    return telemetry.ring.getSnapshot().spans.filter((span) => span.name === name)
  })

describe('Interactions', () => {
  it.effect('input → commit → paint: span ends at the paint after the first commit', () =>
    Effect.gen(function* () {
      const platform = makeTestPlatform({ origin: 'https://app.example' })
      yield* Effect.gen(function* () {
        const interactions = yield* Interactions.Interactions
        platform.input({ type: 'pointerdown', timeStamp: 100 })
        platform.paint(110) // first paint after the input, before any commit
        platform.setNow(115)
        interactions.markCommit()
        interactions.markCommit()
        platform.paint(130) // paint containing the commit
        yield* TestClock.adjust('500 millis')
        const [span] = yield* spansNamed('browser.interaction')
        expect(span).toMatchObject({
          startMs: 100,
          durationMs: 30,
          label: 'pointerdown other',
          status: 'ok',
        })
        expect(span?.attributes).toMatchObject({
          'browser.interaction.commit_ms': 15,
          'browser.interaction.paint_ms': 30,
          'browser.interaction.commits': 2,
        })
      }).pipe(Effect.provide(inMemory(platform.layer)))
    }),
  )

  it.effect('without a commit the span ends at the paint after the input', () =>
    Effect.gen(function* () {
      const platform = makeTestPlatform({ origin: 'https://app.example' })
      yield* Effect.gen(function* () {
        platform.input({ type: 'keydown', timeStamp: 50, fields: { key: 'k' } })
        platform.input({ type: 'keydown', timeStamp: 51, fields: { key: 'k', repeat: true } }) // auto-repeat: not an interaction
        platform.input({ type: 'keydown', timeStamp: 52, fields: { key: 'Shift' } }) // lone modifier: not an interaction
        platform.paint(62)
        yield* TestClock.adjust('500 millis')
        const spans = yield* spansNamed('browser.interaction')
        expect(spans.map((span) => [span.startMs, span.durationMs])).toEqual([[50, 12]])
        expect(spans[0]?.attributes['browser.interaction.commit_ms']).toBeUndefined()
      }).pipe(Effect.provide(inMemory(platform.layer)))
    }),
  )

  it.effect('withActive parents handler work (and its traceparent) under the interaction', () =>
    Effect.gen(function* () {
      const platform = makeTestPlatform({ origin: 'https://app.example' })
      yield* Effect.gen(function* () {
        const interactions = yield* Interactions.Interactions
        platform.input({ type: 'pointerdown', timeStamp: 10 })
        const interaction = Option.getOrThrow(interactions.active())
        const action = yield* interactions.withActive(
          Effect.currentSpan.pipe(Effect.withSpan('example.action')),
        )
        expect(action.traceId).toBe(interaction.traceId)
        expect(Option.getOrThrow(action.parent).spanId).toBe(interaction.spanId)
        const outside = yield* interactions.withActive(
          Effect.currentSpan.pipe(Effect.withSpan('idle')),
        )
        expect(outside.traceId).toBe(interaction.traceId) // still pending: no paint yet
        platform.paint(20)
        yield* TestClock.adjust('500 millis')
        expect(Option.isNone(interactions.active())).toBe(true)
      }).pipe(Effect.provide(inMemory(platform.layer)))
    }),
  )

  it.effect('scope close ends pending interactions and removes every listener and observer', () =>
    Effect.gen(function* () {
      const platform = makeTestPlatform({ origin: 'https://app.example' })
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(inMemory(platform.layer), scope)
      expect(platform.listenerCount()).toBeGreaterThan(0)
      expect(platform.observerCount()).toBeGreaterThan(0)
      platform.input({ type: 'pointerdown', timeStamp: 10 })
      const telemetry = Context.get(context, BrowserTelemetry.BrowserTelemetry)
      yield* Scope.close(scope, Exit.void)
      expect(telemetry.ring.getSnapshot().spans.map((span) => span.name)).toEqual([
        'browser.interaction',
      ])
      expect(platform.listenerCount()).toBe(0)
      expect(platform.observerCount()).toBe(0)
    }),
  )
})

describe('LongFrames', () => {
  it.effect('long-animation-frame entries become spans with blocking time and the top script', () =>
    Effect.gen(function* () {
      const platform = makeTestPlatform({ origin: 'https://app.example' })
      yield* Effect.gen(function* () {
        platform.emitEntries({
          type: 'long-animation-frame',
          entries: [
            {
              startTime: 1000,
              duration: 120,
              blockingDuration: 70,
              renderStart: 1100,
              scripts: [
                { invoker: 'a', duration: 10, sourceFunctionName: 'small' },
                { invoker: 'b', duration: 90, sourceFunctionName: 'heavyReducer' },
              ],
            },
          ],
        })
        const [frame] = yield* spansNamed('browser.long_frame')
        expect(frame).toMatchObject({ startMs: 1000, durationMs: 120, label: '120ms' })
        expect(frame?.attributes).toMatchObject({
          'browser.long_frame.source': 'long-animation-frame',
          'browser.long_frame.blocking_ms': 70,
          'browser.long_frame.render_ms': 20,
          'browser.long_frame.top_script': 'heavyReducer',
        })
        const telemetry = yield* BrowserTelemetry.BrowserTelemetry
        expect(telemetry.ring.getSnapshot().vitals).toMatchObject({
          longFrames: 1,
          longFrameMaxMs: 120,
        })
      }).pipe(Effect.provide(inMemory(platform.layer)))
    }),
  )

  it.effect('falls back to longtask where long-animation-frame is unsupported', () =>
    Effect.gen(function* () {
      const platform = makeTestPlatform({
        origin: 'https://app.example',
        supportedEntryTypes: ['longtask'],
      })
      yield* Effect.gen(function* () {
        platform.emitEntries({ type: 'longtask', entries: [{ startTime: 5, duration: 60 }] })
        const [frame] = yield* spansNamed('browser.long_frame')
        expect(frame?.attributes['browser.long_frame.source']).toBe('longtask')
        expect(frame?.attributes['browser.long_frame.blocking_ms']).toBeUndefined()
      }).pipe(Effect.provide(inMemory(platform.layer)))
    }),
  )
})

describe('WebVitals', () => {
  it('INP is the worst interaction below 50, then skips one per 50', () => {
    expect(WebVitals.inpOf([])).toBeUndefined()
    expect(WebVitals.inpOf([40, 300, 120])).toBe(300)
    const hundred = Array.from({ length: 100 }, (_, index) => index + 1)
    expect(WebVitals.inpOf(hundred)).toBe(98)
  })

  it.effect('CLS takes the largest session window and ignores input-driven shifts', () =>
    Effect.gen(function* () {
      const platform = makeTestPlatform({ origin: 'https://app.example' })
      yield* Effect.gen(function* () {
        platform.emitEntries({
          type: 'layout-shift',
          entries: [
            { startTime: 0, value: 0.1, hadRecentInput: false },
            { startTime: 500, value: 0.1, hadRecentInput: false },
            { startTime: 700, value: 0.5, hadRecentInput: true },
            { startTime: 3000, value: 0.15, hadRecentInput: false },
          ],
        })
        platform.emitEntries({
          type: 'largest-contentful-paint',
          entries: [{ startTime: 400 }, { startTime: 900 }],
        })
        platform.emitEntries({
          type: 'event',
          entries: [
            { interactionId: 1, duration: 40 },
            { interactionId: 1, duration: 64 },
            { interactionId: 0, duration: 500 },
          ],
        })
        const telemetry = yield* BrowserTelemetry.BrowserTelemetry
        expect(telemetry.ring.getSnapshot().vitals).toMatchObject({
          cls: 0.2,
          lcpMs: 900,
          inpMs: 64,
        })
      }).pipe(Effect.provide(inMemory(platform.layer)))
    }),
  )
})
