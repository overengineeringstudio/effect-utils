import { Cause, Effect, Exit, Fiber, Schema, Scope } from 'effect'
import * as React from 'react'

import {
  commitBlock,
  counterBlock,
  frameBlock,
  heapBlock,
  jankBlock,
  tileBlock,
  type CanvasBlockSpec,
} from '../canvas/index.ts'
import { MeasureError, MeasureResult, type Measurement } from '../headless/index.ts'
import {
  counterSource,
  counterToken,
  makeInstrumentation,
  makeMeters,
  makeSeries,
  type CounterToken,
  type Instrumentation,
  type FpsValue,
  type Meters,
  type NumberValue,
  type Snapshot,
} from '../index.ts'
import { makeBrowserPlatform } from '../platform/browser.ts'
import {
  MetersProvider,
  reactCommitsSource,
  RenderProfiler,
  type ReactCommit,
} from '../react/index.tsx'
import { frameSource } from '../sources/frame/index.ts'
import { longFramesSource, type LongFrameValue } from '../sources/long-frames/index.ts'
import { heapSource, type HeapMemory } from '../sources/memory/index.ts'

/** Inert real-browser configuration shared by the story's readers. */
export const makeStoryFixture = (): StoryFixture => {
  const clicks = counterToken({ id: 'story.clicks' })
  const commits = counterToken({ id: 'story.commits' })
  const siblingCommits = counterToken({ id: 'story.sibling-commits' })
  const instrumentation = makeInstrumentation({
    counters: [clicks, commits, siblingCommits],
    gauges: [],
  })
  const frames = makeSeries<FpsValue>({
    id: 'story.frames',
    label: 'Frames',
    unit: 'fps',
    capacity: 2600,
  })
  const longFrames = makeSeries<LongFrameValue>({
    id: 'story.long-frames',
    label: 'Long frames',
    unit: 'ms',
    capacity: 200,
  })
  const heap = makeSeries<HeapMemory>({
    id: 'story.heap',
    label: 'JS heap (approximate)',
    unit: 'bytes',
    capacity: 100,
  })
  const clickSeries = makeSeries<NumberValue>({
    id: 'story.clicks',
    label: 'Clicks',
    unit: 'count',
    capacity: 100,
  })
  const commitSeries = makeSeries<ReactCommit>({
    id: 'story.commits',
    label: 'React commits',
    unit: 'ms',
    capacity: 100,
  })
  const siblingSeries = makeSeries<ReactCommit>({
    id: 'story.sibling-commits',
    label: 'Sibling commits',
    unit: 'ms',
    capacity: 100,
  })
  const meters = makeMeters({
    platform: makeBrowserPlatform(),
    sources: [
      frameSource({ id: 'story.frames', series: frames }),
      longFramesSource({ id: 'story.long-frames', series: longFrames }),
      heapSource({ id: 'story.heap', series: heap, everyMs: 250 }),
      counterSource({ id: 'story.clicks', series: clickSeries, instrumentation, token: clicks }),
      reactCommitsSource({
        id: 'story.commits',
        series: commitSeries,
        instrumentation,
        counter: commits,
      }),
      reactCommitsSource({
        id: 'story.sibling-commits',
        series: siblingSeries,
        instrumentation,
        counter: siblingCommits,
      }),
    ],
  })
  const blocks = [
    frameBlock({ id: 'story.frames', series: frames, widthPx: 120 }),
    jankBlock({ id: 'story.long-frames', series: longFrames, widthPx: 120 }),
    heapBlock({ id: 'story.heap', series: heap, widthPx: 160 }),
    counterBlock({ id: 'story.clicks', series: clickSeries, widthPx: 100 }),
    commitBlock({ id: 'story.commits', series: commitSeries, widthPx: 120 }),
  ]
  const perSecond = { _tag: 'Bucket', bucketMs: 1000, buckets: 30 } as const
  const tiles = [
    tileBlock({
      id: 'story.frames',
      series: frames,
      shortLabel: 'fps',
      widthPx: 64,
      aggregation: { ...perSecond, mode: 'Gauge', unit: 'fps' },
      value: (value) => (value.durationMs > 0 ? 1000 / value.durationMs : 0),
      nominalMax: 60,
    }),
    tileBlock({
      id: 'story.long-frames',
      series: longFrames,
      shortLabel: 'lf',
      widthPx: 64,
      aggregation: { ...perSecond, mode: 'Event', unit: 'count/s' },
      value: () => 1,
    }),
    tileBlock({
      id: 'story.heap',
      series: heap,
      shortLabel: 'heap',
      widthPx: 96,
      aggregation: { ...perSecond, mode: 'Gauge', unit: 'bytes' },
      value: (value) => value.usedBytes,
      range: 'auto',
    }),
    tileBlock({
      id: 'story.clicks',
      series: clickSeries,
      shortLabel: 'clicks',
      widthPx: 72,
      aggregation: { ...perSecond, mode: 'Counter', unit: 'count/s' },
      value: (value) => value.value,
    }),
    tileBlock({
      id: 'story.commits',
      series: commitSeries,
      shortLabel: 'commit',
      widthPx: 72,
      aggregation: { ...perSecond, mode: 'Event', unit: 'ms' },
      value: (value) => value.actualDurationMs,
    }),
    tileBlock({
      id: 'story.sibling-commits',
      series: siblingSeries,
      shortLabel: 'sibling',
      widthPx: 80,
      aggregation: { ...perSecond, mode: 'Event', unit: 'ms' },
      value: (value) => value.actualDurationMs,
    }),
  ]
  return { meters, blocks, tiles, instrumentation, clicks, commits, siblingCommits }
}

