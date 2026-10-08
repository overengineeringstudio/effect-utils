import { vi } from 'vitest'

import type { CanvasPlatform } from './index.ts'

/** Minimal injected browser drawing boundary with recorded CSS-coordinate output. */
export const testCanvas = () => {
  const canvas = document.createElement('canvas')
  const texts: string[] = []
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
    fillText: (text: string, _x: number, _y: number, _maxWidth?: number) => {
      texts.push(text)
    },
    fillStyle: '',
    font: '',
    textBaseline: 'top',
    textAlign: 'left',
  }
  // Only the external browser canvas boundary is replaced; meter/session code remains real.
  const nativeContext = context as unknown as CanvasRenderingContext2D
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(nativeContext)
  let dpr = 1.25
  let observed = 0
  const listeners = new Set<() => void>()
  const platform: CanvasPlatform = {
    dpr: () => dpr,
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
    rectangles,
    transforms: recordedTransforms,
    resize: (value: number) => {
      dpr = value
      for (const listener of listeners) listener()
    },
    get observed() {
      return observed
    },
  }
}
