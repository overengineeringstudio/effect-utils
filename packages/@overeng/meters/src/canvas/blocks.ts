import {
  validateId,
  type Series,
  type SeriesStore,
  type SeriesView,
  type Unit,
} from '../series/index.ts'
import type { FpsValue } from '../session/frame.ts'
import { fitText, historyX, layoutBlockText, type Rect } from './layout.ts'

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
/** Bound drawing and describing closures; no write or acquisition capability. */
export interface BlockReader {
  readonly revision: () => number
  readonly describe: () => string
  readonly draw: (input: Omit<DrawInput<never>, 'history'>) => void
  readonly snapshot: () => BlockReader
}
/** Heterogeneous blocks preserve payload typing inside their reader closures. */
export interface CanvasBlockSpec {
  readonly id: string
  readonly label: string
  /** Compact canvas label used only when the full label does not fit; DOM text keeps `label`. */
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
  readonly draw: (input: DrawInput<TValue>) => void
  readonly describe: (history: SeriesView<TValue>) => string
}): CanvasBlockSpec => {
  validateId(options.id)
  if (Number.isFinite(options.widthPx) === false || options.widthPx <= 0)
    throw new TypeError('Block width must be positive')
  const bind = (history: SeriesView<TValue>): BlockReader => ({
    revision: () => history.revision,
    describe: () => options.describe(history),
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
/** Format the same scalar text used by canvas and accessible outputs. */
export const formatMeterValue = (options: {
  readonly value: number
  readonly unit: Unit
}): string => {
  if (options.unit === 'bytes') {
    if (options.value >= 1024 ** 3) return `${(options.value / 1024 ** 3).toFixed(1)} GiB`
    if (options.value >= 1024 ** 2) return `${(options.value / 1024 ** 2).toFixed(1)} MiB`
    if (options.value >= 1024) return `${(options.value / 1024).toFixed(1)} KiB`
    return `${options.value.toFixed(0)} B`
  }
  const number =
    Number.isInteger(options.value) === true ? String(options.value) : options.value.toFixed(1)
  return options.unit === 'count' ? number : `${number} ${options.unit}`
}
const noValues: readonly number[] = []
/** Options shared by every built-in block builder. */
export interface BlockOptions<TValue> {
  readonly id: string
  readonly series: Series<TValue>
  /** Compact canvas label; the full series label remains the accessible and tooltip text. */
  readonly shortLabel?: string | undefined
  /** Nominal CSS width, 150 by default. */
  readonly widthPx?: number
}
/** Build a time-based scalar or stacked presentation with explicit gaps and availability. */
export const numericBlock = <TValue>(
  options: BlockOptions<TValue> & {
    readonly values: (value: TValue) => number | readonly number[]
    readonly describeValue?: (value: TValue) => string
    readonly mode?: 'Gauge' | 'Event' | 'Counter'
    readonly staleAfterMs?: number
  },
): CanvasBlockSpec => {
  const total = (value: TValue): number => {
    const values = options.values(value)
    if (typeof values === 'number') return values
    let sum = 0
    for (const part of values) sum += part
    return sum
  }
  const describe = (history: SeriesView<TValue>): string => {
    const latest = history.latest
    if (latest === undefined) return 'n/a (NoSamples)'
    if (latest._tag === 'Unavailable') return `n/a (${latest.reason})`
    if (latest._tag === 'Gap') return `n/a (${latest.reason} gap)`
    return (
      options.describeValue?.(latest.value) ??
      formatMeterValue({ value: total(latest.value), unit: options.series.unit })
    )
  }
  return block({
    id: options.id,
    series: options.series,
    shortLabel: options.shortLabel,
    widthPx: options.widthPx ?? 150,
    describe,
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
      const bins = Math.max(1, Math.floor(chart.width))
      const binDurationMs = historyMs / bins
      const startMs = nowMs - historyMs
      let maximum = 1
      let minimum = 0
      let aggregate = 0
      let aggregateBin = -1
      let priorValue: number | undefined
      for (let cursor = 0; cursor < history.length; cursor++) {
        const sample = history.at(cursor)
        if (sample?._tag !== 'Value') {
          priorValue = undefined
          continue
        }
        const value = total(sample.value)
        const increment =
          options.mode === 'Counter'
            ? priorValue === undefined
              ? 0
              : Math.max(0, value - priorValue)
            : value
        priorValue = value
        if (sample.atMs < startMs) {
          if (options.mode === undefined || options.mode === 'Gauge') {
            maximum = Math.max(1, value)
            minimum = Math.min(0, value)
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
        maximum = Math.max(
          maximum,
          options.mode === 'Event' || options.mode === 'Counter' ? aggregate : value,
        )
        if (options.mode === undefined || options.mode === 'Gauge')
          minimum = Math.min(minimum, value)
      }
      let previous = history.at(0)
      let previousValue: number | undefined
      let index = 0
      for (let bin = 0; bin < bins; bin++) {
        const atMs = nowMs - historyMs + ((bin + 1) * historyMs) / bins
        let eventTotal = 0
        while (index < history.length) {
          const sample = history.at(index)
          if (sample === undefined || sample.atMs > atMs) break
          previous = sample
          if (sample._tag === 'Value') {
            const value = total(sample.value)
            const increment =
              options.mode === 'Counter'
                ? previousValue === undefined
                  ? 0
                  : Math.max(0, value - previousValue)
                : value
            if (sample.atMs > atMs - binDurationMs) eventTotal += increment
            previousValue = value
          } else previousValue = undefined
          index++
        }
        if (previous === undefined || previous.atMs > atMs) continue
        const x = historyX({ atMs: atMs - historyMs / bins, nowMs, historyMs, rect: chart })
        if (previous._tag !== 'Value') {
          ctx.fillStyle = theme.gap
          ctx.fillRect(x, chart.y, chart.width / bins, chart.height)
          continue
        }
        const stale =
          options.staleAfterMs !== undefined && atMs - previous.atMs > options.staleAfterMs
        const parts =
          options.mode === 'Event' || options.mode === 'Counter'
            ? eventTotal
            : options.values(previous.value)
        let bottom = chart.y + (chart.height * maximum) / (maximum - minimum)
        const partCount = typeof parts === 'number' ? 1 : parts.length
        for (let part = 0; part < partCount; part++) {
          const value = typeof parts === 'number' ? parts : (parts[part] ?? 0)
          const height = (value / (maximum - minimum)) * chart.height
          ctx.fillStyle =
            stale === true
              ? theme.muted
              : part % 3 === 0
                ? theme.normal
                : part % 3 === 1
                  ? theme.warning
                  : theme.danger
          bottom -= height
          ctx.fillRect(x, bottom, chart.width / bins, height)
        }
      }
      for (let cursor = 0; cursor < history.length; cursor++) {
        const sample = history.at(cursor)
        if (sample?._tag !== 'Gap') continue
        const x = historyX({ atMs: sample.atMs - sample.durationMs, nowMs, historyMs, rect: chart })
        const end = historyX({ atMs: sample.atMs, nowMs, historyMs, rect: chart })
        ctx.fillStyle = theme.gap
        ctx.fillRect(x, chart.y, Math.max(1, end - x), chart.height)
      }
      ctx.font = theme.font
      ctx.textBaseline = 'top'
      ctx.fillStyle = theme.muted
      const measure = (text: string): number => ctx.measureText(text).width
      const header = layoutBlockText({
        rect,
        label: options.series.label,
        shortLabel: options.shortLabel,
        value: describe(history),
        measure,
      })
      ctx.textAlign = 'left'
      if (header.label !== undefined) ctx.fillText(header.label.text, header.label.x, rect.y + 3)
      ctx.fillStyle = theme.foreground
      if (header.value !== undefined) ctx.fillText(header.value.text, header.value.x, rect.y + 3)
      const latest = history.latest
      if (
        options.staleAfterMs !== undefined &&
        latest?._tag === 'Value' &&
        nowMs - latest.atMs > options.staleAfterMs
      ) {
        ctx.fillStyle = theme.muted
        const stale = fitText({
          text: `stale ${Math.round(nowMs - latest.atMs)}ms`,
          maxWidth: chart.width,
          measure,
        })
        if (stale !== undefined)
          ctx.fillText(stale.text, chart.x + chart.width - stale.width, chart.y)
      }
      ctx.restore()
    },
  })
}
/** Ordinary numeric gauge history. */
export const numberBlock = <TValue extends { readonly value: number }>(
  options: BlockOptions<TValue> & {
    readonly mode?: 'Gauge' | 'Event' | 'Counter'
    readonly staleAfterMs?: number
  },
): CanvasBlockSpec => numericBlock({ ...options, values: (value) => value.value })
/** Cumulative counter increments aggregated per timestamp bin, not summed totals. */
export const counterBlock = <TValue extends { readonly value: number }>(
  options: BlockOptions<TValue>,
): CanvasBlockSpec => numberBlock({ ...options, mode: 'Counter' })
/** Stacked numeric history with a host-selected typed projection. */
export const stackedBlock = numericBlock
/** Observed frame timing expressed as FPS, without invented calibration. */
export const frameBlock = (options: BlockOptions<FpsValue>): CanvasBlockSpec =>
  numericBlock({
    ...options,
    values: (value) => (value.durationMs > 0 ? 1000 / value.durationMs : noValues),
    describeValue: (value) =>
      value.durationMs > 0
        ? formatMeterValue({ value: 1000 / value.durationMs, unit: 'fps' })
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
/** Span completion-duration event history. */
export const spanBlock = jankBlock
/** Actual Profiler commit-duration event history. */
export const commitBlock = <TValue extends { readonly actualDurationMs: number }>(
  options: BlockOptions<TValue>,
): CanvasBlockSpec =>
  numericBlock({ ...options, mode: 'Event', values: (value) => value.actualDurationMs })
