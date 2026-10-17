/**
 * Live meter presentation exploration (Variants A/B/C).
 *
 * Request: turn the devbar's numeric API readouts into live meters like the FPS meter —
 * live messages (msg/s by kind), HTTP latency p50/p95 with error ticks, WebSocket health
 * with reconnect markers, and React commit cost so message bursts can be tied to jank.
 * `subs n/cap` stays text.
 *
 * - A: every meter is a ~64 px canvas strip segment (existing `makeCanvasStrip` + blocks);
 *   narrow bars drop low-priority segments through the Devbar's `fitSegments`.
 * - B: compact DOM values with a tiny trend per segment, plus ONE linked "Timeline" panel in
 *   which every meter shares one time axis and one crosshair.
 * - C: A's strips in the bar plus B's linked panel.
 *
 * Data: `recording.ts` replays a scripted 60 s session (calm → burst → reconnect → error
 * spike) through real meters series/sources/session APIs. Exploration-only presentation code
 * (status band, error ticks, sparkline, linked panel) lives here, not in package exports.
 */
import type { Meta, StoryObj } from '@storybook/react'
import * as stylex from '@stylexjs/stylex'
import { Effect, Fiber, type Scope } from 'effect'
import * as React from 'react'

import type { Meters, Sample, Series, SeriesStore, SeriesView, StatusValue } from '@overeng/meters'
import {
  block,
  commitBlock,
  darkMeterTheme,
  fitText,
  formatMeterValue,
  frameBlock,
  historyX,
  jankBlock,
  layoutBlockText,
  lightMeterTheme,
  makeCanvasStrip,
  makeStripView,
  numericBlock,
  type BlockEvidence,
  type BlockReader,
  type CanvasBlockSpec,
  type MeterTheme,
  type Rect,
} from '@overeng/meters/canvas'
import { MetersPanel } from '@overeng/meters/react'

import { Devbar, type DevbarPanel, type DevbarSegment } from '../../Devbar.tsx'
import { devbarTokens } from '../../tokens.stylex.ts'
import {
  makeReplayMeters,
  recordingDurationMs,
  recordingPhases,
  recordingSeries,
  subscriptionCap,
  type HttpError,
  type Playback,
  type Scenario,
} from './recording.ts'

// ---------------------------------------------------------------------------------------------
// Variant vocabulary (stable IDs for feedback: "A at 900", "B timeline", …)
// ---------------------------------------------------------------------------------------------

type VariantId = 'A' | 'B' | 'C'
type WidthId = 'W1440' | 'W900' | 'W600'

/** UI Design gate verdicts (stories only; the Timeline primitives stay here until a pick). */
const variants: readonly {
  readonly id: VariantId
  readonly verdict: string
  readonly description: string
}[] = [
  {
    id: 'A',
    verdict: 'GO with fixes',
    description:
      'Compact canvas strips with a short label and value drawn in the bar; low-priority strips overflow into +N on narrow bars.',
  },
  {
    id: 'B',
    verdict: 'NO-GO (UI Design gate)',
    description:
      'Kept unchanged for comparison: compact text values with a tiny trend; one linked Timeline panel aligns msg, HTTP, WS, commit, long frames and FPS on one time axis.',
  },
  {
    id: 'C',
    verdict: 'GO with fixes (recommended)',
    description:
      'A’s canvas strips in the bar; activating any strip opens the linked Timeline panel and highlights its row.',
  },
]
const widths: readonly {
  readonly id: WidthId
  readonly px: number
  readonly description: string
}[] = [
  { id: 'W1440', px: 1440, description: 'Desktop 1440 px' },
  { id: 'W900', px: 900, description: 'Narrow 900 px' },
  { id: 'W600', px: 600, description: 'Extra narrow 600 px (shows fitSegments overflow for A/C)' },
]
const playbacks: readonly { readonly id: Playback; readonly description: string }[] = [
  {
    id: 'Pinned',
    description: 'Clock pinned at the recording end (deterministic, screenshot-safe)',
  },
  { id: 'Live', description: 'Recording loops in real time through the replay clock' },
]
const scenarios: readonly { readonly id: Scenario; readonly description: string }[] = [
  { id: 'Recording', description: 'Full scripted recording, evaluated at 60 s' },
  { id: 'NoData', description: 'Sources registered; no samples before evaluation' },
  {
    id: 'Stale',
    description: 'Recording ended 15 s before evaluation (evaluated at 75 s, no loop)',
  },
  {
    id: 'Disconnected',
    description: 'Evaluated at 33 s: WebSocket offline since 32 s',
  },
]

/** One history horizon for every presentation so strips and the panel line up. */
const historyMs = recordingDurationMs

// ---------------------------------------------------------------------------------------------
// Exploration-only canvas blocks composed from public meters builders
// ---------------------------------------------------------------------------------------------

/** Mirrors the built-in numeric block's chart inset so overlays land on the same pixels. */
const chartRect = (rect: Rect): Rect => ({
  x: rect.x + 4,
  y: rect.y + 18,
  width: rect.width - 8,
  height: Math.max(1, rect.height - 20),
})

const statusColor = (options: {
  readonly state: StatusValue['state']
  readonly theme: MeterTheme
}): string =>
  options.state === 'Connected' || options.state === 'Synced'
    ? options.theme.normal
    : options.state === 'Disconnected' || options.state === 'Error'
      ? options.theme.danger
      : options.theme.warning

const compactStatus = (state: StatusValue['state']): string =>
  state === 'Connected' || state === 'Synced'
    ? 'live'
    : state === 'Disconnected' || state === 'Error'
      ? 'offline'
      : 'retry'

/** Status band (state colour over time) plus a marker at every recovery to Connected. */
const paintStatusBand = (options: {
  readonly ctx: CanvasRenderingContext2D
  readonly chart: Rect
  readonly history: SeriesView<StatusValue>
  readonly nowMs: number
  readonly theme: MeterTheme
  readonly historyMs: number
}): number => {
  const { ctx, chart, history, nowMs, theme, historyMs: horizonMs } = options
  let reconnects = 0
  let previous: StatusValue['state'] | undefined
  for (let index = 0; index < history.length; index++) {
    const sample = history.at(index)
    if (sample?._tag !== 'Value') {
      previous = undefined
      continue
    }
    const endMs = history.at(index + 1)?.atMs ?? nowMs
    const from = Math.max(
      chart.x,
      historyX({ atMs: sample.atMs, nowMs, historyMs: horizonMs, rect: chart }),
    )
    const to = Math.min(
      chart.x + chart.width,
      historyX({ atMs: endMs, nowMs, historyMs: horizonMs, rect: chart }),
    )
    if (to > from) {
      ctx.fillStyle = statusColor({ state: sample.value.state, theme })
      ctx.globalAlpha = 0.3
      ctx.fillRect(from, chart.y, to - from, chart.height)
      ctx.globalAlpha = 1
      ctx.fillRect(from, chart.y + chart.height - 2, to - from, 2)
    }
    const recovered =
      sample.value.state === 'Connected' && previous !== undefined && previous !== 'Connected'
    if (recovered === true && sample.atMs >= nowMs - horizonMs) {
      reconnects++
      if (from >= chart.x) {
        ctx.fillStyle = theme.foreground
        ctx.fillRect(Math.round(from), chart.y, 1, chart.height)
        ctx.beginPath()
        ctx.moveTo(Math.round(from) - 3, chart.y)
        ctx.lineTo(Math.round(from) + 4, chart.y)
        ctx.lineTo(Math.round(from) + 0.5, chart.y + 4)
        ctx.fill()
      }
    }
    previous = sample.value.state
  }
  return reconnects
}

