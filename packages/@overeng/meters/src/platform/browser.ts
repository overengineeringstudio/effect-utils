import type { Platform } from '../session/clock.ts'

/** Minimal browser entry shape; no DOM library is required by meters. */
export interface BrowserEntry {
  readonly entryType: string
  readonly startTime: number
  readonly duration: number
  readonly blockingDuration?: number
  readonly renderStart?: number
}
/** Removable performance observer capability. */
export interface BrowserObserver {
  readonly observe: (options: { readonly type: string; readonly buffered: boolean }) => void
  readonly disconnect: () => void
}
/** Browser capabilities injectable without replacing meters implementations. */
export interface BrowserEnvironment {
  readonly performance?: {
    readonly now: () => number
    readonly timeOrigin: number
    readonly memory?: {
      readonly usedJSHeapSize: number
      readonly totalJSHeapSize: number
      readonly jsHeapSizeLimit: number
    }
    readonly measureUserAgentSpecificMemory?: () => Promise<{ readonly bytes: number }>
  }
  readonly PerformanceObserver?: {
    readonly supportedEntryTypes: readonly string[]
    new (
      callback: (list: { readonly getEntries: () => readonly BrowserEntry[] }) => void,
    ): BrowserObserver
  }
  readonly requestAnimationFrame?: (callback: (atMs: number) => void) => number
  readonly cancelAnimationFrame?: (id: number) => void
  readonly document?: {
    readonly visibilityState: string
    // oxlint-disable-next-line overeng/named-args -- Browser event callback API.
    readonly addEventListener: (type: string, listener: () => void) => void
    // oxlint-disable-next-line overeng/named-args -- Browser event callback API.
    readonly removeEventListener: (type: string, listener: () => void) => void
  }
  readonly crossOriginIsolated?: boolean
  readonly isSecureContext?: boolean
}
/** Resolve globals only when an acquired browser adapter needs them. */
export const browserEnvironment = (): BrowserEnvironment => {
  const browser: BrowserEnvironment = globalThis as BrowserEnvironment
  return browser
}
/** Inert browser platform using the browser's monotonic performance coordinate. */
export const makeBrowserPlatform = (
  options: {
    readonly browser?: () => BrowserEnvironment
  } = {},
): Platform => {
  const browser = options.browser ?? browserEnvironment
  return {
    supportsFrames: () => {
      const host = browser()
      return host.requestAnimationFrame !== undefined && host.cancelAnimationFrame !== undefined
    },
    now: () => {
      const performance = browser().performance
      if (performance === undefined) throw new Error('Browser performance clock is unavailable')
      return performance.now()
    },
    get timeOriginMs() {
      const performance = browser().performance
      if (performance === undefined) throw new Error('Browser performance clock is unavailable')
      return performance.timeOrigin
    },
    requestFrame: (callback) => {
      const host = browser()
      if (host.requestAnimationFrame === undefined || host.cancelAnimationFrame === undefined)
        throw new Error('Browser animation frames are unavailable')
      return host.requestAnimationFrame(callback)
    },
    cancelFrame: (id) => browser().cancelAnimationFrame?.(id),
    isVisible: () => browser().document?.visibilityState === 'visible',
    observeVisibility: (listener) => {
      const document = browser().document
      if (document === undefined) return () => {}
      const notify = (): void => listener(document.visibilityState === 'visible')
      document.addEventListener('visibilitychange', notify)
      return () => document.removeEventListener('visibilitychange', notify)
    },
  }
}