/** Configuration only; no collection starts until a story scope is mounted. */
export interface StoryFixture {
  readonly meters: Meters
  readonly blocks: readonly CanvasBlockSpec[]
  /** Six single-meter tiles over the same series as `blocks`. */
  readonly tiles: readonly CanvasBlockSpec[]
  readonly instrumentation: Instrumentation
  readonly clicks: CounterToken
  readonly commits: CounterToken
  readonly siblingCommits: CounterToken
}

/** Promise conversion exists only at the explicitly enabled automation boundary. */
export interface StoryTestBridge {
  readonly snapshot: () => Snapshot
  readonly acquireMeasurement: () => Promise<string>
  readonly finishMeasurement: (options: {
    readonly token: string
    readonly settleFrames?: number
  }) => Promise<typeof MeasureResult.Encoded>
}

/** Host-selected DOM boundary, never a global engine or counter transport. */
export interface StoryBridgeHost extends HTMLDivElement {
  metersTestBridge?: StoryTestBridge
}

/** Provider and optional automation registration release their shared leases on unmount. */
export const StoryScope = (props: {
  readonly meters: Meters
  readonly children: React.ReactNode
}) => (
  <MetersProvider meters={props.meters}>
    <ScopedTestBridge meters={props.meters} />
    {props.children}
  </MetersProvider>
)

/** A real user action increments one declared counter and commits only this subtree. */
export const StoryCounter = (props: { readonly fixture: StoryFixture }) => {
  const [count, setCount] = React.useState(0)
  return (
    <RenderProfiler
      instrumentation={props.fixture.instrumentation}
      counter={props.fixture.commits}
      id="story-counter"
    >
      <button
        type="button"
        onClick={() => {
          props.fixture.instrumentation.counter({ token: props.fixture.clicks }).add({ by: 1 })
          setCount((current) => current + 1)
        }}
      >
        Increment counter ({count})
      </button>
    </RenderProfiler>
  )
}

/** An independent subtree makes unwanted commit fanout observable. */
export const StorySibling = (props: { readonly fixture: StoryFixture }) => (
  <RenderProfiler
    instrumentation={props.fixture.instrumentation}
    counter={props.fixture.siblingCommits}
    id="story-sibling"
  >
    <p>Independent sibling</p>
  </RenderProfiler>
)

const ScopedTestBridge = (props: { readonly meters: Meters }) => {
  const attach = React.useCallback(
    (host: HTMLDivElement | null) => {
      if (
        host === null ||
        new URLSearchParams(window.location.search).get('testBridge') !== 'meters-e2e'
      )
        return
      const boundary: StoryBridgeHost = host
      const register = Effect.gen(function* () {
        yield* props.meters.start
        const runPromise = Effect.runPromiseWith(yield* Effect.context<never>())
        const parent = yield* Effect.scope
        const measurements = new Map<string, { measurement: Measurement; scope: Scope.Closeable }>()
        let registered = true
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            boundary.metersTestBridge = {
              snapshot: props.meters.headless.snapshot,
              acquireMeasurement: () =>
                runPromise(
                  Effect.uninterruptible(
                    Effect.gen(function* () {
                      if (registered === false)
                        return yield* new MeasureError({
                          reason: 'ScopeClosed',
                          message: 'Story bridge has been released',
                        })
                      const scope = yield* Scope.fork(parent)
                      const measurement = yield* Scope.provide(
                        props.meters.headless.measurement,
                        scope,
                      ).pipe(
                        Effect.onExit((exit) =>
                          Exit.isFailure(exit) === true ? Scope.close(scope, exit) : Effect.void,
                        ),
                      )
                      const token = crypto.randomUUID()
                      measurements.set(token, { measurement, scope })
                      return token
                    }),
                  ),
                ),
              finishMeasurement: ({ token, settleFrames }) =>
                runPromise(
                  Effect.uninterruptibleMask((restore) =>
                    Effect.gen(function* () {
                      const entry = measurements.get(token)
                      if (entry === undefined)
                        return yield* new MeasureError({
                          reason: 'ScopeClosed',
                          message: 'Bridge token is not active',
                        })
                      const ended = yield* Effect.exit(
                        restore(
                          entry.measurement.end(settleFrames === undefined ? {} : { settleFrames }),
                        ),
                      )
                      if (Exit.isFailure(ended) === true) {
                        const retryable = ended.cause.reasons.some(
                          (reason) =>
                            reason._tag === 'Fail' &&
                            reason.error instanceof MeasureError &&
                            (reason.error.reason === 'InvalidOptions' ||
                              reason.error.reason === 'AlreadyEnded'),
                        )
                        if (retryable === false) {
                          measurements.delete(token)
                          yield* Scope.close(entry.scope, ended)
                        }
                        return yield* Effect.failCause(ended.cause)
                      }
                      measurements.delete(token)
                      yield* Scope.close(entry.scope, Exit.succeed(undefined))
                      return yield* Schema.encodeEffect(MeasureResult)(ended.value)
                    }),
                  ),
                ),
            }
            boundary.dataset.ready = 'true'
            boundary.dispatchEvent(new CustomEvent('meters-test-ready', { bubbles: true }))
          }),
          () =>
            Effect.gen(function* () {
              registered = false
              delete boundary.metersTestBridge
              delete boundary.dataset.ready
              for (const entry of measurements.values())
                yield* Scope.close(entry.scope, Exit.succeed(undefined))
              measurements.clear()
            }),
        )
        return yield* Effect.never
      }).pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause) === true
            ? Effect.void
            : Effect.logError('Story test bridge failed', cause),
        ),
        Effect.scoped,
      )
      const fiber = Effect.runFork(register)
      return () => {
        Effect.runFork(Fiber.interrupt(fiber))
      }
    },
    [props.meters],
  )
  return <div ref={attach} data-testid="meters-test-host" />
}