/** WebSocket health over time: live/retry/offline band with reconnect markers. */
const statusBlock = (options: {
  readonly id: string
  readonly series: Series<StatusValue>
  readonly shortLabel: string
  readonly widthPx: number
}): CanvasBlockSpec => {
  const text = (input: {
    readonly history: SeriesView<StatusValue>
    readonly compact: boolean
  }): string => {
    const latest = input.history.latest
    if (latest === undefined) return 'n/a (NoSamples)'
    if (latest._tag === 'Unavailable') return `n/a (${latest.reason})`
    if (latest._tag === 'Gap') return `n/a (${latest.reason} gap)`
    return input.compact === true ? compactStatus(latest.value.state) : latest.value.label
  }
  return block({
    id: options.id,
    series: options.series,
    shortLabel: options.shortLabel,
    widthPx: options.widthPx,
    describe: ({ history }) => text({ history, compact: false }),
    draw: ({ ctx, rect, history, nowMs, historyMs: horizonMs, theme }) => {
      ctx.save()
      ctx.beginPath()
      ctx.rect(rect.x, rect.y, rect.width, rect.height)
      ctx.clip()
      ctx.fillStyle = theme.background
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
      const reconnects = paintStatusBand({
        ctx,
        chart: chartRect(rect),
        history,
        nowMs,
        theme,
        historyMs: horizonMs,
      })
      ctx.font = theme.font
      ctx.textBaseline = 'top'
      const value = text({ history, compact: false })
      const header = layoutBlockText({
        rect,
        label: options.series.label,
        shortLabel: options.shortLabel,
        value: reconnects > 0 ? `${value} · ${reconnects}↻` : value,
        compactValue: text({ history, compact: true }),
        numberValue: text({ history, compact: true }),
        measure: (run) => ctx.measureText(run).width,
      })
      ctx.fillStyle = theme.muted
      if (header.label !== undefined) ctx.fillText(header.label.text, header.label.x, rect.y + 3)
      ctx.fillStyle = theme.foreground
      if (header.value !== undefined) ctx.fillText(header.value.text, header.value.x, rect.y + 3)
      ctx.restore()
    },
  })
}

const freezeView = <TValue,>(view: SeriesView<TValue>): SeriesView<TValue> => {
  const samples: (Sample<TValue> | undefined)[] = []
  for (let index = 0; index < view.length; index++) samples.push(view.at(index))
  return {
    capacity: view.capacity,
    length: view.length,
    oldestAtMs: view.oldestAtMs,
    newestAtMs: view.newestAtMs,
    overflowCount: view.overflowCount,
    firstRetainedSequence: view.firstRetainedSequence,
    nextSequence: view.nextSequence,
    revision: view.revision,
    latest: view.latest,
    at: (index) => samples[index],
  }
}

/**
 * Compose any block with full-height danger ticks for an event series (failed requests, or
 * message windows that carried error frames). Stacked bars cannot show rare small counts.
 */
const withEventTicks = <TTick,>(options: {
  readonly spec: CanvasBlockSpec
  readonly ticks: Series<TTick>
  readonly when?: (value: TTick) => boolean
}): CanvasBlockSpec => {
  const bind = ({
    inner,
    ticks,
  }: {
    readonly inner: BlockReader
    readonly ticks: SeriesView<TTick>
  }): BlockReader => ({
    revision: () => inner.revision() + ticks.revision,
    describe: inner.describe,
    evidence: inner.evidence,
    draw: (input) => {
      inner.draw(input)
      const chart = chartRect(input.rect)
      const { ctx, nowMs, theme } = input
      ctx.save()
      ctx.beginPath()
      ctx.rect(chart.x, chart.y, chart.width, chart.height)
      ctx.clip()
      ctx.fillStyle = theme.danger
      for (let index = 0; index < ticks.length; index++) {
        const sample = ticks.at(index)
        if (sample?._tag !== 'Value' || sample.atMs < nowMs - input.historyMs) continue
        if (options.when !== undefined && options.when(sample.value) === false) continue
        const x = Math.round(
          historyX({ atMs: sample.atMs, nowMs, historyMs: input.historyMs, rect: chart }),
        )
        ctx.fillRect(x - 1, chart.y, 2, chart.height)
      }
      ctx.restore()
    },
    snapshot: () => bind({ inner: inner.snapshot(), ticks: freezeView(ticks) }),
  })
  return {
    ...options.spec,
    read: (store) =>
      bind({ inner: options.spec.read(store), ticks: store.read({ series: options.ticks }) }),
  }
}

type DrawFrame = Parameters<BlockReader['draw']>[0]

/** Wrap only a block's drawing; text, evidence and snapshots stay the inner block's. */
const decorate = (options: {
  readonly spec: CanvasBlockSpec
  readonly draw: (input: { readonly inner: BlockReader; readonly frame: DrawFrame }) => void
}): CanvasBlockSpec => {
  const bind = (inner: BlockReader): BlockReader => ({
    revision: inner.revision,
    describe: inner.describe,
    evidence: inner.evidence,
    draw: (frame) => options.draw({ inner, frame }),
    snapshot: () => bind(inner.snapshot()),
  })
  return { ...options.spec, read: (store) => bind(options.spec.read(store)) }
}

/** Paint the p50→p95 tail in the neutral gap colour so error ticks carry the alarm. */
const withQuietTail = (spec: CanvasBlockSpec): CanvasBlockSpec =>
  decorate({
    spec,
    draw: ({ inner, frame }) =>
      inner.draw({ ...frame, theme: { ...frame.theme, warning: frame.theme.gap } }),
  })

/** Header band height the built-in blocks reserve above their chart (`chartRect`). */
const headerHeightPx = 17

/**
 * Bar-strip header: a short muted label plus a terse value derived from the block's own
 * description, replacing the header the block would ellipsize at strip width. A 1 px baseline
 * under the chart keeps the trend anchored on light backgrounds.
 */
const withStripHeader = (options: {
  readonly spec: CanvasBlockSpec
  readonly label: string
  readonly value: (text: string) => string
}): CanvasBlockSpec =>
  decorate({
    spec: options.spec,
    draw: ({ inner, frame }) => {
      inner.draw(frame)
      const { ctx, rect, theme, nowMs } = frame
      const text = inner.describe({ nowMs })
      ctx.save()
      ctx.beginPath()
      ctx.rect(rect.x, rect.y, rect.width, rect.height)
      ctx.clip()
      ctx.fillStyle = theme.background
      ctx.fillRect(rect.x, rect.y, rect.width, headerHeightPx)
      ctx.fillStyle = theme.border
      ctx.fillRect(rect.x + 4, rect.y + rect.height - 1, rect.width - 8, 1)
      ctx.font = theme.font
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      const header = layoutBlockText({
        rect,
        label: options.label,
        value: text.startsWith('n/a') === true ? 'n/a' : options.value(text),
        measure: (run) => ctx.measureText(run).width,
        gapPx: 4,
      })
      ctx.fillStyle = theme.muted
      if (header.label !== undefined) ctx.fillText(header.label.text, header.label.x, rect.y + 3)
      ctx.fillStyle = theme.foreground
      if (header.value !== undefined) ctx.fillText(header.value.text, header.value.x, rect.y + 3)
      ctx.restore()
    },
  })

/** Bar tiles in light mode: a tinted tile and a darker baseline separate them from the bar. */
const lightStripTheme: MeterTheme = { ...lightMeterTheme, background: '#eeeff2', border: '#8a8f98' }

// ---------------------------------------------------------------------------------------------
// Meter rows: one spec, bar priority, trend and time-aligned readout per meter
// ---------------------------------------------------------------------------------------------

/** Latest observation at or before `atMs`, optionally only within a recent window. */
const sampleAt = <TValue,>(options: {
  readonly view: SeriesView<TValue>
  readonly atMs: number
  readonly withinMs?: number
}): { readonly atMs: number; readonly value: TValue } | undefined => {
  let low = 0
  let high = options.view.length - 1
  let found: Sample<TValue> | undefined
  while (low <= high) {
    const middle = (low + high) >> 1
    const sample = options.view.at(middle)
    if (sample === undefined || sample.atMs > options.atMs) high = middle - 1
    else {
      found = sample
      low = middle + 1
    }
  }
  if (found?._tag !== 'Value') return undefined
  if (options.withinMs !== undefined && options.atMs - found.atMs > options.withinMs)
    return undefined
  return found
}

/** Values in `[atMs - windowMs, atMs]`, for event series readouts. */
const valuesWithin = <TValue,>(options: {
  readonly view: SeriesView<TValue>
  readonly atMs: number
  readonly windowMs: number
}): readonly TValue[] => {
  const found: TValue[] = []
  for (let index = options.view.length - 1; index >= 0; index--) {
    const sample = options.view.at(index)
    if (sample === undefined || sample.atMs < options.atMs - options.windowMs) break
    if (sample._tag === 'Value' && sample.atMs <= options.atMs) found.push(sample.value)
  }
  return found
}

interface TrendBins {
  readonly totals: readonly number[]
  readonly alerts: readonly boolean[]
}

type Trend =
  | {
      readonly _tag: 'Bars'
      /** Typed payload projection stays inside this closure; one bin per CSS pixel. */
      readonly bin: (options: {
        readonly store: SeriesStore
        readonly nowMs: number
        readonly bins: number
      }) => TrendBins
    }
  | { readonly _tag: 'Status'; readonly series: Series<StatusValue> }

