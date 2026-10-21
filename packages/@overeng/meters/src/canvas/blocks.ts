import {
  validateId,
  type Retention,
  type Sample,
  type Series,
  type SeriesStore,
  type SeriesView,
  type Unit,
  type UnavailableReason,
} from '../series/index.ts'
import { scanBins } from '../series/internal.ts'
import type { FpsValue } from '../session/frame.ts'
import { fitText, historyX, layoutBlockText, type Rect, type TextRun } from './layout.ts'

/** Semantic color/font values; hosts may resolve StyleX tokens or CSS variables. */
export interface MeterTheme {
  readonly background: string
  readonly foreground: string
  readonly muted: string
  readonly border: string
  readonly normal: string
  readonly warning: string
  readonly danger: string
  readonly gap: string
  readonly focus: string
  readonly font: string
}
/** A light semantic theme, independent of any styling framework. */
export const lightMeterTheme: MeterTheme = {
  background: '#ffffff',
  foreground: '#171717',
  muted: '#525252',
  border: '#d4d4d4',
  normal: '#15803d',
  warning: '#a16207',
  danger: '#b91c1c',
  gap: '#a3a3a3',
  focus: '#2563eb',
  font: '11px monospace',
}
/** A dark semantic theme, independent of any styling framework. */
export const darkMeterTheme: MeterTheme = {
  background: '#171717',
  foreground: '#fafafa',
  muted: '#a3a3a3',
  border: '#404040',
  normal: '#4ade80',
  warning: '#facc15',
  danger: '#f87171',
  gap: '#737373',
  focus: '#60a5fa',
  font: '11px monospace',
}
/** Typed, read-only drawing input. */
export interface DrawInput<TValue> {
  readonly ctx: CanvasRenderingContext2D
  readonly rect: Rect
  readonly history: SeriesView<TValue>
  readonly nowMs: number
  readonly historyMs: number
  readonly theme: MeterTheme
}
/** Latest observations by default; completed buckets use an explicit output unit. */
export type BlockAggregation =
  | { readonly _tag: 'Latest' }
  | {
      readonly _tag: 'Bucket'
      readonly mode: 'Gauge' | 'Event' | 'Counter'
      readonly bucketMs: number
      readonly buckets: number
      readonly unit: Unit
    }
/** Bucket endpoints are derived from evaluation time, never cached in a reader. */
export type BlockAggregationEvidence =
  | { readonly _tag: 'Latest' }
  | (Extract<BlockAggregation, { readonly _tag: 'Bucket' }> & { readonly endMs: number })
const latestAggregation: BlockAggregationEvidence = { _tag: 'Latest' }
/** Resolve completed session-clock buckets without allocating history/bin arrays. */
export const resolveBlockAggregation = (options: {
  readonly aggregation?: BlockAggregation
  readonly nowMs: number
}): BlockAggregationEvidence => {
  const policy = options.aggregation
  if (policy === undefined || policy._tag === 'Latest') return latestAggregation
  const spanMs = policy.bucketMs * policy.buckets
  const endMs = Math.floor(options.nowMs / policy.bucketMs) * policy.bucketMs
  if (
    Number.isFinite(options.nowMs) === false ||
    Number.isFinite(policy.bucketMs) === false ||
    policy.bucketMs <= 0 ||
    Number.isInteger(policy.buckets) === false ||
    policy.buckets <= 0 ||
    Number.isFinite(spanMs) === false ||
    Number.isFinite(endMs) === false ||
    Number.isFinite(endMs - spanMs) === false ||
    Number.isFinite(policy.buckets * spanMs) === false
  )
    throw new TypeError(
      'Block buckets require finite derived endpoints and positive duration/count',
    )
  return {
    _tag: 'Bucket',
    mode: policy.mode,
    bucketMs: policy.bucketMs,
    buckets: policy.buckets,
    unit: policy.unit,
    endMs,
  }
}

