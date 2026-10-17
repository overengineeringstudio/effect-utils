/**
 * Scripted 60 s app-session recording for the meter presentation exploration.
 *
 * The series are deterministic (fixed seed, fixed timestamps) and shaped exactly like the
 * payloads a host would append: message-rate windows, HTTP latency percentiles plus
 * individual failed requests, WebSocket status transitions, React Profiler commits,
 * long-animation-frame entries and per-frame timings. They are scripted, not captured from a
 * live app. Replay goes through the real `makeSeries` / `makeSource` / `makeMeters` APIs with
 * a host-supplied replay clock, so every presentation reads ordinary series histories.
 */
import { Effect } from 'effect'

import {
  makeMeters,
  makeSeries,
  makeSource,
  type FpsValue,
  type Meters,
  type NumberValue,
  type Platform,
  type Sample,
  type Series,
  type SourceRegistration,
  type StatusValue,
} from '@overeng/meters'
import { makeBrowserPlatform } from '@overeng/meters/platform/browser'
import type { ReactCommit } from '@overeng/meters/react'
import type { LongFrameValue } from '@overeng/meters/sources/long-frames'

/** Recording length; the replay loops seamlessly by shifting each pass by this duration. */
export const recordingDurationMs = 60_000

/** The scripted phases, in recording time; used only for the fixture description. */
export const recordingPhases = [
  { label: 'calm', fromMs: 0, toMs: 18_000 },
  { label: 'message burst', fromMs: 18_000, toMs: 27_000 },
  { label: 'WebSocket reconnect + resync', fromMs: 30_200, toMs: 39_500 },
  { label: 'HTTP error spike', fromMs: 44_000, toMs: 50_000 },
  { label: 'calm', fromMs: 50_000, toMs: 60_000 },
] as const

/** Messages received per second over the preceding 500 ms window, split by protocol kind. */
export interface MessageRate {
  readonly _tag: 'MessageRate'
  readonly delta: number
  readonly snapshot: number
  readonly error: number
}

/** HTTP completion percentiles over the preceding 1 s window. */
export interface HttpLatency {
  readonly _tag: 'HttpLatency'
  readonly p50Ms: number
  readonly p95Ms: number
  readonly requests: number
}

/** One failed HTTP request, appended when it completes. */
export interface HttpError {
  readonly _tag: 'HttpError'
  readonly status: number
  readonly route: string
  readonly durationMs: number
}

/** Host-owned series identities; presentations bind blocks to these. */
export const recordingSeries = {
  messages: makeSeries<MessageRate>({
    id: 'api.messages',
    label: 'Live messages',
    unit: 'count/s',
    capacity: 512,
  }),
  httpLatency: makeSeries<HttpLatency>({
    id: 'http.latency',
    label: 'HTTP latency p50/p95',
    unit: 'ms',
    capacity: 256,
  }),
  httpErrors: makeSeries<HttpError>({
    id: 'http.errors',
    label: 'HTTP errors',
    unit: 'count',
    capacity: 256,
  }),
  websocket: makeSeries<StatusValue>({
    id: 'ws.status',
    label: 'WebSocket',
    unit: 'status',
    capacity: 64,
  }),
  commits: makeSeries<ReactCommit>({
    id: 'react.commits',
    label: 'React commit',
    unit: 'ms',
    capacity: 2048,
  }),
  longFrames: makeSeries<LongFrameValue>({
    id: 'longFrames',
    label: 'Long frames',
    unit: 'ms',
    capacity: 256,
  }),
  frames: makeSeries<FpsValue>({
    id: 'frames',
    label: 'Frame rate',
    unit: 'fps',
    capacity: 8192,
  }),
  subscriptions: makeSeries<NumberValue>({
    id: 'api.subscriptions',
    label: 'Live subscriptions',
    unit: 'count',
    capacity: 64,
  }),
} as const

/** Host constant shown next to the subscription count. */
export const subscriptionCap = 64