const bars = <TValue,>(options: {
  readonly series: Series<TValue>
  readonly project: (value: TValue) => number
  readonly alert: (value: TValue) => boolean
  readonly mode: 'Gauge' | 'Event'
}): Trend => ({
  _tag: 'Bars',
  bin: ({ store, nowMs, bins }) => {
    const view = store.read({ series: options.series })
    const totals = Array.from<number>({ length: bins }).fill(0)
    const alerts = Array.from<boolean>({ length: bins }).fill(false)
    const startMs = nowMs - historyMs
    for (let index = 0; index < view.length; index++) {
      const sample = view.at(index)
      if (sample?._tag !== 'Value' || sample.atMs < startMs || sample.atMs > nowMs) continue
      const bin = Math.min(bins - 1, Math.floor(((sample.atMs - startMs) / historyMs) * bins))
      const projected = options.project(sample.value)
      totals[bin] = options.mode === 'Event' ? (totals[bin] ?? 0) + projected : projected
      if (options.alert(sample.value) === true) alerts[bin] = true
    }
    return { totals, alerts }
  },
})

interface MeterRow {
  /** Full block: Timeline rows, evidence text and the Meters panel. */
  readonly spec: CanvasBlockSpec
  /** Same block with the bar-strip header (short muted label + terse value). */
  readonly stripSpec: CanvasBlockSpec
  readonly shortLabel: string
  /** Higher stays longer in the bar (Devbar `fitSegments`). */
  readonly priority: number
  readonly trend: Trend
  readonly readoutAt: (options: { readonly store: SeriesStore; readonly atMs: number }) => string
}

type MeterRowInput = Omit<MeterRow, 'stripSpec'> & {
  readonly stripLabel: string
  /** Terse strip value derived from the block's full description (never re-measured). */
  readonly stripValue: (text: string) => string
}

/** Fits `commit 3.8` / `ws offline` in 11 px monospace with the 4 px header padding. */
const segmentWidthPx = 76
/** Gauges sampled every 0.5–1 s are stale after 3 s without a sample. */
const gaugeStaleAfterMs = 3000

const meterRowInputs: readonly MeterRowInput[] = [
  {
    shortLabel: 'msg',
    stripLabel: 'msg',
    stripValue: (text) => text.replace(' msg/s', '/s'),
    priority: 6,
    spec: withEventTicks({
      spec: numericBlock({
        id: 'api.messages',
        series: recordingSeries.messages,
        shortLabel: 'msg',
        widthPx: segmentWidthPx,
        staleAfterMs: gaugeStaleAfterMs,
        // Stacked by kind: delta (normal), snapshot resync (warning), error frames (danger).
        values: (value) => [value.delta, value.snapshot, value.error],
        describeValue: ({ value, format }) => {
          const total = value.delta + value.snapshot + value.error
          return format === 'full'
            ? `${total} msg/s`
            : format === 'compact'
              ? `${total}/s`
              : `${total}`
        },
      }),
      // Error frames are a few per second next to hundreds of deltas: tick every window with any.
      ticks: recordingSeries.messages,
      when: (value) => value.error > 0,
    }),
    trend: bars({
      series: recordingSeries.messages,
      project: (value) => value.delta + value.snapshot + value.error,
      alert: (value) => value.error > 0,
      mode: 'Gauge',
    }),
    readoutAt: ({ store, atMs }) => {
      const found = sampleAt({ view: store.read({ series: recordingSeries.messages }), atMs })
      if (found === undefined) return 'n/a'
      const { delta, snapshot, error } = found.value
      return `${delta + snapshot + error} msg/s (delta ${delta} · snapshot ${snapshot} · error ${error})`
    },
  },
  {
    shortLabel: 'ws',
    stripLabel: 'ws',
    stripValue: (text) => (text === 'reconnecting' ? 'retry' : text),
    priority: 5,
    spec: statusBlock({
      id: 'ws.status',
      series: recordingSeries.websocket,
      shortLabel: 'ws',
      widthPx: segmentWidthPx,
    }),
    trend: { _tag: 'Status', series: recordingSeries.websocket },
    readoutAt: ({ store, atMs }) =>
      sampleAt({ view: store.read({ series: recordingSeries.websocket }), atMs })?.value.label ??
      'n/a',
  },
  {
    shortLabel: 'http',
    stripLabel: 'p95',
    stripValue: (text) => text.split('/')[1] ?? text,
    priority: 4,
    spec: withEventTicks({
      spec: withQuietTail(
        numericBlock({
          id: 'http.latency',
          series: recordingSeries.httpLatency,
          shortLabel: 'http',
          widthPx: segmentWidthPx,
          staleAfterMs: gaugeStaleAfterMs,
          // p50 band (normal) with the p50→p95 tail stacked on top (painted neutral).
          values: (value) => [value.p50Ms, Math.max(0, value.p95Ms - value.p50Ms)],
          describeValue: ({ value, format }) =>
            format === 'full'
              ? `${value.p50Ms}/${value.p95Ms}ms`
              : format === 'compact'
                ? formatMeterValue({ value: value.p95Ms, unit: 'ms', format })
                : `${value.p95Ms}`,
        }),
      ),
      ticks: recordingSeries.httpErrors,
    }),
    trend: bars({
      series: recordingSeries.httpLatency,
      project: (value) => value.p95Ms,
      alert: (value) => value.p95Ms > 500,
      mode: 'Gauge',
    }),
    readoutAt: ({ store, atMs }) => {
      const found = sampleAt({ view: store.read({ series: recordingSeries.httpLatency }), atMs })
      const errors = valuesWithin<HttpError>({
        view: store.read({ series: recordingSeries.httpErrors }),
        atMs,
        windowMs: 1000,
      })
      if (found === undefined) return 'n/a'
      const statuses = [...new Set(errors.map((error) => error.status))].join('/')
      return `p50 ${found.value.p50Ms} ms · p95 ${found.value.p95Ms} ms${errors.length > 0 ? ` · ${errors.length} failed (${statuses}) in the preceding 1 s` : ''}`
    },
  },
  {
    shortLabel: 'commit',
    stripLabel: 'commit',
    stripValue: (text) => text.replace(/ ms$/, ''),
    priority: 3,
    spec: commitBlock({
      id: 'react.commits',
      series: recordingSeries.commits,
      shortLabel: 'commit',
      widthPx: segmentWidthPx,
    }),
    trend: bars({
      series: recordingSeries.commits,
      project: (value) => value.actualDurationMs,
      alert: (value) => value.actualDurationMs > 16,
      mode: 'Event',
    }),
    readoutAt: ({ store, atMs }) => {
      const commits = valuesWithin({
        view: store.read({ series: recordingSeries.commits }),
        atMs,
        windowMs: 1000,
      })
      if (commits.length === 0) return 'no commits in the preceding 1 s'
      const worst = Math.max(...commits.map((commit) => commit.actualDurationMs))
      return `${commits.length} commit${commits.length === 1 ? '' : 's'} in the preceding 1 s · worst ${worst.toFixed(1)} ms`
    },
  },
  {
    shortLabel: 'jank',
    stripLabel: 'lf',
    stripValue: (text) => text.replace(' ms', 'ms'),
    priority: 2,
    spec: jankBlock({
      id: 'longFrames',
      series: recordingSeries.longFrames,
      shortLabel: 'jank',
      widthPx: segmentWidthPx,
    }),
    trend: bars({
      series: recordingSeries.longFrames,
      project: (value) => value.durationMs,
      alert: () => true,
      mode: 'Event',
    }),
    readoutAt: ({ store, atMs }) => {
      const frames = valuesWithin({
        view: store.read({ series: recordingSeries.longFrames }),
        atMs,
        windowMs: 1000,
      })
      return frames.length === 0
        ? 'none in the preceding 1 s'
        : `${frames.length} long frame${frames.length === 1 ? '' : 's'} · worst ${Math.max(...frames.map((frame) => frame.durationMs))} ms`
    },
  },
  {
    shortLabel: 'fps',
    stripLabel: 'fps',
    stripValue: (text) => text.replace(/ fps$/, '').replace(/\.0$/, ''),
    priority: 1,
    spec: frameBlock({
      id: 'frames',
      series: recordingSeries.frames,
      shortLabel: 'fps',
      widthPx: segmentWidthPx,
    }),
    trend: bars({
      series: recordingSeries.frames,
      project: (value) => (value.durationMs > 0 ? 1000 / value.durationMs : 0),
      alert: (value) => value.durationMs > 25,
      mode: 'Gauge',
    }),
    readoutAt: ({ store, atMs }) => {
      const found = sampleAt({ view: store.read({ series: recordingSeries.frames }), atMs })
      return found === undefined || found.value.durationMs <= 0
        ? 'n/a'
        : `${(1000 / found.value.durationMs).toFixed(0)} fps (frame ${found.value.durationMs} ms)`
    },
  },
]
const meterRows: readonly MeterRow[] = meterRowInputs.map(
  // `row` is a fresh rest object, so attaching the decorated strip spec mutates nothing shared.
  ({ stripLabel, stripValue, ...row }): MeterRow =>
    Object.assign(row, {
      stripSpec: withStripHeader({ spec: row.spec, label: stripLabel, value: stripValue }),
    }),
)
const meterSpecs = meterRows.map((row) => row.spec)

