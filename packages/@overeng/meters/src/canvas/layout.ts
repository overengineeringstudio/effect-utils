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
/** Lay out variable-width blocks without a trailing gap. */
export const layoutStrip = (options: {
  readonly widths: readonly number[]
  readonly heightPx: number
  readonly gapPx: number
  readonly dpr: number
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
  let widthPx = 0
  // oxlint-disable-next-line overeng/named-args -- Native Array.map callback signature.
  const rects = options.widths.map((width, index) => {
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
