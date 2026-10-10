import { vi } from 'vitest'

import type { CanvasPlatform } from './index.ts'

/** Deterministic monospace metric: 6 CSS px per character. */
export const measureTestText = (text: string): number => text.length * 6
/** One recorded `fillText` call; `maxWidth` must stay undefined (no glyph squeezing). */
export interface DrawnText {
  readonly text: string
  readonly x: number
  readonly maxWidth: number | undefined
}
/** Minimal injected browser drawing boundary with recorded CSS-coordinate output. */
export const testCanvas = () => {
  const canvas = document.createElement('canvas')
  const texts: string[] = []
  const drawnTexts: DrawnText[] = []
  const recordedTransforms: number[][] = []
  const rectangles: number[][] = []
  const context = {
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    rect: () => {},
    clip: () => {},
    clearRect: () => {
      rectangles.length = 0
    },
    // oxlint-disable-next-line overeng/named-args -- Native CanvasRenderingContext2D callback signature.
    fillRect: (x: number, y: number, width: number, height: number) => {
      rectangles.push([x, y, width, height])
    },
    setTransform: (...values: number[]) => {
      recordedTransforms.push(values)
    },
    // oxlint-disable-next-line overeng/named-args -- Native CanvasRenderingContext2D callback signature.
    fillText: (text: string, x: number, _y: number, maxWidth?: number) => {
      texts.push(text)
      drawnTexts.push({ text, x, maxWidth })
    },
    measureText: (text: string) => ({ width: measureTestText(text) }),
    fillStyle: '',
    font: '',
    textBaseline: 'top',
    textAlign: 'left',
  }
  // Only the external browser canvas boundary is replaced; meter/session code remains real.
  const nativeContext = context as unknown as CanvasRenderingContext2D
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(nativeContext)
  let dpr = 1.25
  let availableWidth: number | undefined
  let observed = 0
  const listeners = new Set<() => void>()
  const platform: CanvasPlatform = {
    dpr: () => dpr,
    availableWidth: () => availableWidth,
    observeChanges: (listener) => {
      listeners.add(listener)
      observed++
      return () => {
        observed--
        listeners.delete(listener)
      }
    },
  }
  return {
    canvas,
    platform,
    texts,
    drawnTexts,
    rectangles,
    transforms: recordedTransforms,
    resize: (value: number) => {
      dpr = value
      for (const listener of listeners) listener()
    },
    setAvailableWidth: (value: number | undefined) => {
      availableWidth = value
      for (const listener of listeners) listener()
    },
    get observed() {
      return observed
    },
  }
}