// ---------------------------------------------------------------------------------------------
// Session + canvas plumbing
// ---------------------------------------------------------------------------------------------

const runScoped = <A, E>(program: Effect.Effect<A, E, Scope.Scope>): (() => void) => {
  const fiber = Effect.runFork(Effect.scoped(program))
  return () => {
    Effect.runFork(Fiber.interrupt(fiber))
  }
}

/** The story host owns the only session lease, like a real bootstrap. */
const useReplayMeters = (options: {
  readonly playback: Playback
  readonly scenario: Scenario
}): Meters | undefined => {
  const { playback, scenario } = options
  const key = `${playback}:${scenario}`
  const [started, setStarted] = React.useState<
    { readonly key: string; readonly meters: Meters } | undefined
  >(undefined)
  React.useEffect(() => {
    const meters = makeReplayMeters({ playback, scenario })
    return runScoped(
      meters.start.pipe(
        Effect.andThen(Effect.sync(() => setStarted({ key: `${playback}:${scenario}`, meters }))),
        Effect.andThen(Effect.never),
      ),
    )
  }, [playback, scenario])
  return started?.key === key ? started.meters : undefined
}

/**
 * Evaluation instant for DOM readouts: the frozen instant, or the session clock sampled at
 * most every 500 ms (Pinned playback has no Draw ticks, so it stays at the pinned instant).
 */
const useEvaluatedAtMs = (options: {
  readonly meters: Meters
  readonly frozenAtMs: number | undefined
}): number => {
  const { meters, frozenAtMs } = options
  const [clockMs, setClockMs] = React.useState(() => meters.clock.now())
  React.useEffect(() => {
    if (frozenAtMs !== undefined) return undefined
    let last = Number.NEGATIVE_INFINITY
    return runScoped(
      meters.clock
        .subscribe({
          phase: 'Draw',
          listener: (tick) => {
            if (tick.atMs - last < 500) return
            last = tick.atMs
            setClockMs(tick.atMs)
          },
        })
        .pipe(Effect.andThen(Effect.never)),
    )
  }, [meters, frozenAtMs])
  return frozenAtMs ?? clockMs
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

/** DPR-aware canvas painted once on attach and on every Draw tick of the session clock. */
const usePaintedCanvas = (options: {
  readonly meters: Meters
  readonly widthPx: number | undefined
  readonly heightPx: number
  readonly paint: (input: {
    readonly ctx: CanvasRenderingContext2D
    readonly nowMs: number
    readonly widthPx: number
  }) => void
}): ((canvas: HTMLCanvasElement | null) => (() => void) | undefined) => {
  const { meters, widthPx, heightPx, paint } = options
  return React.useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (canvas === null || widthPx === undefined || widthPx <= 0) return undefined
      const ctx = canvas.getContext('2d')
      if (ctx === null) return undefined
      const dpr = window.devicePixelRatio
      canvas.width = Math.round(widthPx * dpr)
      canvas.height = Math.round(heightPx * dpr)
      canvas.style.width = `${widthPx}px`
      canvas.style.height = `${heightPx}px`
      const draw = (nowMs: number): void => {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, widthPx, heightPx)
        paint({ ctx, nowMs, widthPx })
      }
      draw(meters.clock.now())
      return runScoped(
        meters.clock
          .subscribe({ phase: 'Draw', listener: (tick) => draw(tick.atMs) })
          .pipe(Effect.andThen(Effect.never)),
      )
    },
    [meters, widthPx, heightPx, paint],
  )
}

const useElementWidth = (): readonly [
  (node: HTMLElement | null) => (() => void) | undefined,
  number | undefined,
] => {
  const [width, setWidth] = React.useState<number | undefined>(undefined)
  const ref = React.useCallback((node: HTMLElement | null) => {
    if (node === null) return undefined
    const observer = new ResizeObserver(() => setWidth(Math.floor(node.clientWidth)))
    observer.observe(node)
    setWidth(Math.floor(node.clientWidth))
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

const useStripText = (options: {
  readonly meters: Meters
  readonly spec: CanvasBlockSpec
}): string => {
  const view = React.useMemo(
    () =>
      makeStripView({
        store: options.meters.store,
        blocks: [options.spec],
        now: options.meters.clock.now,
      }),
    [options.meters, options.spec],
  )
  const texts = React.useSyncExternalStore(view.subscribe, view.getSnapshot, view.getSnapshot)
  return texts[0] ?? 'n/a (NoSamples)'
}

// ---------------------------------------------------------------------------------------------
// Bar segments
// ---------------------------------------------------------------------------------------------

const styles = stylex.create({
  frame: (widthPx: number, heightPx: number) => ({
    position: 'relative',
    width: widthPx,
    height: heightPx,
    overflow: 'hidden',
    boxSizing: 'border-box',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: devbarTokens.border,
    backgroundColor: devbarTokens.panel,
    color: devbarTokens.text,
    fontFamily: devbarTokens.fontUi,
  }),
  caption: {
    margin: 0,
    paddingBlock: '0.75rem',
    paddingInline: '1rem',
    fontSize: '0.8125rem',
    lineHeight: 1.4,
  },
  captionId: { fontWeight: 600, fontFamily: devbarTokens.fontData },
  muted: { color: devbarTokens.mutedText },
  segmentButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.3rem',
    height: '1.5rem',
    padding: 0,
    paddingInline: '0.25rem',
    borderWidth: 0,
    borderRadius: '0.25rem',
    backgroundColor: { default: 'transparent', ':hover': devbarTokens.panel },
    color: devbarTokens.text,
    font: 'inherit',
    cursor: 'pointer',
    outlineWidth: { default: 0, ':focus-visible': 2 },
    outlineStyle: 'solid',
    outlineColor: devbarTokens.focusRing,
    outlineOffset: '-2px',
  },
  stripButton: { paddingInline: 0, height: 'auto' },
  pressed: { backgroundColor: { default: devbarTokens.panel, ':hover': devbarTokens.panel } },
  segmentLabel: { color: devbarTokens.mutedText },
  segmentValue: {
    fontFamily: devbarTokens.fontData,
    fontVariantNumeric: 'tabular-nums',
    minWidth: '4.5em',
  },
  subs: {
    fontFamily: devbarTokens.fontData,
    fontVariantNumeric: 'tabular-nums',
    color: devbarTokens.mutedText,
    whiteSpace: 'nowrap',
  },
  // Block padding only: the canvas fills the measured width and draws its own inset.
  timeline: { paddingBlock: '0.5rem', minWidth: 0 },
  timelineCanvas: {
    display: 'block',
    outlineWidth: { default: 0, ':focus-visible': 2 },
    outlineStyle: 'solid',
    outlineColor: devbarTokens.focusRing,
  },
  // Anchored under the axis, outside the plot, so it never hides a row.
  readout: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(19rem, 1fr))',
    columnGap: '1rem',
    rowGap: '0.125rem',
    margin: 0,
    paddingTop: '0.375rem',
    paddingInline: '0.25rem',
    fontFamily: devbarTokens.fontData,
    fontSize: '0.6875rem',
    lineHeight: 1.45,
    color: devbarTokens.text,
  },
  readoutEntry: { minWidth: 0 },
  readoutTerm: { display: 'inline', color: devbarTokens.mutedText, paddingRight: '0.75rem' },
  readoutValue: { display: 'inline', margin: 0 },
  readoutSelected: {
    fontWeight: 600,
    outlineWidth: 1,
    outlineStyle: 'solid',
    outlineColor: devbarTokens.focusRing,
    outlineOffset: '1px',
  },
  srOnly: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  },
  // Above the 32 px bar, inside the story frame.
  evidence: {
    position: 'absolute',
    bottom: '2.5rem',
    zIndex: 201,
    display: 'grid',
    gap: '0.125rem',
    maxWidth: '24rem',
    margin: 0,
    paddingBlock: '0.375rem',
    paddingInline: '0.5rem',
    pointerEvents: 'none',
    fontFamily: devbarTokens.fontData,
    fontSize: '0.6875rem',
    lineHeight: 1.45,
    backgroundColor: devbarTokens.canvas,
    color: devbarTokens.text,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: devbarTokens.border,
    borderRadius: '0.25rem',
  },
  evidenceTitle: { fontWeight: 600 },
  picker: {
    display: 'grid',
    gap: '0.5rem',
    paddingBlock: '0.75rem',
    paddingInline: '1rem',
    marginBottom: '0.75rem',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: devbarTokens.border,
    backgroundColor: devbarTokens.canvas,
    color: devbarTokens.text,
    fontFamily: devbarTokens.fontUi,
    fontSize: '0.75rem',
  },
  pickerRow: { display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 },
  pickerLabel: { width: '4.5rem', flexShrink: 0, fontWeight: 600 },
  pickerOption: {
    paddingBlock: '0.2rem',
    paddingInline: '0.55rem',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: devbarTokens.border,
    borderRadius: '0.25rem',
    backgroundColor: { default: 'transparent', ':hover': devbarTokens.panel },
    color: devbarTokens.text,
    font: 'inherit',
    fontFamily: devbarTokens.fontData,
    cursor: 'pointer',
    outlineWidth: { default: 0, ':focus-visible': 2 },
    outlineStyle: 'solid',
    outlineColor: devbarTokens.focusRing,
  },
  pickerSelected: {
    backgroundColor: { default: devbarTokens.text, ':hover': devbarTokens.text },
    color: devbarTokens.canvas,
    borderColor: devbarTokens.text,
  },
  pickerDescription: { color: devbarTokens.mutedText, minWidth: 0 },
  collection: { display: 'grid', gap: '1rem', padding: '1rem' },
  stateHeading: {
    margin: 0,
    marginBottom: '0.375rem',
    fontFamily: devbarTokens.fontUi,
    fontSize: '0.8125rem',
    fontWeight: 600,
    color: devbarTokens.text,
  },
})