// Deterministic PRNG so every replay (and screenshot) is byte-identical.
const prng = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = prng(0x5eed_d3b)
const jitter = (spread: number): number => (random() - 0.5) * 2 * spread
const between = (options: {
  readonly atMs: number
  readonly fromMs: number
  readonly toMs: number
}) => options.atMs >= options.fromMs && options.atMs < options.toMs
/** Smooth 0→1→0 envelope peaking at `peakMs`. */
const envelope = (options: {
  readonly atMs: number
  readonly fromMs: number
  readonly peakMs: number
  readonly toMs: number
}): number => {
  if (options.atMs <= options.fromMs || options.atMs >= options.toMs) return 0
  return options.atMs < options.peakMs
    ? (options.atMs - options.fromMs) / (options.peakMs - options.fromMs)
    : 1 - (options.atMs - options.peakMs) / (options.toMs - options.peakMs)
}
const wsDown = { fromMs: 30_200, toMs: 36_100 }
const observed = <TValue>(options: {
  readonly atMs: number
  readonly value: TValue
}): Sample<TValue> => ({
  _tag: 'Value',
  ...options,
})

const recordMessages = (): readonly Sample<MessageRate>[] => {
  const samples: Sample<MessageRate>[] = []
  for (let atMs = 500; atMs <= recordingDurationMs; atMs += 500) {
    const offline = between({ atMs, ...wsDown })
    const burst = envelope({ atMs, fromMs: 18_000, peakMs: 22_000, toMs: 27_000 })
    const resync = envelope({ atMs, fromMs: 36_100, peakMs: 36_600, toMs: 39_500 })
    const errors = between({ atMs, fromMs: 44_000, toMs: 50_000 })
    const delta = offline === true ? 0 : 10 + jitter(4) + burst * (175 + jitter(25)) + resync * 90
    const snapshot =
      offline === true ? 0 : (random() < 0.06 ? 2 : 0) + burst * 4 + resync * (55 + jitter(10))
    const error = offline === true ? 0 : errors === true ? 4 + jitter(3) : 0
    samples.push(
      observed({
        atMs: atMs,
        value: {
          _tag: 'MessageRate',
          delta: Math.max(0, Math.round(delta / 2) * 2),
          snapshot: Math.max(0, Math.round(snapshot / 2) * 2),
          error: Math.max(0, Math.round(error / 2) * 2),
        },
      }),
    )
  }
  return samples
}

const recordHttpLatency = (): readonly Sample<HttpLatency>[] => {
  const samples: Sample<HttpLatency>[] = []
  for (let atMs = 1000; atMs <= recordingDurationMs; atMs += 1000) {
    const burst = envelope({ atMs, fromMs: 18_000, peakMs: 22_000, toMs: 28_000 })
    const spike = envelope({ atMs, fromMs: 43_500, peakMs: 47_000, toMs: 51_000 })
    const p50Ms = 38 + jitter(6) + burst * 18 + spike * (190 + jitter(30))
    const p95Ms = Math.max(
      p50Ms + 20,
      104 + jitter(18) + burst * 140 + spike * (1150 + jitter(120)),
    )
    samples.push(
      observed({
        atMs: atMs,
        value: {
          _tag: 'HttpLatency',
          p50Ms: Math.round(p50Ms),
          p95Ms: Math.round(p95Ms),
          requests: Math.round(6 + jitter(2) + burst * 8 + spike * 14),
        },
      }),
    )
  }
  return samples
}

const recordHttpErrors = (): readonly Sample<HttpError>[] => {
  const samples: Sample<HttpError>[] = [
    observed({
      atMs: 12_430,
      value: {
        _tag: 'HttpError',
        status: 500,
        route: 'POST /api/comments',
        durationMs: 212,
      },
    }),
  ]
  let atMs = 44_150
  while (atMs < 50_000) {
    samples.push(
      observed({
        atMs: Math.round(atMs),
        value: {
          _tag: 'HttpError',
          status: random() < 0.7 ? 503 : 504,
          route: random() < 0.6 ? 'GET /api/projects/:id' : 'GET /api/search',
          durationMs: Math.round(900 + random() * 2100),
        },
      }),
    )
    atMs += 180 + random() * 420
  }
  return samples
}

