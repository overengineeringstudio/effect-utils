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
} from './recording.ts'

// ---------------------------------------------------------------------------------------------
// Variant vocabulary (stable IDs for feedback: "A at 900", "B timeline", …)
// ---------------------------------------------------------------------------------------------

type VariantId = 'A' | 'B' | 'C'
type WidthId = 'W1440' | 'W900' | 'W600'

const variants: readonly { readonly id: VariantId; readonly description: string }[] = [
  {
    id: 'A',
    description:
      'Compact ~64 px canvas strips with the value drawn in the bar; low-priority strips overflow into +N on narrow bars.',
  },
  {
    id: 'B',
    description:
      'Compact text values with a tiny trend; one linked Timeline panel aligns msg, HTTP, WS, commit, long frames and FPS on one time axis.',
  },
  {
    id: 'C',
    description:
      'A’s canvas strips in the bar; clicking any strip opens B’s linked Timeline panel.',
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

/** Compose any block with danger ticks for a second event series (here: failed requests). */
const withEventTicks = <TTick,>(options: {
  readonly spec: CanvasBlockSpec
  readonly ticks: Series<TTick>
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
      const tickHeight = Math.max(3, Math.min(6, chart.height / 2))
      for (let index = 0; index < ticks.length; index++) {
        const sample = ticks.at(index)
        if (sample?._tag !== 'Value' || sample.atMs < nowMs - input.historyMs) continue
        const x = Math.round(
          historyX({ atMs: sample.atMs, nowMs, historyMs: input.historyMs, rect: chart }),
        )
        ctx.fillRect(x, chart.y, 1, tickHeight)
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
  readonly spec: CanvasBlockSpec
  readonly shortLabel: string
  /** Higher stays longer in the bar (Devbar `fitSegments`). */
  readonly priority: number
  readonly trend: Trend
  readonly readoutAt: (options: { readonly store: SeriesStore; readonly atMs: number }) => string
}

const segmentWidthPx = 64

const meterRows: readonly MeterRow[] = [
  {
    shortLabel: 'msg',
    priority: 6,
    spec: numericBlock({
      id: 'api.messages',
      series: recordingSeries.messages,
      shortLabel: 'msg',
      widthPx: segmentWidthPx,
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
    priority: 4,
    spec: withEventTicks({
      spec: numericBlock({
        id: 'http.latency',
        series: recordingSeries.httpLatency,
        shortLabel: 'http',
        widthPx: segmentWidthPx,
        // p50 band (normal) with the p50→p95 tail stacked on top (warning).
        values: (value) => [value.p50Ms, Math.max(0, value.p95Ms - value.p50Ms)],
        describeValue: ({ value, format }) =>
          format === 'full'
            ? `${value.p50Ms}/${value.p95Ms}ms`
            : format === 'compact'
              ? formatMeterValue({ value: value.p95Ms, unit: 'ms', format })
              : `${value.p95Ms}`,
      }),
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
      return `p50 ${found.value.p50Ms} ms · p95 ${found.value.p95Ms} ms${errors.length > 0 ? ` · ${errors.length} failed (${statuses}) in last 1 s` : ''}`
    },
  },
  {
    shortLabel: 'commit',
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
      if (commits.length === 0) return 'no commits in last 1 s'
      const worst = Math.max(...commits.map((commit) => commit.actualDurationMs))
      return `${commits.length} commits in last 1 s · worst ${worst.toFixed(1)} ms`
    },
  },
  {
    shortLabel: 'jank',
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
        ? 'none in last 1 s'
        : `${frames.length} long frame${frames.length === 1 ? '' : 's'} · worst ${Math.max(...frames.map((frame) => frame.durationMs))} ms`
    },
  },
  {
    shortLabel: 'fps',
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
const useReplayMeters = (playback: Playback): Meters | undefined => {
  const [started, setStarted] = React.useState<
    { readonly playback: Playback; readonly meters: Meters } | undefined
  >(undefined)
  React.useEffect(() => {
    const meters = makeReplayMeters(playback)
    return runScoped(
      meters.start.pipe(
        Effect.andThen(Effect.sync(() => setStarted({ playback, meters }))),
        Effect.andThen(Effect.never),
      ),
    )
  }, [playback])
  return started?.playback === playback ? started.meters : undefined
}

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
  frame: (widthPx: number) => ({
    position: 'relative',
    width: widthPx,
    height: '600px',
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
  timeline: { position: 'relative', paddingBlock: '0.5rem', minWidth: 0 },
  timelineCanvas: {
    display: 'block',
    outlineWidth: { default: 0, ':focus-visible': 2 },
    outlineStyle: 'solid',
    outlineColor: devbarTokens.focusRing,
  },
  readout: {
    position: 'absolute',
    top: '0.5rem',
    zIndex: 1,
    margin: 0,
    paddingBlock: '0.375rem',
    paddingInline: '0.5rem',
    pointerEvents: 'none',
    fontFamily: devbarTokens.fontData,
    fontSize: '0.6875rem',
    lineHeight: 1.5,
    whiteSpace: 'nowrap',
    backgroundColor: devbarTokens.canvas,
    color: devbarTokens.text,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: devbarTokens.border,
    borderRadius: '0.25rem',
  },
  readoutTerm: { color: devbarTokens.mutedText, paddingRight: '0.75rem' },
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
})

/** Variant A/C: one existing canvas block rendered by the existing canvas strip renderer. */
const StripSegment = (props: {
  readonly meters: Meters
  readonly row: MeterRow
  readonly theme: MeterTheme
  readonly onOpen: () => void
}): React.ReactNode => {
  const text = useStripText({ meters: props.meters, spec: props.row.spec })
  // Fills the 32 px bar row minus its border, leaving a ~10 px trend under the value.
  const heightPx = 30
  const attach = React.useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (canvas === null) return undefined
      return runScoped(
        makeCanvasStrip({
          canvas,
          meters: props.meters,
          blocks: [props.row.spec],
          heightPx,
          gapPx: 0,
          historyMs,
          readTheme: () => props.theme,
        }).attach.pipe(Effect.andThen(Effect.never)),
      )
    },
    [props.meters, props.row.spec, props.theme],
  )
  return (
    <button
      type="button"
      aria-label={`${props.row.spec.label} ${text}`}
      title={`${props.row.spec.label}: ${text} (last ${historyMs / 1000} s)`}
      onClick={props.onOpen}
      {...stylex.props(styles.segmentButton, styles.stripButton)}
    >
      <div style={{ width: segmentWidthPx, height: heightPx }}>
        <canvas ref={attach} aria-hidden="true" style={{ display: 'block' }} />
      </div>
    </button>
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

const TimelineCanvas = (props: {
  readonly meters: Meters
  readonly rows: readonly MeterRow[]
  readonly theme: MeterTheme
  readonly label: string
}): React.ReactNode => {
  const { meters, rows, theme } = props
  const [containerRef, containerWidth] = useElementWidth()
  const widthPx = containerWidth === undefined ? undefined : Math.max(240, containerWidth)
  const heightPx = rows.length * (rowHeightPx + rowGapPx) + axisHeightPx
  const readers = React.useMemo(
    () => rows.map((row) => row.spec.read(meters.store)),
    [rows, meters],
  )
  /** Crosshair x in CSS pixels; its time is derived from the clock at read time. */
  const [cursor, setCursor] = React.useState<{ readonly x: number } | undefined>(undefined)
  const paint = React.useCallback(
    ({
      ctx,
      nowMs,
      widthPx: width,
    }: {
      readonly ctx: CanvasRenderingContext2D
      readonly nowMs: number
      readonly widthPx: number
    }) => {
      let top = 0
      for (const reader of readers) {
        reader.draw({
          ctx,
          rect: { x: 0, y: top, width, height: rowHeightPx },
          nowMs,
          historyMs,
          theme,
        })
        top += rowHeightPx + rowGapPx
      }
      // One axis for every row: identical chart insets make every row share these x positions.
      const axis = chartRect({ x: 0, y: 0, width, height: rowHeightPx })
      ctx.font = theme.font
      ctx.textBaseline = 'top'
      for (let secondsAgo = 0; secondsAgo <= historyMs / 1000; secondsAgo += 10) {
        const x = Math.round(
          historyX({ atMs: nowMs - secondsAgo * 1000, nowMs, historyMs, rect: axis }),
        )
        ctx.fillStyle = theme.border
        ctx.globalAlpha = 0.7
        let rowTop = 0
        for (let index = 0; index < readers.length; index++) {
          ctx.fillRect(x, rowTop + 18, 1, rowHeightPx - 20)
          rowTop += rowHeightPx + rowGapPx
        }
        ctx.globalAlpha = 1
        const label = secondsAgo === 0 ? 'now' : `−${secondsAgo}s`
        const run = fitText({
          text: label,
          maxWidth: 48,
          measure: (text) => ctx.measureText(text).width,
        })
        if (run === undefined) continue
        ctx.fillStyle = theme.muted
        const textX = Math.min(width - run.width, Math.max(0, x - run.width / 2))
        ctx.fillText(run.text, textX, top + 3)
      }
      if (cursor !== undefined) {
        ctx.fillStyle = theme.focus
        ctx.fillRect(Math.round(cursor.x), 0, 1, top)
      }
    },
    [readers, theme, cursor],
  )
  const attach = usePaintedCanvas({ meters, widthPx, heightPx, paint })
  const axis = chartRect({ x: 0, y: 0, width: widthPx ?? 0, height: rowHeightPx })
  const clampX = (x: number): number => Math.max(axis.x, Math.min(axis.x + axis.width, x))
  const cursorAtMs =
    cursor === undefined
      ? undefined
      : meters.clock.now() - historyMs + ((cursor.x - axis.x) / axis.width) * historyMs
  return (
    <div ref={containerRef} {...stylex.props(styles.timeline)}>
      <canvas
        ref={attach}
        tabIndex={0}
        role="img"
        aria-label={`${props.label}: ${rows.map((row) => row.spec.label).join(', ')} over the last ${historyMs / 1000} s on one shared time axis. Use arrow keys to move the crosshair.`}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect()
          setCursor({ x: clampX(event.clientX - bounds.left) })
        }}
        onPointerLeave={() => setCursor(undefined)}
        onKeyDown={(event) => {
          const step = axis.width / (historyMs / 1000)
          if (event.key === 'Escape') setCursor(undefined)
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            setCursor((current) => ({
              x: clampX(
                (current?.x ?? axis.x + axis.width) + (event.key === 'ArrowLeft' ? -step : step),
              ),
            }))
          }
        }}
        {...stylex.props(styles.timelineCanvas)}
      />
      {cursor !== undefined && cursorAtMs !== undefined && (
        <dl
          aria-live="polite"
          {...stylex.props(styles.readout)}
          style={
            cursor.x > (widthPx ?? 0) / 2
              ? { right: (widthPx ?? 0) - cursor.x + 20 }
              : { left: cursor.x + 20 }
          }
        >
          <div>
            <dt {...stylex.props(styles.readoutTerm)} style={{ display: 'inline' }}>
              at
            </dt>
            <dd style={{ display: 'inline', margin: 0 }}>
              −{((meters.clock.now() - cursorAtMs) / 1000).toFixed(1)} s
            </dd>
          </div>
          {rows.map((row) => (
            <div key={row.spec.id}>
              <dt {...stylex.props(styles.readoutTerm)} style={{ display: 'inline' }}>
                {row.shortLabel}
              </dt>
              <dd style={{ display: 'inline', margin: 0 }}>
                {row.readoutAt({ store: meters.store, atMs: cursorAtMs })}
              </dd>
            </div>
          ))}
        </dl>
      )}
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
  /** Open the variant's panel initially (Meters for A, Timeline for B/C). */
  readonly panelOpen: boolean
  readonly dark?: boolean
}

const VariantDevbar = (
  props: MeterVariantsProps & { readonly meters: Meters },
): React.ReactNode => {
  const { meters, variant } = props
  const theme = props.dark === true ? darkMeterTheme : lightMeterTheme
  const detailPanel = variant === 'A' ? 'meters' : 'timeline'
  const [openPanel, setOpenPanel] = React.useState<string | undefined>(
    props.panelOpen === true ? detailPanel : undefined,
  )
  const [selected, setSelected] = React.useState<string>('api.messages')
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
                renderDetail={(spec) => (
                  <TimelineCanvas
                    meters={meters}
                    rows={meterRows.filter((row) => row.spec.id === spec.id)}
                    theme={theme}
                    label={`${spec.label} detail`}
                  />
                )}
              />
            ),
          },
        ]
      : [
          {
            id: 'timeline',
            label: 'Timeline',
            render: () => (
              <TimelineCanvas
                meters={meters}
                rows={meterRows}
                theme={theme}
                label="Linked meters"
              />
            ),
          },
        ]
  const open = (id: string) => () => {
    setSelected(id)
    setOpenPanel(detailPanel)
  }
  const segments: readonly DevbarSegment[] = [
    ...meterRows.map(
      (row): DevbarSegment => ({
        id: row.spec.id,
        priority: row.priority,
        render: () =>
          variant === 'B' ? (
            <TrendSegment meters={meters} row={row} theme={theme} onOpen={open(row.spec.id)} />
          ) : (
            <StripSegment meters={meters} row={row} theme={theme} onOpen={open(row.spec.id)} />
          ),
      }),
    ),
    { id: 'api.subscriptions', priority: 5, render: () => <SubscriptionsText meters={meters} /> },
  ]
  return (
    <Devbar
      placement="container"
      panels={panels}
      openPanel={openPanel}
      onOpenPanelChange={setOpenPanel}
      stripMinWidth={0}
      segments={segments}
    />
  )
}

const MeterVariants = (props: MeterVariantsProps): React.ReactNode => {
  const meters = useReplayMeters(props.playback)
  const width = widths.find((item) => item.id === props.width) ?? widths[0]!
  const variant = variants.find((item) => item.id === props.variant) ?? variants[0]!
  return (
    <section
      aria-label={`Variant ${variant.id} at ${width.px} px`}
      {...stylex.props(styles.frame(width.px))}
    >
      <p {...stylex.props(styles.caption)}>
        <span {...stylex.props(styles.captionId)}>
          {variant.id} · {width.px}px
        </span>{' '}
        {variant.description}
        <br />
        <span {...stylex.props(styles.muted)}>
          Scripted {recordingDurationMs / 1000} s recording replayed through meters series/sources (
          {props.playback}):{' '}
          {recordingPhases
            .map((phase) => `${phase.label} ${phase.fromMs / 1000}–${phase.toMs / 1000} s`)
            .join(', ')}
          . Msg bars stack delta / snapshot / error; HTTP stacks p50 and the p95 tail, red ticks are
          failed requests; ↻ marks a WebSocket recovery.
        </span>
      </p>
      {meters !== undefined && (
        <VariantDevbar
          // Remount on variant change so the initial panel matches the variant.
          key={`${props.variant}-${props.panelOpen}`}
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
      </div>
      <MeterVariants {...props} variant={variant} width={width} playback={playback} />
    </div>
  )
}

const meta = {
  title: 'Developer Bar/Meter Variants',
  component: MeterVariants,
  parameters: { layout: 'fullscreen' },
  args: { variant: 'A', width: 'W1440', playback: 'Pinned', panelOpen: true },
  argTypes: {
    variant: { control: 'inline-radio', options: ['A', 'B', 'C'] },
    width: { control: 'inline-radio', options: ['W1440', 'W900', 'W600'] },
    playback: { control: 'inline-radio', options: ['Pinned', 'Live'] },
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
/** B: compact values + tiny trends; the linked Timeline panel is open. */
export const VariantB1440: Story = { args: { variant: 'B', width: 'W1440' } }
/** B at 900 px: lowest-priority value segments move into the +N overflow. */
export const VariantB900: Story = { args: { variant: 'B', width: 'W900' } }
/** C: canvas strips in the bar plus the linked Timeline panel. */
export const VariantC1440: Story = { args: { variant: 'C', width: 'W1440' } }
/** C at 900 px. */
export const VariantC900: Story = { args: { variant: 'C', width: 'W900' } }

/** Every variant at both widths, stacked for side-by-side comparison. */
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
    </div>
  ),
}