/** What captured an evidence snapshot; the card states it so a snapshot never reads as live. */
type InspectTrigger = 'focus' | 'hover' | 'activation' | 'refresh' | 'pinned'

/** Variant A/C: one existing canvas block rendered by the existing canvas strip renderer. */
const StripSegment = (props: {
  readonly meters: Meters
  readonly row: MeterRow
  readonly theme: MeterTheme
  readonly frozenAtMs: number | undefined
  readonly expanded: boolean
  readonly controls: string | undefined
  readonly describedBy: string | undefined
  readonly tileRef: (element: HTMLButtonElement | null) => void
  readonly onOpen: () => void
  readonly onInspect: (options: {
    readonly trigger: InspectTrigger
    readonly tile: HTMLElement
  }) => void
  readonly onDismiss: (options: { readonly trigger: 'focus' | 'hover' | 'escape' }) => void
}): React.ReactNode => {
  const { meters, row, theme, frozenAtMs, onInspect, onDismiss } = props
  // Fills the 32 px bar row minus its border, leaving a ~10 px trend under the header.
  const heightPx = 30
  const view = React.useMemo(
    () =>
      makeStripView({
        store: meters.store,
        blocks: [row.stripSpec],
        now: meters.clock.now,
        ...(frozenAtMs === undefined ? {} : { frozenAtMs }),
      }),
    [meters, row.stripSpec, frozenAtMs],
  )
  const attach = React.useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (canvas === null) return undefined
      return runScoped(
        makeCanvasStrip({
          canvas,
          meters,
          blocks: [row.stripSpec],
          view,
          heightPx,
          gapPx: 0,
          historyMs,
          readTheme: () => theme,
        }).attach.pipe(Effect.andThen(Effect.never)),
      )
    },
    [meters, row.stripSpec, view, theme],
  )
  return (
    <button
      ref={props.tileRef}
      type="button"
      // Static name: values live in the evidence snapshot, never in the accessible name.
      aria-label={row.spec.label}
      title={row.spec.label}
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      aria-describedby={props.describedBy}
      aria-keyshortcuts="R"
      onClick={(event) => {
        onInspect({ trigger: 'activation', tile: event.currentTarget })
        props.onOpen()
      }}
      onFocus={(event) => onInspect({ trigger: 'focus', tile: event.currentTarget })}
      onBlur={() => onDismiss({ trigger: 'focus' })}
      onMouseEnter={(event) => onInspect({ trigger: 'hover', tile: event.currentTarget })}
      onMouseLeave={() => onDismiss({ trigger: 'hover' })}
      onKeyDown={(event) => {
        if (event.key === 'r' || event.key === 'R') {
          event.preventDefault()
          onInspect({ trigger: 'refresh', tile: event.currentTarget })
        }
        // First Escape dismisses the snapshot; Devbar sees the next one.
        if (event.key === 'Escape' && props.describedBy !== undefined) {
          event.preventDefault()
          onDismiss({ trigger: 'escape' })
        }
      }}
      {...stylex.props(styles.segmentButton, styles.stripButton)}
    >
      <div style={{ width: segmentWidthPx, height: heightPx }}>
        <canvas ref={attach} aria-hidden="true" style={{ display: 'block' }} />
      </div>
    </button>
  )
}

/** Where the evidence card sits inside the story frame, aligned with its tile. */
type CardAnchor = { readonly left: number } | { readonly right: number }

const anchorFor = (tile: HTMLElement): CardAnchor => {
  const frame = tile.closest('section')
  if (frame === null) return { left: 0 }
  const outer = frame.getBoundingClientRect()
  const inner = tile.getBoundingClientRect()
  return inner.left + inner.width / 2 > outer.left + outer.width / 2
    ? { right: Math.max(0, outer.right - inner.right) }
    : { left: Math.max(0, inner.left - outer.left) }
}

interface Inspection {
  readonly id: string
  readonly trigger: InspectTrigger
  readonly evidence: BlockEvidence
  readonly frozen: boolean
  readonly anchor: CardAnchor
}

const latestText = (evidence: BlockEvidence): string => {
  const latest = evidence.latest
  if (latest === undefined) return 'no sample before evaluation'
  const before = `${seconds(evidence.evaluatedAtMs - latest.atMs)} before evaluation`
  switch (latest._tag) {
    case 'Value':
      return `latest sample ${before}`
    case 'Unavailable':
      return `unavailable (${latest.reason}) ${before}`
    case 'Gap':
      return `gap (${latest.reason}, ${seconds(latest.durationMs)}) ending ${before}`
  }
}

const triggerText: Record<InspectTrigger, string> = {
  focus: 'Snapshot taken on focus',
  hover: 'Snapshot taken on hover',
  activation: 'Snapshot taken on activation',
  refresh: 'Snapshot refreshed',
  pinned: 'Snapshot pinned by this story',
}

/** Q19 evidence: a captured snapshot with its evaluation instant, never a live readout. */
const EvidenceCard = (props: {
  readonly id: string
  readonly inspection: Inspection
}): React.ReactNode => {
  const { evidence, trigger, frozen, anchor } = props.inspection
  return (
    <div id={props.id} role="tooltip" style={anchor} {...stylex.props(styles.evidence)}>
      <span>
        <span {...stylex.props(styles.evidenceTitle)}>{evidence.label}</span> {evidence.text}
      </span>
      <span>{latestText(evidence)}</span>
      <span {...stylex.props(styles.muted)}>
        evaluated at replay clock {seconds(evidence.evaluatedAtMs)}
        {frozen === true ? ' (frozen)' : ''} · revision {evidence.revision}
      </span>
      <span {...stylex.props(styles.muted)}>{triggerText[trigger]} · R refreshes</span>
    </div>
  )
}

const trendWidthPx = 36
const trendHeightPx = 14