/** Bounds of the values a block reduced, over an explicit window ending at `endMs`. */
export interface BlockEvidenceRange {
  readonly windowMs: number
  readonly endMs: number
  readonly minimum: number
  readonly maximum: number
}
/** On-demand renderer evidence; payloads stay inside the bound typed closure. */
export interface BlockEvidence {
  readonly label: string
  readonly unit: Unit
  readonly text: string
  readonly evaluatedAtMs: number
  readonly revision: number
  readonly latest:
    | { readonly _tag: 'Value'; readonly atMs: number }
    | {
        readonly _tag: 'Unavailable'
        readonly atMs: number
        readonly reason: UnavailableReason
        readonly lastKnownAtMs?: number
      }
    | {
        readonly _tag: 'Gap'
        readonly atMs: number
        readonly durationMs: number
        readonly reason: Extract<Sample<never>, { readonly _tag: 'Gap' }>['reason']
      }
    | undefined
  readonly retention: Retention
  readonly aggregation: BlockAggregationEvidence
  /** Present only for blocks that reduce a window; absent when the window holds no value. */
  readonly range?: BlockEvidenceRange | undefined
}
/** Bound drawing and describing closures; no write or acquisition capability. */
export interface BlockReader {
  readonly revision: () => number
  readonly describe: (options: { readonly nowMs: number }) => string
  readonly evidence: (options: { readonly nowMs: number }) => BlockEvidence
  readonly draw: (input: Omit<DrawInput<never>, 'history'>) => void
  readonly snapshot: () => BlockReader
}
/** Heterogeneous blocks preserve payload typing inside their reader closures. */
export interface CanvasBlockSpec {
  readonly id: string
  readonly label: string
  /** Compact label used by the canvas and as the accessible-name prefix when supplied. */
  readonly shortLabel?: string | undefined
  /** Nominal width; blocks shrink below it only when the strip has too little space. */
  readonly widthPx: number
  readonly read: (store: SeriesStore) => BlockReader
}
/** Close over a typed series without erasing its payload type. */
export const block = <TValue>(options: {
  readonly id: string
  readonly series: Series<TValue>
  readonly shortLabel?: string | undefined
  readonly widthPx: number
  readonly aggregation?: BlockAggregation
  readonly draw: (input: DrawInput<TValue>) => void
  readonly describe: (input: {
    readonly history: SeriesView<TValue>
    readonly nowMs: number
  }) => string
  /** Optional reduced-window bounds reported by on-demand evidence, never drawn. */
  readonly range?: (input: {
    readonly history: SeriesView<TValue>
    readonly nowMs: number
  }) => BlockEvidenceRange | undefined
}): CanvasBlockSpec => {
  validateId(options.id)
  if (Number.isFinite(options.widthPx) === false || options.widthPx <= 0)
    throw new TypeError('Block width must be positive')
  const aggregationPolicy = options.aggregation ?? latestAggregation
  resolveBlockAggregation({ aggregation: aggregationPolicy, nowMs: 0 })
  const bind = (history: SeriesView<TValue>): BlockReader => ({
    revision: () => history.revision,
    describe: ({ nowMs }) => options.describe({ history, nowMs }),
    evidence: ({ nowMs }) => {
      const latest = history.latest
      const aggregation = resolveBlockAggregation({ aggregation: aggregationPolicy, nowMs })
      const range = options.range?.({ history, nowMs })
      return {
        label: options.series.label,
        unit: aggregation._tag === 'Bucket' ? aggregation.unit : options.series.unit,
        text: options.describe({ history, nowMs }),
        evaluatedAtMs: nowMs,
        revision: history.revision,
        latest:
          latest === undefined
            ? undefined
            : latest._tag === 'Value'
              ? { _tag: 'Value', atMs: latest.atMs }
              : latest._tag === 'Unavailable'
                ? {
                    _tag: 'Unavailable',
                    atMs: latest.atMs,
                    reason: latest.reason,
                    ...(latest.lastKnown === undefined
                      ? {}
                      : { lastKnownAtMs: latest.lastKnown.atMs }),
                  }
                : {
                    _tag: 'Gap',
                    atMs: latest.atMs,
                    reason: latest.reason,
                    durationMs: latest.durationMs,
                  },
        retention: {
          capacity: history.capacity,
          length: history.length,
          oldestAtMs: history.oldestAtMs,
          newestAtMs: history.newestAtMs,
          overflowCount: history.overflowCount,
          firstRetainedSequence: history.firstRetainedSequence,
          nextSequence: history.nextSequence,
        },
        aggregation,
        ...(range === undefined ? {} : { range }),
      }
    },
    draw: (input) => options.draw({ ...input, history }),
    snapshot: () => {
      // oxlint-disable-next-line overeng/named-args -- Native Array.from map callback signature.
      const samples = Array.from({ length: history.length }, (_, index) => history.at(index))
      const frozen: SeriesView<TValue> = {
        capacity: history.capacity,
        length: history.length,
        oldestAtMs: history.oldestAtMs,
        newestAtMs: history.newestAtMs,
        overflowCount: history.overflowCount,
        firstRetainedSequence: history.firstRetainedSequence,
        nextSequence: history.nextSequence,
        revision: history.revision,
        latest: history.latest,
        at: (index) => samples[index],
      }
      return bind(frozen)
    },
  })
  return {
    id: options.id,
    label: options.series.label,
    ...(options.shortLabel === undefined ? {} : { shortLabel: options.shortLabel }),
    widthPx: options.widthPx,
    read: (store) => bind(store.read({ series: options.series })),
  }
}
type MeterValueFormat = 'full' | 'compact' | 'number'
/** Format observed scalars; compact forms round in the same displayed unit. */
export const formatMeterValue = (options: {
  readonly value: number
  readonly unit: Unit
  readonly format?: MeterValueFormat
}): string => {
  const format = options.format ?? 'full'
  let value = options.value
  let unit: string = options.unit
  if (options.unit === 'bytes') {
    if (value >= 1024 ** 3) {
      value /= 1024 ** 3
      unit = 'GiB'
    } else if (value >= 1024 ** 2) {
      value /= 1024 ** 2
      unit = 'MiB'
    } else if (value >= 1024) {
      value /= 1024
      unit = 'KiB'
    } else unit = 'B'
  }
  const number =
    format !== 'full' || unit === 'B'
      ? value.toFixed(0)
      : options.unit === 'bytes' || Number.isInteger(value) === false
        ? value.toFixed(1)
        : String(value)
  if (format === 'number' || options.unit === 'count') return number
  return `${number}${format === 'compact' ? '' : ' '}${unit}`
}
/** Bounds in the same units as plotted values. */
export interface PlotRange {
  readonly lo: number
  readonly hi: number
}
const validateScale = (options: {
  readonly nominalMax: number
  readonly minSpanRatio: number
}): void => {
  if (
    Number.isFinite(options.nominalMax) === false ||
    options.nominalMax <= 0 ||
    Number.isFinite(options.minSpanRatio) === false ||
    options.minSpanRatio <= 0
  )
    throw new TypeError('Plot scale and minimum span ratio must be finite and positive')
}
const validateRange = (range: PlotRange): void => {
  if (
    Number.isFinite(range.lo) === false ||
    Number.isFinite(range.hi) === false ||
    range.hi <= range.lo
  )
    throw new TypeError('Plot bounds must be finite and increasing')
}
// The renderer reuses its target; scanning samples never allocates a history array per frame.
const resolveRange = (options: {
  readonly minimum: number
  readonly maximum: number
  readonly nominalMax: number
  readonly minSpanRatio: number
  readonly mode: 'auto' | 'fixed'
  readonly target: { lo: number; hi: number }
}): void => {
  const { minimum, maximum, nominalMax, minSpanRatio, target } = options
  if (maximum === -Infinity || options.mode === 'fixed') {
    target.lo = Math.min(0, minimum)
    target.hi = Math.ceil(Math.max(nominalMax, maximum))
    return
  }
  const span = Math.min(
    Number.MAX_VALUE,
    Math.max(maximum - minimum, nominalMax * minSpanRatio) * 1.15,
  )
  const midpoint = minimum / 2 + maximum / 2
  const lo = midpoint - span / 2
  target.lo =
    minimum >= 0
      ? Math.max(0, Math.min(minimum, lo))
      : Math.max(-Number.MAX_VALUE, Math.min(minimum, lo))
  target.hi = Math.min(Number.MAX_VALUE, Math.max(maximum, target.lo + span))
  // Padding can be smaller than one ULP at a large constant sample.
  if (target.hi <= target.lo) {
    target.lo = Math.min(0, minimum)
    target.hi = Math.max(nominalMax, maximum)
  }
}
/** Window range: whole-unit fixed upper bound, or a padded auto range with a minimum span. */
export const plotRange = (options: {
  readonly history: readonly (number | undefined)[]
  readonly nominalMax: number
  readonly mode: 'auto' | 'fixed'
  readonly minSpanRatio?: number
}): PlotRange => {
  const minSpanRatio = options.minSpanRatio ?? 0.1
  validateScale({ nominalMax: options.nominalMax, minSpanRatio })
  let minimum = Infinity
  let maximum = -Infinity
  for (const value of options.history) {
    if (value === undefined || Number.isFinite(value) === false) continue
    minimum = Math.min(minimum, value)
    maximum = Math.max(maximum, value)
  }
  const target = { lo: 0, hi: 1 }
  resolveRange({ ...options, minSpanRatio, minimum, maximum, target })
  return target
}
/** Format both endpoints with the same formatter used by meter values. */
export const formatRange = (options: {
  readonly range: PlotRange
  readonly unit: Unit
}): string => {
  validateRange(options.range)
  return `${formatMeterValue({ value: options.range.lo, unit: options.unit })}–${formatMeterValue({ value: options.range.hi, unit: options.unit })}`
}
/** Optional plot policy; omitted range retains the original zero-baseline scaling. */
export interface PlotOptions {
  readonly range?: 'auto' | 'fixed' | PlotRange
  /** Scale in series units; defaults to 1. */
  readonly nominalMax?: number
  readonly minSpanRatio?: number
  readonly marks?: readonly number[]
}
const noValues: readonly number[] = []
/** Options shared by every built-in block builder. */
export interface BlockOptions<TValue> extends PlotOptions {
  readonly id: string
  readonly series: Series<TValue>
  /** Compact label; the full series label remains in the accessible description and tooltip. */
  readonly shortLabel?: string | undefined
  /** Nominal CSS width, 150 by default. */
  readonly widthPx?: number
}
/** Build a time-based scalar or stacked presentation with explicit gaps and availability. */
export const numericBlock = <TValue>(
  options: BlockOptions<TValue> & {
    readonly values: (value: TValue) => number | readonly number[]
    readonly describeValue?: (options: {
      readonly value: TValue
      readonly format: MeterValueFormat
    }) => string
    readonly mode?: 'Gauge' | 'Event' | 'Counter'
  },
): CanvasBlockSpec => {
  const nominalMax = options.nominalMax ?? 1
  const minSpanRatio = options.minSpanRatio ?? 0.1
  validateScale({ nominalMax, minSpanRatio })
  if (typeof options.range === 'object') validateRange(options.range)
  const resolvedRange = { lo: 0, hi: 1 }
  const rangeState = {
    minimum: Infinity,
    maximum: -Infinity,
    nominalMax,
    minSpanRatio,
    mode: typeof options.range === 'string' ? options.range : 'fixed',
    target: resolvedRange,
  } satisfies Parameters<typeof resolveRange>[0]
  const total = (value: TValue): number => {
    const values = options.values(value)
    if (typeof values === 'number') return values
    let sum = 0
    for (const part of values) sum += part
    return sum
  }
  const describe = ({
    history,
    format = 'full',
  }: {
    readonly history: SeriesView<TValue>
    readonly format?: MeterValueFormat
  }): string => {
    const latest = history.latest
    if (latest === undefined) return 'n/a (NoSamples)'
    if (latest._tag === 'Unavailable') {
      if (latest.lastKnown === undefined || format !== 'full') return `n/a (${latest.reason})`
      const value =
        options.describeValue?.({ value: latest.lastKnown.value, format }) ??
        formatMeterValue({
          value: total(latest.lastKnown.value),
          unit: options.series.unit,
          format,
        })
      return `n/a (${latest.reason}; last known ${value} at ${latest.lastKnown.atMs}ms)`
    }
    if (latest._tag === 'Gap') return `n/a (${latest.reason} gap)`
    return (
      options.describeValue?.({ value: latest.value, format }) ??
      formatMeterValue({ value: total(latest.value), unit: options.series.unit, format })
    )
  }
  return block({
    id: options.id,
    series: options.series,
    shortLabel: options.shortLabel,
    widthPx: options.widthPx ?? 150,
    describe: ({ history }) => describe({ history }),
    draw: ({ ctx, rect, history, nowMs, historyMs, theme }) => {
      ctx.save()
      ctx.beginPath()
      ctx.rect(rect.x, rect.y, rect.width, rect.height)
      ctx.clip()
      ctx.fillStyle = theme.background
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
      const chart = {
        x: rect.x + 4,
        y: rect.y + 18,
        width: rect.width - 8,
        height: Math.max(1, rect.height - 20),
      }
      const latest = history.latest
      const dimmed =
        latest?._tag === 'Unavailable' &&
        (latest.reason === 'Stale' || latest.reason === 'Disconnected')
      const bins = Math.max(1, Math.floor(chart.width))
      if (options.range !== undefined) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(chart.x, chart.y, chart.width, chart.height)
        ctx.clip()
      }
      const binDurationMs = historyMs / bins
      const startMs = nowMs - historyMs
      let maximum = options.range === undefined ? 1 : -Infinity
      let minimum = options.range === undefined ? 0 : Infinity
      let aggregate = 0
      let aggregateBin = -1
      let priorValue: number | undefined
      if (options.range !== undefined && (options.mode === 'Event' || options.mode === 'Counter')) {
        // Match completed drawing bins, including held zero bins, but not
        // bins whose newest observation is unavailable or a gap.
        scanBins({
          history,
          endMs: nowMs,
          spanMs: historyMs,
          bins,
          mode: options.mode,
          value: total,
          saturate: true,
          // oxlint-disable-next-line overeng/named-args -- Streaming visitor avoids allocating one object per bin.
          visit: (_bin, atMs, previous, eventTotal) => {
            if (
              previous?._tag !== 'Value' ||
              previous.atMs > atMs ||
              Number.isFinite(eventTotal) === false
            )
              return
            minimum = Math.min(minimum, eventTotal)
            maximum = Math.max(maximum, eventTotal)
          },
        })
      } else {
        for (let cursor = 0; cursor < history.length; cursor++) {
          const sample = history.at(cursor)
          if (sample?._tag !== 'Value') {
            priorValue = undefined
            continue
          }
          const value = total(sample.value)
          if (Number.isFinite(value) === false) {
            priorValue = undefined
            continue
          }
          const increment =
            options.mode === 'Counter'
              ? priorValue === undefined
                ? 0
                : Math.max(0, value - priorValue)
              : value
          priorValue = value
          if (sample.atMs < startMs) {
            if (options.mode === undefined || options.mode === 'Gauge') {
              maximum = options.range === undefined ? Math.max(1, value) : value
              minimum = options.range === undefined ? Math.min(0, value) : value
            }
            continue
          }
          const bin = Math.max(
            0,
            Math.min(bins - 1, Math.ceil((sample.atMs - startMs) / binDurationMs) - 1),
          )
          if (aggregateBin !== bin) {
            aggregate = 0
            aggregateBin = bin
          }
          aggregate += increment
          if (options.range !== undefined)
            aggregate = Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, aggregate))
          maximum = Math.max(
            maximum,
            options.mode === 'Event' || options.mode === 'Counter' ? aggregate : value,
          )
          if (options.range !== undefined || options.mode === undefined || options.mode === 'Gauge')
            minimum = Math.min(minimum, value)
        }
      }
      if (typeof options.range === 'object') {
        minimum = options.range.lo
        maximum = options.range.hi
      } else if (options.range !== undefined) {
        rangeState.minimum = minimum
        rangeState.maximum = maximum
        resolveRange(rangeState)
        minimum = resolvedRange.lo
        maximum = resolvedRange.hi
      }
      // Normalize first so opposite finite extrema cannot overflow the denominator.
      const scale = options.range === undefined ? 1 : Math.max(Math.abs(minimum), Math.abs(maximum))
      const span = maximum / scale - minimum / scale
      scanBins({
        history,
        endMs: nowMs,
        spanMs: historyMs,
        bins,
        mode: options.mode ?? 'Gauge',
        value: total,
        saturate: options.range !== undefined,
        // oxlint-disable-next-line overeng/named-args -- Streaming visitor avoids allocating one object per bin.
        visit: (_bin, atMs, previous, eventTotal) => {
          if (previous === undefined || previous.atMs > atMs) return
          const x = historyX({ atMs: atMs - historyMs / bins, nowMs, historyMs, rect: chart })
          if (previous._tag !== 'Value') {
            ctx.fillStyle = theme.gap
            ctx.fillRect(x, chart.y, chart.width / bins, chart.height)
            return
          }
          const parts =
            options.mode === 'Event' || options.mode === 'Counter'
              ? eventTotal
              : options.values(previous.value)
          let bottom = chart.y + (chart.height * (maximum / scale)) / span
          let stacked = 0
          const partCount = typeof parts === 'number' ? 1 : parts.length
          for (let part = 0; part < partCount; part++) {
            const value = typeof parts === 'number' ? parts : (parts[part] ?? 0)
            if (Number.isFinite(value) === false) continue
            let height = (value / scale / span) * chart.height
            if (options.range !== undefined) {
              const baseline = Math.max(minimum, Math.min(maximum, stacked)) / scale
              stacked = Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, stacked + value))
              const top = Math.max(minimum, Math.min(maximum, stacked)) / scale
              bottom = chart.y + chart.height * ((maximum / scale - baseline) / span)
              height = chart.height * ((top - baseline) / span)
            }
            ctx.fillStyle =
              dimmed === true
                ? theme.muted
                : part % 3 === 0
                  ? theme.normal
                  : part % 3 === 1
                    ? theme.warning
                    : theme.danger
            bottom -= height
            ctx.fillRect(x, bottom, chart.width / bins, height)
          }
        },
      })
      for (const mark of options.marks ?? noValues) {
        if (Number.isFinite(mark) === false || mark < minimum || mark > maximum) continue
        const y = Math.min(
          chart.y + chart.height - 1,
          chart.y + chart.height * ((maximum / scale - mark / scale) / span),
        )
        ctx.fillStyle = theme.border
        ctx.fillRect(chart.x, y, chart.width, 1)
      }
      for (let cursor = 0; cursor < history.length; cursor++) {
        const sample = history.at(cursor)
        if (sample?._tag !== 'Gap') continue
        const x = historyX({ atMs: sample.atMs - sample.durationMs, nowMs, historyMs, rect: chart })
        const end = historyX({ atMs: sample.atMs, nowMs, historyMs, rect: chart })
        ctx.fillStyle = theme.gap
        ctx.fillRect(x, chart.y, Math.max(1, end - x), chart.height)
      }
      if (options.range !== undefined) ctx.restore()
      ctx.font = theme.font
      ctx.textBaseline = 'top'
      ctx.fillStyle = theme.muted
      const measure = (text: string): number => ctx.measureText(text).width
      const header = layoutBlockText({
        rect,
        label: options.series.label,
        shortLabel: options.shortLabel,
        value: describe({ history }),
        compactValue: describe({ history, format: 'compact' }),
        numberValue: describe({ history, format: 'number' }),
        measure,
      })
      ctx.textAlign = 'left'
      if (header.label !== undefined) ctx.fillText(header.label.text, header.label.x, rect.y + 3)
      ctx.fillStyle = theme.foreground
      if (header.value !== undefined) ctx.fillText(header.value.text, header.value.x, rect.y + 3)
      ctx.restore()
    },
  })
}
/** Ordinary numeric gauge history. */
export const numberBlock = <TValue extends { readonly value: number }>(
  options: BlockOptions<TValue> & {
    readonly mode?: 'Gauge' | 'Event' | 'Counter'
  },
): CanvasBlockSpec => numericBlock({ ...options, values: (value) => value.value })
/** Cumulative counter increments aggregated per timestamp bin, not summed totals. */
export const counterBlock = <TValue extends { readonly value: number }>(
  options: BlockOptions<TValue>,
): CanvasBlockSpec => numberBlock({ ...options, mode: 'Counter' })
/** Observed frame timing expressed as FPS, without invented calibration. */
export const frameBlock = (options: BlockOptions<FpsValue>): CanvasBlockSpec =>
  numericBlock({
    ...options,
    values: (value) => (value.durationMs > 0 ? 1000 / value.durationMs : noValues),
    describeValue: ({ value, format }) =>
      value.durationMs > 0
        ? formatMeterValue({ value: 1000 / value.durationMs, unit: 'fps', format })
        : 'n/a (NoSamples)',
  })
