import { Cause, Effect, Fiber } from 'effect'
import * as React from 'react'

import {
  commitBlock,
  counterBlock,
  frameBlock,
  heapBlock,
  jankBlock,
  type CanvasBlockSpec,
} from '../canvas/index.ts'
import {
  counterSource,
  counterToken,
  makeInstrumentation,
  makeMeters,
  makeSeries,
  type CounterToken,
  type Instrumentation,
  type FpsValue,
  type MeasureHandle,
  type MeasureResult,
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
  return { meters, blocks, instrumentation, clicks, commits, siblingCommits }
}

/** Configuration only; no collection starts until a story scope is mounted. */
export interface StoryFixture {
  readonly meters: Meters
  readonly blocks: readonly CanvasBlockSpec[]
  readonly instrumentation: Instrumentation
  readonly clicks: CounterToken
  readonly commits: CounterToken
  readonly siblingCommits: CounterToken
}

/** Promise conversion exists only at the explicitly enabled automation boundary. */
export interface StoryTestBridge {
  readonly snapshot: () => Snapshot
  readonly beginMeasure: () => Promise<MeasureHandle>
  readonly endMeasure: (options: {
    readonly handle: MeasureHandle
    readonly settleFrames?: number
  }) => Promise<MeasureResult>
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
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            boundary.metersTestBridge = {
              snapshot: props.meters.headless.snapshot,
              beginMeasure: () => runPromise(props.meters.headless.beginMeasure),
              endMeasure: (options) => runPromise(props.meters.headless.endMeasure(options)),
            }
            boundary.dataset.ready = 'true'
            boundary.dispatchEvent(new CustomEvent('meters-test-ready', { bubbles: true }))
          }),
          () =>
            Effect.sync(() => {
              delete boundary.metersTestBridge
              delete boundary.dataset.ready
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