/** Variant B: compact text value plus a tiny trend drawn from the same series history. */
const TrendSegment = (props: {
  readonly meters: Meters
  readonly row: MeterRow
  readonly theme: MeterTheme
  readonly onOpen: () => void
}): React.ReactNode => {
  const text = useStripText({ meters: props.meters, spec: props.row.spec })
  const { trend } = props.row
  const { theme, meters } = props
  const paint = React.useCallback(
    ({
      ctx,
      nowMs,
      widthPx,
    }: {
      readonly ctx: CanvasRenderingContext2D
      readonly nowMs: number
      readonly widthPx: number
    }) => {
      const chart = { x: 0, y: 0, width: widthPx, height: trendHeightPx }
      if (trend._tag === 'Status') {
        paintStatusBand({
          ctx,
          chart,
          history: meters.store.read({ series: trend.series }),
          nowMs,
          theme,
          historyMs,
        })
        return
      }
      const { totals, alerts } = trend.bin({ store: meters.store, nowMs, bins: widthPx })
      const bins = widthPx
      const maximum = Math.max(1, ...totals)
      for (let bin = 0; bin < bins; bin++) {
        const total = totals[bin] ?? 0
        if (total <= 0) continue
        const height = Math.max(1, (total / maximum) * trendHeightPx)
        ctx.fillStyle = alerts[bin] === true ? theme.danger : theme.normal
        ctx.fillRect(bin, trendHeightPx - height, 1, height)
      }
      ctx.fillStyle = theme.border
      ctx.fillRect(0, trendHeightPx - 1, widthPx, 1)
    },
    [trend, meters, theme],
  )
  const attach = usePaintedCanvas({ meters, widthPx: trendWidthPx, heightPx: trendHeightPx, paint })
  return (
    <button
      type="button"
      aria-label={`${props.row.spec.label} ${text}`}
      title={`${props.row.spec.label}: ${text} — open Timeline`}
      onClick={props.onOpen}
      {...stylex.props(styles.segmentButton)}
    >
      <span {...stylex.props(styles.segmentLabel)}>{props.row.shortLabel}</span>
      <span {...stylex.props(styles.segmentValue)}>{text}</span>
      <canvas ref={attach} aria-hidden="true" style={{ display: 'block' }} />
    </button>
  )
}

/** `subs n/cap` deliberately stays text. */
const SubscriptionsText = (props: { readonly meters: Meters }): React.ReactNode => {
  const store = props.meters.store
  const latest = React.useSyncExternalStore(
    React.useCallback((notify: () => void) => store.subscribe({ notify }), [store]),
    () => store.read({ series: recordingSeries.subscriptions }).latest,
  )
  return (
    <output aria-label="Live subscriptions" {...stylex.props(styles.subs)}>
      subs {latest?._tag === 'Value' ? latest.value.value : 'n/a'}/{subscriptionCap}
    </output>
  )
}

// ---------------------------------------------------------------------------------------------
// Linked shared-axis panel (Variant B/C) and single-meter detail (Variant A)
// ---------------------------------------------------------------------------------------------

// Six rows plus the axis stay inside the Devbar panel's `min(48vh, 32rem)` on a ~700 px viewport.
const rowHeightPx = 40
const rowGapPx = 2
const axisHeightPx = 18
/** Crosshair keyboard steps, in seconds. */
const fineStepS = 1
const coarseStepS = 10
const historyS = historyMs / 1000

const TimelineCanvas = (props: {
  readonly id: string
  readonly meters: Meters
  readonly rows: readonly MeterRow[]
  readonly theme: MeterTheme
  readonly label: string
  /** Row linked to the activated bar tile; highlighted on the canvas and in the readout. */
  readonly highlightId: string | undefined
  readonly frozenAtMs: number | undefined
}): React.ReactNode => {
  const { meters, rows, theme, frozenAtMs, highlightId } = props
  const [containerRef, containerWidth] = useElementWidth()
  const widthPx = containerWidth === undefined ? undefined : Math.max(240, containerWidth)
  const heightPx = rows.length * (rowHeightPx + rowGapPx) + axisHeightPx
  const readers = React.useMemo(
    () =>
      rows.map((row) => {
        const reader = row.spec.read(meters.store)
        return frozenAtMs === undefined ? reader : reader.snapshot()
      }),
    [rows, meters, frozenAtMs],
  )
  const evaluatedAtMs = useEvaluatedAtMs({ meters, frozenAtMs })
  /** Crosshair as seconds before evaluation, so keyboard steps stay exact at any width. */
  const [cursorBeforeS, setCursorBeforeS] = React.useState<number | undefined>(undefined)
  const paint = React.useCallback(
    ({
      ctx,
      nowMs: clockMs,
      widthPx: width,
    }: {
      readonly ctx: CanvasRenderingContext2D
      readonly nowMs: number
      readonly widthPx: number
    }) => {
      const nowMs = frozenAtMs ?? clockMs
      let top = 0
      for (let index = 0; index < readers.length; index++) {
        const reader = readers[index]
        if (reader === undefined) continue
        reader.draw({
          ctx,
          rect: { x: 0, y: top, width, height: rowHeightPx },
          nowMs,
          historyMs,
          theme,
        })
        if (rows.length > 1 && rows[index]?.spec.id === highlightId) {
          ctx.strokeStyle = theme.focus
          ctx.lineWidth = 1
          ctx.strokeRect(0.5, top + 0.5, width - 1, rowHeightPx - 1)
          ctx.fillStyle = theme.focus
          ctx.fillRect(0, top, 3, rowHeightPx)
        }
        top += rowHeightPx + rowGapPx
      }
      // One axis for every row: identical chart insets make every row share these x positions.
      const axis = chartRect({ x: 0, y: 0, width, height: rowHeightPx })
      ctx.font = theme.font
      ctx.textBaseline = 'top'
      for (let before = 0; before <= historyS; before += 10) {
        const x = Math.round(
          historyX({ atMs: nowMs - before * 1000, nowMs, historyMs, rect: axis }),
        )
        ctx.fillStyle = theme.border
        ctx.globalAlpha = 0.7
        let rowTop = 0
        for (let index = 0; index < readers.length; index++) {
          ctx.fillRect(x, rowTop + 18, 1, rowHeightPx - 20)
          rowTop += rowHeightPx + rowGapPx
        }
        ctx.globalAlpha = 1
        // Seconds before evaluation; 0 s is the evaluation instant, not a live "now".
        const run = fitText({
          text: before === 0 ? '0 s' : `−${before} s`,
          maxWidth: 48,
          measure: (text) => ctx.measureText(text).width,
        })
        if (run === undefined) continue
        ctx.fillStyle = theme.muted
        const textX = Math.min(width - run.width, Math.max(0, x - run.width / 2))
        ctx.fillText(run.text, textX, top + 3)
      }
      if (cursorBeforeS !== undefined) {
        ctx.fillStyle = theme.focus
        ctx.fillRect(Math.round(axis.x + axis.width * (1 - cursorBeforeS / historyS)), 0, 1, top)
      }
    },
    [readers, rows, highlightId, theme, cursorBeforeS, frozenAtMs],
  )
  const attach = usePaintedCanvas({ meters, widthPx, heightPx, paint })
  const axis = chartRect({ x: 0, y: 0, width: widthPx ?? 0, height: rowHeightPx })
  const moveTo = (beforeS: number): void =>
    setCursorBeforeS(Math.max(0, Math.min(historyS, Math.round(beforeS * 10) / 10)))
  const atText = `${seconds((cursorBeforeS ?? 0) * 1000)} before evaluation`
  const readAtMs = evaluatedAtMs - (cursorBeforeS ?? 0) * 1000
  const entries = rows.map((row) => ({
    id: row.spec.id,
    label: row.shortLabel,
    text: row.readoutAt({ store: meters.store, atMs: readAtMs }),
  }))
  // One debounced live line for the whole readout; it follows crosshair moves, not clock ticks.
  const summary = `${atText}: ${entries.map((entry) => `${entry.label} ${entry.text}`).join('; ')}`
  const summaryRef = React.useRef(summary)
  summaryRef.current = summary
  const [announcement, setAnnouncement] = React.useState('')
  React.useEffect(() => {
    if (cursorBeforeS === undefined) return undefined
    const timer = setTimeout(() => setAnnouncement(summaryRef.current), 500)
    return () => clearTimeout(timer)
  }, [cursorBeforeS])
  const helpId = `${props.id}-help`
  return (
    <div id={props.id} ref={containerRef} {...stylex.props(styles.timeline)}>
      <canvas
        ref={attach}
        tabIndex={0}
        role="slider"
        aria-label={`${props.label} crosshair`}
        aria-describedby={helpId}
        aria-orientation="horizontal"
        aria-valuemin={-historyS}
        aria-valuemax={0}
        aria-valuenow={-(cursorBeforeS ?? 0)}
        aria-valuetext={atText}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect()
          const x = Math.max(axis.x, Math.min(axis.x + axis.width, event.clientX - bounds.left))
          moveTo((1 - (x - axis.x) / axis.width) * historyS)
        }}
        onPointerLeave={(event) => {
          // A keyboard-placed crosshair survives the pointer leaving.
          if (document.activeElement !== event.currentTarget) setCursorBeforeS(undefined)
        }}
        onKeyDown={(event) => {
          const from = cursorBeforeS ?? 0
          const step = event.shiftKey === true ? coarseStepS : fineStepS
          const target =
            event.key === 'ArrowLeft'
              ? from + step
              : event.key === 'ArrowRight'
                ? from - step
                : event.key === 'PageDown'
                  ? from + coarseStepS
                  : event.key === 'PageUp'
                    ? from - coarseStepS
                    : event.key === 'Home'
                      ? historyS
                      : event.key === 'End'
                        ? 0
                        : undefined
          if (target !== undefined) {
            event.preventDefault()
            moveTo(target)
            return
          }
          // Clear the crosshair but keep focus here; the Devbar only closes on an unhandled Escape.
          if (event.key === 'Escape' && cursorBeforeS !== undefined) {
            event.preventDefault()
            setCursorBeforeS(undefined)
          }
        }}
        {...stylex.props(styles.timelineCanvas)}
      />
      <span id={helpId} {...stylex.props(styles.srOnly)}>
        {rows.map((row) => row.spec.label).join(', ')} over the {historyS} s before evaluation on
        one shared time axis. Arrow keys move the crosshair {fineStepS} s, Shift+Arrow or Page
        Up/Down {coarseStepS} s, Home and End jump to the oldest sample and the evaluation instant,
        Escape clears it.
      </span>
      <dl {...stylex.props(styles.readout)}>
        <div {...stylex.props(styles.readoutEntry)}>
          <dt {...stylex.props(styles.readoutTerm)}>at</dt>
          <dd {...stylex.props(styles.readoutValue)}>
            {atText}
            {cursorBeforeS === undefined ? ' · move the crosshair to inspect' : ''}
          </dd>
        </div>
        {entries.map((entry) => (
          <div
            key={entry.id}
            {...stylex.props(
              styles.readoutEntry,
              rows.length > 1 && entry.id === highlightId && styles.readoutSelected,
            )}
          >
            <dt {...stylex.props(styles.readoutTerm)}>{entry.label}</dt>
            <dd {...stylex.props(styles.readoutValue)}>{entry.text}</dd>
          </div>
        ))}
      </dl>
      <p aria-live="polite" {...stylex.props(styles.srOnly)}>
        {announcement}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Variant host