/** Heap usage history from actual browser observations. */
export const heapBlock = <TValue extends { readonly usedBytes: number }>(
  options: BlockOptions<TValue>,
): CanvasBlockSpec => numericBlock({ ...options, values: (value) => value.usedBytes })
/** Active child-fiber history from an injected metric context. */
export const fiberBlock = <TValue extends { readonly activeChildFibers: number }>(
  options: BlockOptions<TValue>,
): CanvasBlockSpec => numericBlock({ ...options, values: (value) => value.activeChildFibers })
/** Long-frame or long-task event duration history. */
export const jankBlock = <TValue extends { readonly durationMs: number }>(
  options: BlockOptions<TValue>,
): CanvasBlockSpec =>
  numericBlock({ ...options, mode: 'Event', values: (value) => value.durationMs })
/** Actual Profiler commit-duration event history. */
export const commitBlock = <TValue extends { readonly actualDurationMs: number }>(
  options: BlockOptions<TValue>,
): CanvasBlockSpec =>
  numericBlock({ ...options, mode: 'Event', values: (value) => value.actualDurationMs })
/** Completed-bucket aggregation used by a tile; its output unit is explicit. */
export type TileAggregation = Extract<BlockAggregation, { readonly _tag: 'Bucket' }>
/** One reader's reusable tile reduction; NaN marks an undefined bucket. */
interface TileScratch<TValue> {
  readonly values: Float64Array
  carried: Sample<TValue> | undefined
  /** Source-materialized Stale/Disconnected newest observation; draw and describe both use it. */
  freshness: Extract<Sample<TValue>, { readonly _tag: 'Unavailable' }> | undefined
  filling: boolean
  readonly range: {
    minimum: number
    maximum: number
    readonly nominalMax: number
    readonly minSpanRatio: number
    readonly mode: 'auto' | 'fixed'
    readonly target: { lo: number; hi: number }
  }
}
/**
 * A standalone tile: drawn label, newest completed-bucket value, and a sparkline
 * over the same buckets. Draw and describe reduce the same view with the shared
 * bucket scan at the same explicit time, so drawn and described values agree.
 * The drawn label is the tile's static accessible name: `widthPx` must fit it plus
 * 8px padding. A narrower rect draws an ellipsized prefix of the name and no value.
 * Value callbacks must not read the tile reader being drawn or described.
 */
