/**
 * Scriptable `BrowserPlatform` for tests: dispatch DOM events, feed PerformanceObserver entries,
 * present frames, toggle online/visibility, and capture beacons. Fetch is real (`globalThis.fetch`)
 * so exports reach a real OTLP receiver.
 */
import { Layer } from 'effect'

import { BrowserPlatform, type BrowserPlatformShape } from './BrowserPlatform.ts'

/** Beacon body captured by the scriptable platform. */
export interface Beacon {
  readonly url: string
  readonly data: Blob
}

/** Creates a browser platform with deterministic clocks and controllable browser events. */
export const makeTestPlatform = (options: {
  readonly origin: string
  readonly supportedEntryTypes?: ReadonlyArray<string>
  readonly beaconAccepts?: boolean
}) => {
  const listeners = new Map<string, Set<(event: Event) => void>>()
  const observers = new Map<string, Set<(entries: ReadonlyArray<PerformanceEntry>) => void>>()
  const supported = new Set(
    options.supportedEntryTypes ?? [
      'event',
      'largest-contentful-paint',
      'layout-shift',
      'long-animation-frame',
    ],
  )
  const storage = new Map<string, string>()
  const beacons: Beacon[] = []
  let paints: Array<() => void> = []
  let online = true
  let hidden = false
  let nowMs = 0
  let ids = 0

  const platform: BrowserPlatformShape = {
    origin: options.origin,
    timeOrigin: 1_790_000_000_000,
    now: () => nowMs,
    isOnline: () => online,
    isHidden: () => hidden,
    fetch: ({ input, init }) => globalThis.fetch(input, init),
    sendBeacon: ({ url, body }) => {
      if (options.beaconAccepts === false) return false
      beacons.push({ url, data: body })
      return true
    },
    listen: ({ target, type, handler }) => {
      const key = `${target}:${type}`
      const set = listeners.get(key) ?? new Set()
      set.add(handler)
      listeners.set(key, set)
      return () => set.delete(handler)
    },
    observe: ({ types, callback }) => {
      if (types.every((type) => supported.has(type) === true) === false) return undefined
      for (const type of types) {
        const set = observers.get(type) ?? new Set()
        set.add(callback)
        observers.set(type, set)
      }
      return () => {
        for (const type of types) observers.get(type)?.delete(callback)
      }
    },
    afterNextPaint: (f) => paints.push(f),
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: storage.set.bind(storage),
    },
    randomId: () => `id-${++ids}`,
    userAgent: 'test-agent/1.0',
    language: 'en-US',
  }

  const controls = {
    layer: Layer.succeed(BrowserPlatform, platform),
    beacons,
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    observerCount: () => [...observers.values()].reduce((sum, set) => sum + set.size, 0),
    setNow: (ms: number) => {
      nowMs = ms
    },
    setOnline: (value: boolean) => {
      online = value
    },
    setHidden: (value: boolean) => {
      hidden = value
      controls.dispatch({
        target: 'document',
        type: 'visibilitychange',
        event: new Event('visibilitychange'),
      })
    },
    dispatch: ({
      target,
      type,
      event,
    }: {
      readonly target: 'window' | 'document'
      readonly type: string
      readonly event: Event
    }) => {
      for (const listener of listeners.get(`${target}:${type}`) ?? []) listener(event)
    },
    /** A DOM-like input event with a fixed `timeStamp` (Bun's `Event` stamps wall time). */
    input: ({
      type,
      timeStamp,
      fields,
    }: {
      readonly type: string
      readonly timeStamp: number
      readonly fields?: Record<string, unknown>
    }) => {
      const event = Object.assign(new Event(type), fields)
      Object.defineProperty(event, 'timeStamp', { value: timeStamp })
      controls.dispatch({ target: 'window', type, event })
    },
    emitEntries: ({
      type,
      entries,
    }: {
      readonly type: string
      readonly entries: ReadonlyArray<Record<string, unknown>>
    }) => {
      const full = entries.map(
        (entry) => ({ entryType: type, name: type, ...entry }) as unknown as PerformanceEntry,
      )
      for (const onEntries of observers.get(type) ?? []) onEntries(full)
    },
    /** Presents a frame at `ms`: runs every pending after-paint callback. */
    paint: (ms: number) => {
      nowMs = ms
      const pending = paints
      paints = []
      for (const f of pending) f()
    },
  }
  return controls
}