// ---------------------------------------------------------------------------------------------

interface MeterVariantsProps {
  readonly variant: VariantId
  readonly width: WidthId
  readonly playback: Playback
  /** Fixture state replayed through the same series (no data, stale, disconnected). */
  readonly scenario: Scenario
  /** Start with the bar frozen at the evaluation instant (A/C). */
  readonly frozen: boolean
  /** Pin the evidence snapshot of this meter id, as a focused tile would show it (A/C). */
  readonly inspect?: string
  /** Open the variant's panel initially (Meters for A, Timeline for B/C). */
  readonly panelOpen: boolean
  /** Story frame height; state frames with a closed panel are shorter. */
  readonly heightPx?: number
  readonly dark?: boolean
}

const VariantDevbar = (
  props: MeterVariantsProps & { readonly meters: Meters },
): React.ReactNode => {
  const { meters, variant } = props
  const dark = props.dark === true
  const theme = dark === true ? darkMeterTheme : lightMeterTheme
  const stripTheme = dark === true ? darkMeterTheme : lightStripTheme
  const detailPanel = variant === 'A' ? 'meters' : 'timeline'
  const baseId = React.useId()
  const timelineId = `${baseId}timeline`
  const cardId = `${baseId}evidence`
  const [openPanel, setOpenPanel] = React.useState<string | undefined>(
    props.panelOpen === true ? detailPanel : undefined,
  )
  const [selected, setSelected] = React.useState<string>('api.messages')
  const [frozenAtMs, setFrozenAtMs] = React.useState<number | undefined>(() =>
    props.frozen === true ? meters.clock.now() : undefined,
  )
  // Captured once per freeze so the bar, the panel and every evidence card read one snapshot.
  const frozenReaders = React.useMemo(
    () =>
      frozenAtMs === undefined
        ? undefined
        : new Map(meterRows.map((row) => [row.spec.id, row.spec.read(meters.store).snapshot()])),
    [meters, frozenAtMs],
  )
  const [inspection, setInspection] = React.useState<Inspection | undefined>(undefined)
  const inspect = (options: {
    readonly id: string
    readonly trigger: InspectTrigger
    readonly tile: HTMLElement
  }): void => {
    const row = meterRows.find((item) => item.spec.id === options.id)
    if (row === undefined) return
    const reader = frozenReaders?.get(row.spec.id) ?? row.spec.read(meters.store)
    setInspection({
      id: row.spec.id,
      trigger: options.trigger,
      evidence: reader.evidence({ nowMs: frozenAtMs ?? meters.clock.now() }),
      frozen: frozenAtMs !== undefined,
      anchor: anchorFor(options.tile),
    })
  }
  const dismiss = (options: { readonly trigger: 'focus' | 'hover' | 'escape' }): void =>
    setInspection((current) => {
      if (current === undefined || options.trigger === 'escape') return undefined
      if (current.trigger === 'pinned') return current
      if (options.trigger === 'hover') return current.trigger === 'hover' ? undefined : current
      return current.trigger === 'hover' ? current : undefined
    })
  // The pinned tile mounts inside Devbar's fitted strip; inspect it once it is laid out.
  const [pinnedTile, setPinnedTile] = React.useState<HTMLElement | undefined>(undefined)
  const pinnedId = props.inspect
  const inspectRef = React.useRef(inspect)
  inspectRef.current = inspect
  React.useEffect(() => {
    if (pinnedTile === undefined || pinnedId === undefined) return
    inspectRef.current({ id: pinnedId, trigger: 'pinned', tile: pinnedTile })
  }, [pinnedTile, pinnedId])
  const timeline = (options: {
    readonly rows: readonly MeterRow[]
    readonly label: string
  }): React.ReactNode => (
    <TimelineCanvas
      id={timelineId}
      meters={meters}
      rows={options.rows}
      theme={theme}
      label={options.label}
      highlightId={variant === 'B' ? undefined : selected}
      frozenAtMs={frozenAtMs}
    />
  )
  const panels: readonly DevbarPanel[] =
    variant === 'A'
      ? [
          {
            id: 'meters',
            label: 'Meters',
            render: () => (
              <MetersPanel
                blocks={meterSpecs}
                theme={theme}
                selected={selected}
                onSelect={({ id }) => setSelected(id)}
                renderDetail={(spec) =>
                  timeline({
                    rows: meterRows.filter((row) => row.spec.id === spec.id),
                    label: `${spec.label} detail`,
                  })
                }
              />
            ),
          },
        ]
      : [
          {
            id: 'timeline',
            label: 'Timeline',
            render: () => timeline({ rows: meterRows, label: 'Linked meters' }),
          },
        ]
  const open = (id: string) => () => {
    setSelected(id)
    setOpenPanel(detailPanel)
  }
  const expanded = openPanel === detailPanel
  const freezeSegment: DevbarSegment = {
    id: 'meters.freeze',
    priority: 7,
    render: () => (
      <button
        type="button"
        aria-pressed={frozenAtMs !== undefined}
        onClick={() =>
          setFrozenAtMs((current) => (current === undefined ? meters.clock.now() : undefined))
        }
        {...stylex.props(styles.segmentButton, frozenAtMs !== undefined && styles.pressed)}
      >
        <span {...stylex.props(styles.segmentLabel)}>
          {frozenAtMs === undefined ? 'freeze' : 'frozen at'}
        </span>
        {frozenAtMs !== undefined && (
          <span {...stylex.props(styles.segmentValue)}>{seconds(frozenAtMs)}</span>
        )}
      </button>
    ),
  }
  const segments: readonly DevbarSegment[] = [
    ...(variant === 'B' ? [] : [freezeSegment]),
    ...meterRows.map(
      (row): DevbarSegment => ({
        id: row.spec.id,
        priority: row.priority,
        render: () =>
          variant === 'B' ? (
            <TrendSegment meters={meters} row={row} theme={theme} onOpen={open(row.spec.id)} />
          ) : (
            <StripSegment
              meters={meters}
              row={row}
              theme={stripTheme}
              frozenAtMs={frozenAtMs}
              expanded={expanded && selected === row.spec.id}
              controls={expanded === true ? timelineId : undefined}
              describedBy={inspection?.id === row.spec.id ? cardId : undefined}
              tileRef={(element) => {
                if (element !== null && row.spec.id === pinnedId) setPinnedTile(element)
              }}
              onOpen={open(row.spec.id)}
              onInspect={({ trigger, tile }) => inspect({ id: row.spec.id, trigger, tile })}
              onDismiss={dismiss}
            />
          ),
      }),
    ),
    { id: 'api.subscriptions', priority: 5, render: () => <SubscriptionsText meters={meters} /> },
  ]
  return (
    <>
      {inspection !== undefined && <EvidenceCard id={cardId} inspection={inspection} />}
      <Devbar
        placement="container"
        panels={panels}
        openPanel={openPanel}
        onOpenPanelChange={setOpenPanel}
        stripMinWidth={0}
        segments={segments}
      />
    </>
  )
}

