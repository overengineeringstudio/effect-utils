import { describe, expect, it } from '@effect/vitest'

import { makeBrowserPlatform, type BrowserEnvironment } from './browser.ts'

describe('browser platform', () => {
  it('is inert and uses performance/rAF coordinates with removable visibility listeners', () => {
    let reads = 0
    let visibility = 'visible'
    let frame: ((atMs: number) => void) | undefined
    let listener: (() => void) | undefined
    let cancelled = 0
    const host: BrowserEnvironment = {
      performance: { now: () => 42, timeOrigin: 1000 },
      requestAnimationFrame: (callback) => {
        frame = callback
        return 7
      },
      cancelAnimationFrame: (id) => {
        cancelled = id
      },
      document: {
        get visibilityState() {
          return visibility
        },
        addEventListener: (_type, callback) => {
          listener = callback
        },
        removeEventListener: (_type, callback) => {
          if (listener === callback) listener = undefined
        },
      },
    }
    const platform = makeBrowserPlatform({
      browser: () => {
        reads++
        return host
      },
    })
    expect(reads).toBe(0)
    expect(platform.supportsFrames?.()).toBe(true)
    expect(platform.now()).toBe(42)
    expect(platform.timeOriginMs).toBe(1000)
    let atMs = 0
    expect(
      platform.requestFrame((at) => {
        atMs = at
      }),
    ).toBe(7)
    frame?.(84)
    expect(atMs).toBe(84)
    platform.cancelFrame(7)
    expect(cancelled).toBe(7)
    const visible: boolean[] = []
    const remove = platform.observeVisibility((value) => visible.push(value))
    visibility = 'hidden'
    listener?.()
    expect(platform.isVisible()).toBe(false)
    expect(visible).toEqual([false])
    remove()
    expect(listener).toBeUndefined()
  })

  it('detects missing frame capabilities without starting work', () => {
    const platform = makeBrowserPlatform({ browser: () => ({}) })
    expect(platform.supportsFrames?.()).toBe(false)
    expect(platform.isVisible()).toBe(false)
    expect(() => platform.requestFrame(() => {})).toThrow('unavailable')
  })
})