const recordWebsocket = (): readonly Sample<StatusValue>[] => [
  observed({ atMs: 250, value: { _tag: 'Status', state: 'Connected', label: 'live' } }),
  observed({
    atMs: 30_200,
    value: { _tag: 'Status', state: 'Reconnecting', label: 'reconnecting' },
  }),
  observed({ atMs: 32_000, value: { _tag: 'Status', state: 'Disconnected', label: 'offline' } }),
  observed({
    atMs: 34_500,
    value: { _tag: 'Status', state: 'Reconnecting', label: 'reconnecting' },
  }),
  observed({ atMs: 36_100, value: { _tag: 'Status', state: 'Connected', label: 'live' } }),
]

const recordSubscriptions = (): readonly Sample<NumberValue>[] => [
  observed({ atMs: 250, value: { _tag: 'Number', value: 12 } }),
  observed({ atMs: 36_400, value: { _tag: 'Number', value: 12 } }),
  observed({ atMs: 45_200, value: { _tag: 'Number', value: 14 } }),
  observed({ atMs: 52_800, value: { _tag: 'Number', value: 13 } }),
]

/** Long animation frames: render work caused by the burst and the post-reconnect resync. */
const longFrameEnds = [
  { atMs: 19_620, durationMs: 74 },
  { atMs: 20_910, durationMs: 112 },
  { atMs: 21_850, durationMs: 168 },
  { atMs: 22_340, durationMs: 141 },
  { atMs: 23_480, durationMs: 96 },
  { atMs: 25_060, durationMs: 63 },
  { atMs: 36_720, durationMs: 188 },
  { atMs: 37_310, durationMs: 122 },
  { atMs: 38_150, durationMs: 81 },
  { atMs: 46_200, durationMs: 58 },
]

const recordLongFrames = (): readonly Sample<LongFrameValue>[] =>
  longFrameEnds.map(({ atMs, durationMs }) =>
    observed({
      atMs: atMs,
      value: {
        _tag: 'LoAF',
        startedAtMs: atMs - durationMs,
        durationMs,
        blockingDurationMs: durationMs - 50,
        renderStartMs: atMs - Math.round(durationMs * 0.35),
      },
    }),
  )

const recordCommits = (): readonly Sample<ReactCommit>[] => {
  const samples: Sample<ReactCommit>[] = []
  let commits = 0
  let atMs = 400
  while (atMs <= recordingDurationMs) {
    const offline = between({ atMs, ...wsDown })
    const burst = envelope({ atMs, fromMs: 18_000, peakMs: 22_000, toMs: 27_000 })
    const resync = envelope({ atMs, fromMs: 36_100, peakMs: 36_700, toMs: 39_500 })
    const errors = between({ atMs, fromMs: 44_000, toMs: 50_000 })
    const actualDurationMs =
      2.2 +
      random() * 2 +
      burst * (22 + jitter(9)) +
      resync * (34 + jitter(10)) +
      (errors === true ? 3 : 0)
    commits++
    samples.push(
      observed({
        atMs: Math.round(atMs),
        value: {
          _tag: 'ReactCommit',
          id: 'app-root',
          phase: 'update',
          actualDurationMs: Math.round(actualDurationMs * 10) / 10,
          baseDurationMs: Math.round(actualDurationMs * 14) / 10,
          commitTimeMs: Math.round(atMs),
          commits,
        },
      }),
    )
    const busy = Math.max(burst, resync)
    atMs +=
      offline === true
        ? 2400
        : busy > 0.05
          ? 110 + random() * 60
          : errors === true
            ? 520 + random() * 200
            : 900 + random() * 400
  }
  return samples
}