export const tileBlock = <TValue>(
  options: PlotOptions & {
    readonly id: string
    readonly series: Series<TValue>
    readonly shortLabel?: string | undefined
    readonly widthPx: number
    readonly aggregation: TileAggregation
    readonly value: (value: TValue) => number
  },
): CanvasBlockSpec => {
  const nominalMax = options.nominalMax ?? 1
  const minSpanRatio = options.minSpanRatio ?? 0.1
  validateScale({ nominalMax, minSpanRatio })
  if (typeof options.range === 'object') validateRange(options.range)
  const policy = options.aggregation
  // Validate the bucket policy once, inertly, before any buffer is sized from it. Draws then
  // derive the same completed boundary inline instead of allocating evidence per frame.
  resolveBlockAggregation({ aggregation: policy, nowMs: 0 })
  const { bucketMs, buckets } = policy
  const spanMs = bucketMs * buckets
  const label = options.shortLabel ?? options.series.label
  const rangeMode = typeof options.range === 'string' ? options.range : 'fixed'
  // block() exposes no per-reader state, so scratch is keyed by the bound history: live
  // readers of this definition share the store's live view scratch (reads are synchronous),
  // and each frozen snapshot owns its own. Allocated on first read, reused every frame.
  const scratches = new WeakMap<SeriesView<TValue>, TileScratch<TValue>>()
  // Mirrors bucketSeries: a bucket is defined only when its newest observation is a Value.
  const fill = ({
    history,
    nowMs,
  }: {
    readonly history: SeriesView<TValue>
    readonly nowMs: number
  }): TileScratch<TValue> => {
    // Same completed boundary as resolveBlockAggregation, which describe evidence reports.
    const completedEndMs = Math.floor(nowMs / bucketMs) * bucketMs
    let scratch = scratches.get(history)
    if (scratch === undefined) {
      scratch = {
        values: new Float64Array(buckets),
        carried: undefined,
        freshness: undefined,
        filling: false,
        range: {
          minimum: Infinity,
          maximum: -Infinity,
          nominalMax,
          minSpanRatio,
          mode: rangeMode,
          target: { lo: 0, hi: 1 },
        },
      }
      scratches.set(history, scratch)
    }
    // A value callback reading this same reader would overwrite bins mid-scan.
    if (scratch.filling === true)
      throw new TypeError('Tile value callbacks must not re-enter the reader being read')
    const target = scratch
    target.filling = true
    target.carried = undefined
    // Freshness is source-owned: only materialized Stale/Disconnected dims the tile.
    const latest = history.latest
    target.freshness =
      latest?._tag === 'Unavailable' &&
      (latest.reason === 'Stale' || latest.reason === 'Disconnected')
        ? latest
        : undefined
    try {
      scanBins({
        history,
        endMs: completedEndMs,
        spanMs,
        bins: buckets,
        mode: policy.mode,
        value: options.value,
        saturate: true,
        // oxlint-disable-next-line overeng/named-args -- Streaming visitor avoids allocating one object per bin.
        visit: (bin, endMs, sample, aggregate) => {
          target.carried = sample !== undefined && sample.atMs <= endMs ? sample : undefined
          if (sample?._tag !== 'Value' || sample.atMs > endMs) {
            target.values[bin] = NaN
            return
          }
          const value = policy.mode === 'Gauge' ? options.value(sample.value) : aggregate
          target.values[bin] = Number.isFinite(value) === true ? value : NaN
        },
      })
    } finally {
      target.filling = false
    }
    return target
  }
  const unavailable = ({
    sample,
    format,
  }: {
    readonly sample: Extract<Sample<TValue>, { readonly _tag: 'Unavailable' }>
    readonly format: MeterValueFormat
  }): string => {
    const lastKnown = sample.lastKnown
    // Compact and number forms are a bare n/a; the reason stays in the full description.
    if (format !== 'full') return 'n/a'
    if (lastKnown === undefined) return `n/a (${sample.reason})`
    // A single sample is not a bucket aggregate: event and counter tiles name only its time.
    if (policy.mode !== 'Gauge')
      return `n/a (${sample.reason}; last observation at ${lastKnown.atMs}ms)`
    const value = options.value(lastKnown.value)
    if (Number.isFinite(value) === false)
      return `n/a (${sample.reason}; last observation at ${lastKnown.atMs}ms)`
    const known = formatMeterValue({ value, unit: policy.unit, format })
    return `n/a (${sample.reason}; last known ${known} at ${lastKnown.atMs}ms)`
  }
  const text = ({
    scratch,
    format,
  }: {
    readonly scratch: TileScratch<TValue>
    readonly format: MeterValueFormat
  }): string => {
    // A stale or offline source outranks the newest completed bucket, as the drawn status does.
    if (scratch.freshness !== undefined) return unavailable({ sample: scratch.freshness, format })
    const newest = scratch.values[policy.buckets - 1] ?? NaN
    if (Number.isNaN(newest) === false)
      return formatMeterValue({ value: newest, unit: policy.unit, format })
    if (format !== 'full') return 'n/a'
    const sample = scratch.carried
    if (sample === undefined) return 'n/a (NoSamples)'
    if (sample._tag === 'Unavailable') return unavailable({ sample, format })
    if (sample._tag === 'Gap') return `n/a (${sample.reason} gap)`
    return 'n/a (MeasurementFailed)'
  }
  return block({
    id: options.id,
    series: options.series,
    shortLabel: options.shortLabel,
    widthPx: options.widthPx,
    aggregation: policy,
    describe: ({ history, nowMs }) => text({ scratch: fill({ history, nowMs }), format: 'full' }),
    range: ({ history, nowMs }) => {
      const values = fill({ history, nowMs }).values
      let minimum = Infinity
      let maximum = -Infinity
      for (let bin = 0; bin < buckets; bin++) {
        const value = values[bin] ?? NaN
        if (Number.isNaN(value) === true) continue
        minimum = Math.min(minimum, value)
        maximum = Math.max(maximum, value)
      }
      return maximum === -Infinity
        ? undefined
        : { windowMs: spanMs, endMs: Math.floor(nowMs / bucketMs) * bucketMs, minimum, maximum }
    },
    draw: ({ ctx, rect, history, nowMs, theme }) => {
      const scratch = fill({ history, nowMs })
      const values = scratch.values
      const rangeState = scratch.range
      const resolvedRange = rangeState.target
      const status =
        scratch.freshness === undefined
          ? undefined
          : scratch.freshness.reason === 'Stale'
            ? 'stale'
            : 'offline'
      ctx.save()
      ctx.beginPath()
      ctx.rect(rect.x, rect.y, rect.width, rect.height)
      ctx.clip()
      ctx.fillStyle = theme.background
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
      const chart = {
        x: rect.x + 4,
        y: rect.y + 18,
        width: rect.width - 8,
        height: Math.max(1, rect.height - 20),
      }
      let minimum = Infinity
      let maximum = -Infinity
      for (let bin = 0; bin < policy.buckets; bin++) {
        const value = values[bin] ?? NaN
        if (Number.isNaN(value) === true) continue
        minimum = Math.min(minimum, value)
        maximum = Math.max(maximum, value)
      }
      if (typeof options.range === 'object') {
        minimum = options.range.lo
        maximum = options.range.hi
      } else {
        rangeState.minimum = minimum
        rangeState.maximum = maximum
        resolveRange(rangeState)
        minimum = resolvedRange.lo
        maximum = resolvedRange.hi
      }
      // Normalize first so opposite finite extrema cannot overflow the denominator.
      const scale = Math.max(Math.abs(minimum), Math.abs(maximum))
      const span = maximum / scale - minimum / scale
      const top = maximum / scale
      ctx.save()
      ctx.beginPath()
      ctx.rect(chart.x, chart.y, chart.width, chart.height)
      ctx.clip()
      ctx.fillStyle = theme.border
      ctx.fillRect(chart.x, chart.y + chart.height - 1, chart.width, 1)
      for (const mark of options.marks ?? noValues) {
        if (Number.isFinite(mark) === false || mark < minimum || mark > maximum) continue
        const markY = chart.y + chart.height * ((top - mark / scale) / span)
        ctx.fillRect(chart.x, Math.min(chart.y + chart.height - 1, markY), chart.width, 1)
      }
      const step = chart.width / policy.buckets
      ctx.strokeStyle = status === undefined ? theme.normal : theme.muted
      ctx.fillStyle = status === undefined ? theme.normal : theme.muted
      ctx.lineWidth = 1.5
      ctx.beginPath()
      let open = false
      for (let bin = 0; bin < policy.buckets; bin++) {
        const value = values[bin] ?? NaN
        if (Number.isNaN(value) === true) {
          open = false
          continue
        }
        const x = chart.x + (bin + 0.5) * step
        const y = chart.y + chart.height * ((top - value / scale) / span)
        if (open === true) ctx.lineTo(x, y)
        else ctx.moveTo(x, y)
        open = true
        // Undefined buckets break the line; an isolated observation remains visible.
        const before = bin === 0 ? NaN : (values[bin - 1] ?? NaN)
        const after = bin === policy.buckets - 1 ? NaN : (values[bin + 1] ?? NaN)
        if (Number.isNaN(before) === true && Number.isNaN(after) === true)
          ctx.fillRect(x - 1, y - 1, 2, 2)
      }
      ctx.stroke()
      ctx.restore()
      // The label is the tile's static accessible name, so it outranks the value. A rect
      // narrower than the label shows an ellipsized prefix of that name and no value. A
      // stale or offline tile keeps its label and names that state in the value slot.
      ctx.font = theme.font
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      const measure = (candidate: string): number => ctx.measureText(candidate).width
      const left = rect.x + 4
      const right = rect.x + rect.width - 4
      const drawnLabel = fitText({ text: label, maxWidth: right - left, measure })
      if (drawnLabel !== undefined) {
        ctx.fillStyle = theme.muted
        ctx.fillText(drawnLabel.text, left, rect.y + 3)
      }
      if (drawnLabel === undefined || drawnLabel.text !== label) {
        ctx.restore()
        return
      }
      const space = right - (left + drawnLabel.width + 6)
      let fitted: TextRun | undefined
      if (status !== undefined) {
        fitted = fitText({ text: status, maxWidth: space, measure })
      } else {
        for (const format of valueFormats) {
          const candidate = text({ scratch, format })
          const width = measure(candidate)
          if (width <= space) {
            fitted = { text: candidate, x: right - width, width }
            break
          }
        }
        fitted ??= fitText({ text: text({ scratch, format: 'number' }), maxWidth: space, measure })
      }
      if (fitted !== undefined) {
        ctx.fillStyle = status === undefined ? theme.foreground : theme.muted
        ctx.fillText(fitted.text, right - fitted.width, rect.y + 3)
      }
      ctx.restore()
    },
  })
}
const valueFormats: readonly MeterValueFormat[] = ['full', 'compact', 'number']
