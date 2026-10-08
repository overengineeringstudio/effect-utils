import type { Platform } from '@overeng/meters'

/** Deterministic host capability; no timers or browser globals are acquired. */
export const testPlatform = () => {
  let atMs = 0
  let nextId = 0
  let requests = 0
  const pending = new Map<number, (atMs: number) => void>()
  const observers = new Set<(visible: boolean) => void>()
  const platform: Platform = {
    now: () => atMs,
    timeOriginMs: 1_000_000,
    isVisible: () => true,
    requestFrame: (callback) => {
      requests++
      const id = ++nextId
      pending.set(id, callback)
      return id
    },
    cancelFrame: (id) => {
      pending.delete(id)
    },
    observeVisibility: (listener) => {
      observers.add(listener)
      return () => {
        observers.delete(listener)
      }
    },
  }
  return {
    platform,
    advance: (elapsedMs: number) => {
      atMs += elapsedMs
    },
    get requests() {
      return requests
    },
    get observers() {
      return observers.size
    },
  }
}