const recordFrames = (): readonly Sample<FpsValue>[] => {
  const samples: Sample<FpsValue>[] = []
  let atMs = 0
  let captured = 0
  let skipped = 0
  let nextLong = 0
  while (atMs < recordingDurationMs) {
    const pressure = Math.max(
      envelope({ atMs, fromMs: 18_500, peakMs: 22_000, toMs: 26_500 }),
      envelope({ atMs, fromMs: 36_200, peakMs: 36_800, toMs: 39_000 }),
    )
    const longFrame = longFrameEnds[nextLong]
    let durationMs = 16.7 + jitter(0.4) + pressure * (14 + jitter(8))
    if (longFrame !== undefined && atMs + durationMs >= longFrame.atMs - longFrame.durationMs) {
      durationMs = longFrame.durationMs
      nextLong++
    }
    atMs += durationMs
    captured++
    skipped += Math.max(0, Math.round(durationMs / 16.7) - 1)
    samples.push(
      observed({
        atMs: Math.round(atMs * 10) / 10,
        value: {
          _tag: 'Fps',
          durationMs: Math.round(durationMs * 10) / 10,
          skippedFrames: observed({
            atMs: Math.round(atMs * 10) / 10,
            value: { _tag: 'Number', value: skipped },
          }),
          framesCaptured: captured,
          calibration: { _tag: 'Calibrated', bucket: 60 },
        },
      }),
    )
  }
  return samples
}

/** The complete recording, keyed like `recordingSeries`. Computed once per module. */
export const recording = {
  messages: recordMessages(),
  httpLatency: recordHttpLatency(),
  httpErrors: recordHttpErrors(),
  websocket: recordWebsocket(),
  commits: recordCommits(),
  longFrames: recordLongFrames(),
  frames: recordFrames(),
  subscriptions: recordSubscriptions(),
} as const

/** `Live` loops the recording in real time; `Pinned` holds the clock at the scenario's instant. */
export type Playback = 'Live' | 'Pinned'

/**
 * Fixture states for the same series. Only `Recording` supports `Live`; the others pin the
 * clock so the state is deterministic.
 * - `Recording`: clock at the recording end (60 s).
 * - `NoData`: every source is registered but appends nothing before evaluation.
 * - `Stale`: the recording ended 15 s before evaluation and does not loop.
 * - `Disconnected`: clock at 33 s, while the WebSocket is offline (since 32 s).
 */
export type Scenario = 'Recording' | 'NoData' | 'Stale' | 'Disconnected'

const scenarioClock: Record<Scenario, { readonly pinnedAtMs: number; readonly loop: boolean }> = {
  Recording: { pinnedAtMs: recordingDurationMs, loop: true },
  NoData: { pinnedAtMs: recordingDurationMs, loop: false },
  Stale: { pinnedAtMs: recordingDurationMs + 15_000, loop: false },
  Disconnected: { pinnedAtMs: 33_000, loop: false },
}

/**
 * An ordinary event source that appends recorded samples once the replay clock reaches them.
 * With `staleAfterMs`, a finished recording also replays what a source-owned freshness window
 * would have published: one `Stale` observation `staleAfterMs` after the last value, carrying
 * that value as `lastKnown`.
 */
