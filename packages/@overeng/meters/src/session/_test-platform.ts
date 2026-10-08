import type { Platform } from './clock.ts'

/** Pure deterministic host capability with observable resource counts. */
export const testPlatform = () => {
  let now = 0
  let visible = true
  let nextId = 0
  let requests = 0
  let peakPending = 0
  const callbacks = new Map<number, (atMs: number) => void>()
  const listeners = new Set<(visible: boolean) => void>()
  const platform: Platform = {
    now: () => now,
    timeOriginMs: 1000000,
    requestFrame: (callback) => {
      const id = ++nextId
      requests++
      callbacks.set(id, callback)
      peakPending = Math.max(peakPending, callbacks.size)
      return id
    },
    cancelFrame: (id) => {
      callbacks.delete(id)
    },
    isVisible: () => visible,
    observeVisibility: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return {
    platform,
    tick: (durationMs = 1000 / 60) => {
      now += durationMs
      const pending = Array.from(callbacks.values())
      callbacks.clear()
      for (const callback of pending) callback(now)
    },
    advance: (durationMs: number) => {
      now += durationMs
    },
    setVisible: (value: boolean) => {
      visible = value
      for (const listener of listeners) listener(value)
    },
    get pending() {
      return callbacks.size
    },
    get observers() {
      return listeners.size
    },
    get requests() {
      return requests
    },
    get peakPending() {
      return peakPending
    },
  }
}
