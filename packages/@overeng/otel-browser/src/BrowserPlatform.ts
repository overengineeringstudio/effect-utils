/**
 * The browser surface telemetry touches, as one Effect service. `layerWindow` binds it to the real
 * page; tests (and non-window hosts such as workers) provide their own implementation. Keeping
 * every DOM access behind this seam is what lets the exporter and observers run under Bun.
 */
import { Context, Effect, Layer } from 'effect'

/** Browser event hosts available to platform listeners. */
export type ListenTarget = 'window' | 'document'

/** Browser capabilities used by telemetry collection and export. */
export interface BrowserPlatformShape {
  /** `location.origin`; the OTLP path resolves against it. */
  readonly origin: string
  /** `performance.timeOrigin` (epoch ms). */
  readonly timeOrigin: number
  /** `performance.now()` (ms since `timeOrigin`). */
  readonly now: () => number
  readonly isOnline: () => boolean
  readonly isHidden: () => boolean
  readonly fetch: (options: {
    readonly input: RequestInfo | URL
    readonly init?: RequestInit
  }) => Promise<Response>
  /** `navigator.sendBeacon`, `undefined` where unavailable. */
  readonly sendBeacon:
    | ((options: { readonly url: string; readonly body: Blob }) => boolean)
    | undefined
  /** Adds an event listener and returns its remover. */
  readonly listen: (options: {
    readonly target: ListenTarget
    readonly type: string
    readonly handler: (event: Event) => void
    readonly options?: AddEventListenerOptions
  }) => () => void
  /**
   * Observes a `PerformanceObserver` entry type; returns the disconnector, or `undefined` when the
   * entry type is unsupported (e.g. `long-animation-frame` outside Chromium).
   */
  readonly observe: (options: {
    readonly types: ReadonlyArray<string>
    readonly callback: (entries: ReadonlyArray<PerformanceEntry>) => void
    readonly options?: PerformanceObserverInit & { readonly durationThreshold?: number }
  }) => (() => void) | undefined
  /** Runs `f` right after the next frame is presented (rAF + task). */
  readonly afterNextPaint: (f: () => void) => void
  /** `sessionStorage`, `undefined` where unavailable (privacy modes, workers). */
  readonly sessionStorage: Pick<Storage, 'getItem' | 'setItem'> | undefined
  readonly randomId: () => string
  readonly userAgent: string
  readonly language: string | undefined
}

/** Injectable browser platform service. */
export class BrowserPlatform extends Context.Service<BrowserPlatform, BrowserPlatformShape>()(
  '@overeng/otel-browser/BrowserPlatform',
) {}

const afterNextPaint = (f: () => void) =>
  requestAnimationFrame(() => {
    const channel = new MessageChannel()
    channel.port1.addEventListener(
      'message',
      () => {
        channel.port1.close()
        channel.port2.close()
        f()
      },
      { once: true },
    )
    channel.port1.start()
    channel.port2.postMessage(undefined)
  })

const safeSessionStorage = (): Pick<Storage, 'getItem' | 'setItem'> | undefined => {
  try {
    return globalThis.sessionStorage
  } catch {
    return undefined
  }
}

/** Binds the platform to the current window. */
export const layerWindow: Layer.Layer<BrowserPlatform> = Layer.sync(BrowserPlatform, () => ({
  origin: location.origin,
  timeOrigin: performance.timeOrigin,
  now: () => performance.now(),
  isOnline: () => navigator.onLine !== false,
  isHidden: () => document.visibilityState === 'hidden',
  fetch: ({ input, init }) => globalThis.fetch(input, init),
  sendBeacon:
    typeof navigator.sendBeacon === 'function'
      ? ({ url, body }) => navigator.sendBeacon(url, body)
      : undefined,
  listen: ({ target, type, handler, options }) => {
    const node = target === 'window' ? window : document
    node.addEventListener(type, handler, options)
    return () => node.removeEventListener(type, handler, options)
  },
  observe: ({ types, callback, options }) => {
    if (typeof PerformanceObserver === 'undefined') return undefined
    if (
      types.every(
        (candidate) => PerformanceObserver.supportedEntryTypes?.includes(candidate) === true,
      ) === false
    ) {
      return undefined
    }
    const observer = new PerformanceObserver((list) => callback(list.getEntries()))
    const entryType = types[0]
    if (types.length === 1 && entryType !== undefined)
      observer.observe({ ...options, type: entryType })
    else observer.observe({ ...options, entryTypes: [...types] })
    return () => observer.disconnect()
  },
  afterNextPaint,
  sessionStorage: safeSessionStorage(),
  randomId: () => crypto.randomUUID(),
  userAgent: navigator.userAgent,
  language: navigator.language,
}))

/** Scoped `listen`: the listener is removed when the scope closes. */
export const listenScoped = (options: Parameters<BrowserPlatformShape['listen']>[0]) =>
  Effect.gen(function* () {
    const platform = yield* BrowserPlatform
    return yield* Effect.acquireRelease(
      Effect.sync(() => platform.listen(options)),
      (remove) => Effect.sync(remove),
    )
  })

/** Scoped `observe`: `false` when the entry type is unsupported, else disconnected on scope close. */
export const observeScoped = (options: Parameters<BrowserPlatformShape['observe']>[0]) =>
  Effect.gen(function* () {
    const platform = yield* BrowserPlatform
    const disconnect = yield* Effect.acquireRelease(
      Effect.sync(() => platform.observe(options)),
      (release) => Effect.sync(() => release?.()),
    )
    return disconnect !== undefined
  })