const replaySource = <TValue>(options: {
  readonly series: Series<TValue>
  readonly samples: readonly Sample<TValue>[]
  readonly loop: boolean
  readonly staleAfterMs: number | undefined
}): SourceRegistration =>
  makeSource<TValue>({
    id: options.series.id,
    series: options.series,
    cadence: { _tag: 'Event' },
    start: ({ sink, clock }) =>
      Effect.gen(function* () {
        let pass = 0
        let cursor = 0
        let lastValue: Extract<Sample<TValue>, { readonly _tag: 'Value' }> | undefined
        let staled = false
        const pump = (nowMs: number): void => {
          if (options.samples.length === 0) return
          for (;;) {
            const sample = options.samples[cursor]
            if (sample === undefined) {
              if (options.loop === false) break
              pass++
              cursor = 0
              continue
            }
            const atMs = sample.atMs + pass * recordingDurationMs
            if (atMs > nowMs) return
            const shifted = { ...sample, atMs }
            if (shifted._tag === 'Value') lastValue = shifted
            sink.append({ sample: shifted })
            cursor++
          }
          if (options.staleAfterMs === undefined || lastValue === undefined || staled === true)
            return
          // Never before the newest replayed observation, which the store keeps ordered.
          const newestAtMs = options.samples.at(-1)?.atMs ?? lastValue.atMs
          const staleAtMs = Math.max(newestAtMs, lastValue.atMs + options.staleAfterMs)
          if (staleAtMs > nowMs) return
          staled = true
          sink.append({
            sample: {
              _tag: 'Unavailable',
              atMs: staleAtMs,
              reason: 'Stale',
              lastKnown: { atMs: lastValue.atMs, value: lastValue.value },
            },
          })
        }
        pump(clock.now())
        yield* clock.subscribe({ phase: 'Source', listener: (tick) => pump(tick.atMs) })
      }),
  })

/** Host replay clock: pinned at the scenario instant, or running from the recording end. */
const replayPlatform = (options: {
  readonly playback: Playback
  readonly pinnedAtMs: number
}): Platform => {
  const browser = makeBrowserPlatform()
  if (options.playback === 'Pinned')
    return {
      now: () => options.pinnedAtMs,
      timeOriginMs: browser.timeOriginMs,
      requestFrame: browser.requestFrame,
      cancelFrame: browser.cancelFrame,
      isVisible: browser.isVisible,
      observeVisibility: browser.observeVisibility,
      // No frame loop: every presentation draws once against the pinned clock.
      supportsFrames: () => false,
    }
  const origin = browser.now()
  const now = (): number => options.pinnedAtMs + (browser.now() - origin)
  return {
    now,
    timeOriginMs: browser.timeOriginMs,
    requestFrame: (callback) => browser.requestFrame(() => callback(now())),
    cancelFrame: browser.cancelFrame,
    isVisible: browser.isVisible,
    observeVisibility: browser.observeVisibility,
    ...(browser.supportsFrames === undefined ? {} : { supportsFrames: browser.supportsFrames }),
  }
}

/**
 * An inert replay session; the caller's scope owns `meters.start`. `staleAfterMs` opts every
 * source into replaying a source-owned freshness window, so a finished recording reads `Stale`.
 */
export const makeReplayMeters = (options: {
  readonly playback: Playback
  readonly scenario: Scenario
  readonly staleAfterMs?: number
}): Meters => {
  const { pinnedAtMs, loop } = scenarioClock[options.scenario]
  const empty = options.scenario === 'NoData'
  const source = <TValue>(input: {
    readonly series: Series<TValue>
    readonly samples: readonly Sample<TValue>[]
  }): SourceRegistration =>
    replaySource({
      series: input.series,
      samples: empty === true ? [] : input.samples,
      loop,
      staleAfterMs: options.staleAfterMs,
    })
  return makeMeters({
    platform: replayPlatform({
      // Only the full recording can run live; fixture states stay pinned.
      playback: options.scenario === 'Recording' ? options.playback : 'Pinned',
      pinnedAtMs,
    }),
    sources: [
      source({ series: recordingSeries.messages, samples: recording.messages }),
      source({ series: recordingSeries.httpLatency, samples: recording.httpLatency }),
      source({ series: recordingSeries.httpErrors, samples: recording.httpErrors }),
      source({ series: recordingSeries.websocket, samples: recording.websocket }),
      source({ series: recordingSeries.commits, samples: recording.commits }),
      source({ series: recordingSeries.longFrames, samples: recording.longFrames }),
      source({ series: recordingSeries.frames, samples: recording.frames }),
      source({ series: recordingSeries.subscriptions, samples: recording.subscriptions }),
    ],
  })
}
