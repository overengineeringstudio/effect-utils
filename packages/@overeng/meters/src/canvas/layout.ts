/** A drawing region in CSS pixels. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}
/** CSS layout and fractional-DPR backing dimensions. */
export interface StripLayout {
  readonly widthPx: number
  readonly heightPx: number
  readonly backingWidth: number
  readonly backingHeight: number
  readonly dpr: number
  readonly rects: readonly Rect[]
}
/**
 * Lay out blocks without a trailing gap. Blocks use their nominal widths when the
 * measured space allows it and shrink proportionally only when it is too small.
 */
export const layoutStrip = (options: {
  readonly widths: readonly number[]
  readonly heightPx: number
  readonly gapPx: number
  readonly dpr: number
  readonly availableWidthPx?: number | undefined
}): StripLayout => {
  if (
    Number.isFinite(options.heightPx) === false ||
    options.heightPx <= 0 ||
    Number.isFinite(options.gapPx) === false ||
    options.gapPx < 0 ||
    Number.isFinite(options.dpr) === false ||
    options.dpr <= 0 ||
    options.widths.some((width) => Number.isFinite(width) === false || width <= 0) === true
  )
    throw new TypeError('Strip dimensions and DPR must be finite and positive; gaps may be zero')
  const gaps = Math.max(0, options.widths.length - 1) * options.gapPx
  let nominal = 0
  for (const width of options.widths) nominal += width
  const available = options.availableWidthPx
  // Usable block space; equal to `nominal` whenever the slot is wide enough (never grows past it).
  const usable =
    available !== undefined && Number.isFinite(available) === true && available > gaps
      ? Math.min(nominal, available - gaps)
      : nominal
  let widthPx = 0
  // oxlint-disable-next-line overeng/named-args -- Native Array.map callback signature.
  const rects = options.widths.map((nominalWidth, index) => {
    const width = usable === nominal ? nominalWidth : (nominalWidth * usable) / nominal
    const rect = { x: widthPx, y: 0, width, height: options.heightPx }
    widthPx += width + (index < options.widths.length - 1 ? options.gapPx : 0)
    return rect
  })
  return {
    widthPx,
    heightPx: options.heightPx,
    dpr: options.dpr,
    rects,
    backingWidth: Math.round(widthPx * options.dpr),
    backingHeight: Math.round(options.heightPx * options.dpr),
  }
}
/** Map a monotonic timestamp to a CSS coordinate within a fixed time horizon. */
export const historyX = (options: {
  readonly atMs: number
  readonly nowMs: number
  readonly historyMs: number
  readonly rect: Rect
}): number =>
  options.rect.x +
  ((options.atMs - (options.nowMs - options.historyMs)) / options.historyMs) * options.rect.width
/** One positioned, already-fitted text run in CSS pixels. */
export interface TextRun {
  readonly text: string
  readonly x: number
  readonly width: number
}
/** Header text for one block; value space is reserved before the label. */
export interface BlockTextLayout {
  readonly value: TextRun | undefined
  readonly label: TextRun | undefined
}
const ellipsis = '…'
/** Fit text to a width by measuring, never by squeezing glyphs. */
export const fitText = (options: {
  readonly text: string
  readonly maxWidth: number
  readonly measure: (text: string) => number
}): TextRun | undefined => {
  if (options.maxWidth <= 0 || options.text.length === 0) return undefined
  const full = options.measure(options.text)
  if (full <= options.maxWidth) return { text: options.text, x: 0, width: full }
  let low = 0
  let high = options.text.length - 1
  let best: TextRun | undefined
  while (low <= high) {
    const length = Math.floor((low + high) / 2)
    const text = `${options.text.slice(0, length).trimEnd()}${ellipsis}`
    const width = options.measure(text)
    if (width <= options.maxWidth) {
      if (length > 0) best = { text, x: 0, width }
      low = length + 1
    } else high = length - 1
  }
  return best
}
/**
 * Try full label + full value, short label + full value, then value alone.
 * Only after the full value fails do compact and number-only values compete;
 * ellipsizing is the last resort. Labels are never truncated or reintroduced.
 */
export const layoutBlockText = (options: {
  readonly rect: Rect
  readonly label: string
  readonly shortLabel?: string | undefined
  readonly value: string
  readonly compactValue?: string | undefined
  readonly numberValue?: string | undefined
  readonly measure: (text: string) => number
  readonly paddingPx?: number
  readonly gapPx?: number
}): BlockTextLayout => {
  const padding = options.paddingPx ?? 4
  const gap = options.gapPx ?? 6
  const inner = options.rect.width - padding * 2
  const right = options.rect.x + options.rect.width - padding
  const fullValueWidth = options.measure(options.value)
  if (fullValueWidth <= inner) {
    const value =
      options.value.length === 0
        ? undefined
        : { text: options.value, x: right - fullValueWidth, width: fullValueWidth }
    const labelSpace = inner - (value === undefined ? 0 : fullValueWidth + gap)
    const x = options.rect.x + padding
    const fullLabelWidth = options.measure(options.label)
    if (options.label.length > 0 && fullLabelWidth <= labelSpace)
      return { value, label: { text: options.label, x, width: fullLabelWidth } }
    if (options.shortLabel !== undefined && options.shortLabel.length > 0) {
      const shortWidth = options.measure(options.shortLabel)
      if (shortWidth <= labelSpace)
        return { value, label: { text: options.shortLabel, x, width: shortWidth } }
    }
    return { value, label: undefined }
  }
  if (options.compactValue !== undefined && options.compactValue.length > 0) {
    const width = options.measure(options.compactValue)
    if (width <= inner)
      return { value: { text: options.compactValue, x: right - width, width }, label: undefined }
  }
  if (options.numberValue !== undefined && options.numberValue.length > 0) {
    const width = options.measure(options.numberValue)
    if (width <= inner)
      return { value: { text: options.numberValue, x: right - width, width }, label: undefined }
  }
  const fittedValue = fitText({
    text: options.numberValue ?? options.compactValue ?? options.value,
    maxWidth: inner,
    measure: options.measure,
  })
  if (fittedValue !== undefined)
    return { value: { ...fittedValue, x: right - fittedValue.width }, label: undefined }
  const ellipsisWidth = options.measure(ellipsis)
  return {
    value:
      options.value.length > 0 && ellipsisWidth <= inner
        ? { text: ellipsis, x: right - ellipsisWidth, width: ellipsisWidth }
        : undefined,
    label: undefined,
  }
}
