import { describe, expect, it } from 'vitest'

import { observeFps, type FpsClock } from './fps-meter.ts'

const makeClock = () => {
  const pending = new Map<number, FrameRequestCallback>()
  const cancelled: number[] = []
  const listeners = new Set<() => void>()
  let nextId = 0
  let visibilityState: DocumentVisibilityState = 'visible'
  const clock: FpsClock = {
    requestFrame: (callback) => {
      const id = ++nextId
      pending.set(id, callback)
      return id
    },
    cancelFrame: (id) => {
      cancelled.push(id)
      pending.delete(id)
    },
    visibility: {
      get visibilityState() {
        return visibilityState
      },
      addEventListener: (_type, listener) => {
        listeners.add(listener)
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener)
      },
    },
  }
  return {
    clock,
    pending,
    cancelled,
    listeners,
    setVisibility: (next: DocumentVisibilityState) => {
      visibilityState = next
      for (const listener of listeners) listener()
    },
    paint: (now: number) => {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks) callback(now)
    },
  }
}

describe('FPS meter lifecycle', () => {
  it('samples while expanded, pauses in a hidden page, resumes fresh, and releases frames on collapse', () => {
    const source = makeClock()
    const samples: number[] = []
    const stop = observeFps({
      clock: source.clock,
      onSample: (fps) => {
        samples.push(fps)
      },
    })

    expect(source.pending.size).toBe(1)
    source.paint(0)
    source.paint(250)
    source.paint(500)
    expect(samples).toEqual([6])
    expect(source.pending.size).toBe(1)

    source.setVisibility('hidden')
    expect(source.pending.size).toBe(0)
    expect(source.cancelled).toHaveLength(1)
    source.paint(5_000)
    expect(samples).toEqual([6])

    source.setVisibility('visible')
    source.paint(10_000)
    source.paint(10_500)
    expect(samples).toEqual([6, 4])

    stop()
    expect(source.pending.size).toBe(0)
    expect(source.listeners.size).toBe(0)
    source.setVisibility('visible')
    expect(source.pending.size).toBe(0)
  })

  it('never schedules a frame when mounted while hidden', () => {
    const source = makeClock()
    source.setVisibility('hidden')
    const stop = observeFps({ clock: source.clock, onSample: () => {} })
    expect(source.pending.size).toBe(0)
    stop()
    expect(source.listeners.size).toBe(0)
  })
})