const defaultFrameHeightPx = 600

const MeterVariants = (props: MeterVariantsProps): React.ReactNode => {
  const meters = useReplayMeters({ playback: props.playback, scenario: props.scenario })
  const width = widths.find((item) => item.id === props.width) ?? widths[0]!
  const variant = variants.find((item) => item.id === props.variant) ?? variants[0]!
  const scenario = scenarios.find((item) => item.id === props.scenario) ?? scenarios[0]!
  return (
    <section
      aria-label={`Variant ${variant.id} at ${width.px} px, ${scenario.id}`}
      {...stylex.props(styles.frame(width.px, props.heightPx ?? defaultFrameHeightPx))}
    >
      <p {...stylex.props(styles.caption)}>
        <span {...stylex.props(styles.captionId)}>
          {variant.id} · {width.px}px · {variant.verdict}
        </span>{' '}
        {variant.description}
        <br />
        <span {...stylex.props(styles.muted)}>
          {scenario.id}: {scenario.description}. Scripted {recordingDurationMs / 1000} s recording
          replayed through meters series/sources ({props.playback}):{' '}
          {recordingPhases
            .map((phase) => `${phase.label} ${phase.fromMs / 1000}–${phase.toMs / 1000} s`)
            .join(', ')}
          . Msg bars stack delta / snapshot, red ticks are message errors; HTTP shows p50 with a
          muted p95 tail, red ticks are failed requests; ↻ marks a WebSocket recovery.
        </span>
      </p>
      {meters !== undefined && (
        <VariantDevbar
          // Remount on fixture change so panel, freeze and pinned evidence match the args.
          key={`${props.variant}-${props.panelOpen}-${props.playback}-${props.scenario}-${props.frozen}-${props.inspect}`}
          {...props}
          meters={meters}
        />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------------------------
// Colocated picker (sk-explore-variants)
// ---------------------------------------------------------------------------------------------

const VariantPicker = <TId extends string>(props: {
  readonly label: string
  readonly options: readonly { readonly id: TId; readonly description: string }[]
  readonly value: TId
  readonly onChange: (value: TId) => void
}): React.ReactNode => (
  <div role="radiogroup" aria-label={props.label} {...stylex.props(styles.pickerRow)}>
    <span {...stylex.props(styles.pickerLabel)}>{props.label}</span>
    {props.options.map((option) => (
      <button
        key={option.id}
        type="button"
        role="radio"
        aria-checked={option.id === props.value}
        onClick={() => props.onChange(option.id)}
        {...stylex.props(styles.pickerOption, option.id === props.value && styles.pickerSelected)}
      >
        {option.id}
      </button>
    ))}
    <span {...stylex.props(styles.pickerDescription)}>
      ← {props.options.find((option) => option.id === props.value)?.description}
    </span>
  </div>
)

const Explorer = (props: MeterVariantsProps): React.ReactNode => {
  const [variant, setVariant] = React.useState(props.variant)
  const [width, setWidth] = React.useState(props.width)
  const [playback, setPlayback] = React.useState(props.playback)
  const [scenario, setScenario] = React.useState(props.scenario)
  return (
    <div style={{ padding: '1rem' }}>
      <div {...stylex.props(styles.picker)}>
        <VariantPicker label="Variant" options={variants} value={variant} onChange={setVariant} />
        <VariantPicker label="Width" options={widths} value={width} onChange={setWidth} />
        <VariantPicker
          label="Playback"
          options={playbacks}
          value={playback}
          onChange={setPlayback}
        />
        <VariantPicker
          label="Scenario"
          options={scenarios}
          value={scenario}
          onChange={setScenario}
        />
      </div>
      <MeterVariants
        {...props}
        variant={variant}
        width={width}
        playback={playback}
        scenario={scenario}
      />
    </div>
  )
}

const meta = {
  title: 'Developer Bar/Meter Variants',
  component: MeterVariants,
  parameters: { layout: 'fullscreen' },
  args: {
    variant: 'A',
    width: 'W1440',
    playback: 'Pinned',
    scenario: 'Recording',
    frozen: false,
    panelOpen: true,
  },
  argTypes: {
    variant: { control: 'inline-radio', options: ['A', 'B', 'C'] },
    width: { control: 'inline-radio', options: ['W1440', 'W900', 'W600'] },
    playback: { control: 'inline-radio', options: ['Pinned', 'Live'] },
    scenario: {
      control: 'inline-radio',
      options: scenarios.map((scenario) => scenario.id),
    },
    frozen: { control: 'boolean' },
    inspect: { control: 'select', options: meterRows.map((row) => row.spec.id) },
    heightPx: { table: { disable: true } },
    dark: { table: { disable: true } },
  },
  // oxlint-disable-next-line overeng/named-args -- Storybook render receives positional args/context.
  render: (args, context) => <MeterVariants {...args} dark={context.globals['theme'] === 'dark'} />,
} satisfies Meta<typeof MeterVariants>
export default meta

type Story = StoryObj<typeof meta>

/** Variant picker with inline descriptions; starts live so the bars move. */
export const Explore: Story = {
  args: { playback: 'Live' },
  // oxlint-disable-next-line overeng/named-args -- Storybook render receives positional args/context.
  render: (args, context) => <Explorer {...args} dark={context.globals['theme'] === 'dark'} />,
}

/** A: canvas strip segments at desktop width; Meters panel shows the selected meter's detail. */
export const VariantA1440: Story = { args: { variant: 'A', width: 'W1440' } }
/** A at 900 px: the same priorities through `fitSegments`. */
export const VariantA900: Story = { args: { variant: 'A', width: 'W900' } }
/** B (NO-GO, unchanged): compact values + tiny trends; the linked Timeline panel is open. */
export const VariantB1440: Story = { args: { variant: 'B', width: 'W1440' } }
/** B at 900 px: lowest-priority value segments move into the +N overflow. */
export const VariantB900: Story = { args: { variant: 'B', width: 'W900' } }
/** C: canvas strips in the bar plus the linked Timeline panel. */
export const VariantC1440: Story = { args: { variant: 'C', width: 'W1440' } }
/** C at 900 px. */
export const VariantC900: Story = { args: { variant: 'C', width: 'W900' } }

/** Fixture states for the bar strips, each with a pinned evidence snapshot where it applies. */
const stateFrames: readonly {
  readonly heading: string
  readonly props: Partial<MeterVariantsProps>
}[] = [
  {
    heading: 'C · no data: sources registered, nothing sampled before evaluation',
    props: { variant: 'C', scenario: 'NoData', inspect: 'api.messages' },
  },
  {
    heading: 'C · stale: evaluated 15 s after the last sample',
    props: { variant: 'C', scenario: 'Stale', inspect: 'http.latency' },
  },
  {
    heading: 'C · disconnected: evaluated mid WebSocket outage',
    props: { variant: 'C', scenario: 'Disconnected', inspect: 'ws.status' },
  },
  {
    heading: 'A · frozen: bar and evidence read one snapshot',
    props: { variant: 'A', frozen: true, inspect: 'react.commits' },
  },
  {
    heading: 'A · 600 px: low-priority strips overflow into +N',
    props: { variant: 'A', width: 'W600' },
  },
]

/** Every variant at both widths, then the fixture states, stacked for side-by-side review. */
export const AllStates: Story = {
  // oxlint-disable-next-line overeng/named-args -- Storybook render receives positional args/context.
  render: (args, context) => (
    <div {...stylex.props(styles.collection)}>
      {variants.flatMap((variant) =>
        (['W1440', 'W900'] as const).map((width) => (
          <MeterVariants
            key={`${variant.id}-${width}`}
            {...args}
            variant={variant.id}
            width={width}
            dark={context.globals['theme'] === 'dark'}
          />
        )),
      )}
      {stateFrames.map((frame) => (
        <div key={frame.heading}>
          <h3 {...stylex.props(styles.stateHeading)}>{frame.heading}</h3>
          <MeterVariants
            {...args}
            width="W1440"
            panelOpen={false}
            heightPx={240}
            {...frame.props}
            dark={context.globals['theme'] === 'dark'}
          />
        </div>
      ))}
    </div>
  ),
}
