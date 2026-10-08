import { Effect, type Scope } from 'effect'

import type { SeriesStore } from '../series/index.ts'
import type { FrameClock } from '../session/clock.ts'
import type { Meters } from '../session/index.ts'
import type { BlockReader, CanvasBlockSpec, MeterTheme } from './blocks.ts'
import { layoutStrip, type StripLayout } from './layout.ts'

export {
  block,
  commitBlock,
  counterBlock,
  darkMeterTheme,
  fiberBlock,
  formatMeterValue,
  frameBlock,
  heapBlock,
  jankBlock,
  lightMeterTheme,
  numberBlock,
  numericBlock,
  spanBlock,
  stackedBlock,
} from './blocks.ts'
export type { BlockReader, CanvasBlockSpec, DrawInput, MeterTheme } from './blocks.ts'
export { historyX, layoutStrip } from './layout.ts'
export type { Rect, StripLayout } from './layout.ts'

/** Renderer-only session access; never exposes a start capability to drawing. */
export type MeterSession = Pick<Meters, 'store' | 'clock'>
/** One presentation's independent live or frozen readers. */
export interface StripView {
  readonly readers: readonly BlockReader[]
  readonly frozenAtMs: number | undefined
  readonly getSnapshot: () => readonly string[]
  readonly subscribe: (notify: () => void) => () => void
}
/** Bind a renderer view, copying bounded histories only for an explicitly frozen view. */
export const makeStripView = (options: {
  readonly store: SeriesStore
  readonly blocks: readonly CanvasBlockSpec[]
  readonly frozenAtMs?: number
}): StripView => {
  const ids = new Set<string>()
  const readers = options.blocks.map((item) => {
    if (ids.has(item.id) === true) throw new TypeError(`Duplicate meter block: ${item.id}`)
    ids.add(item.id)
    const reader = item.read(options.store)
    return options.frozenAtMs === undefined ? reader : reader.snapshot()
  })
  let revision = ''
  let cached: readonly string[] = []
  const getSnapshot = (): readonly string[] => {
    const nextRevision = readers.map((reader) => reader.revision()).join(',')
    if (nextRevision !== revision || cached.length !== readers.length) {
      revision = nextRevision
      cached = readers.map((reader) => reader.describe())
    }
    return cached
  }
  return {
    readers,
    frozenAtMs: options.frozenAtMs,
    getSnapshot,
    subscribe: (notify) =>
      options.frozenAtMs === undefined ? options.store.subscribe({ notify }) : () => {},
  }
}
/** Injected attachment capabilities for deterministic sizing and disposal tests. */
export interface CanvasPlatform {
  readonly dpr: () => number
  readonly observeChanges: (notify: () => void) => () => void
}
/** Scoped attachment; it subscribes only to the session's Draw phase. */
export interface Renderer {
  readonly attach: Effect.Effect<void, never, Scope.Scope>
}

/** Resolve semantic CSS-variable tokens once on attachment or theme changes, never per frame. */
export const resolveMeterTheme = (options: {
  readonly theme: MeterTheme
  readonly canvas: HTMLCanvasElement
}): MeterTheme => {
  let computed: CSSStyleDeclaration | undefined
  const resolve = (value: string): string => {
    if (value.includes('var(') === false) return value
    const window = options.canvas.ownerDocument.defaultView
    if (window === null) throw new TypeError('Canvas must belong to a window')
    computed ??= window.getComputedStyle(options.canvas)
    // oxlint-disable-next-line overeng/named-args -- String.replace capture callback signature.
    return value.replace(
      /var\(([^,)]+)(?:,\s*([^)]*))?\)/g,
      (_match: string, name: string, fallback: string | undefined) => {
        const token = computed?.getPropertyValue(name.trim()).trim()
        if (token !== undefined && token.length > 0) return token
        if (fallback !== undefined) return fallback.trim()
        throw new TypeError(`Unresolved meter theme token: ${name}`)
      },
    )
  }
  const theme = options.theme
  return {
    background: resolve(theme.background),
    foreground: resolve(theme.foreground),
    muted: resolve(theme.muted),
    border: resolve(theme.border),
    normal: resolve(theme.normal),
    warning: resolve(theme.warning),
    danger: resolve(theme.danger),
    gap: resolve(theme.gap),
    focus: resolve(theme.focus),
    font: resolve(theme.font),
  }
}
const browserCanvasPlatform = (canvas: HTMLCanvasElement): CanvasPlatform => {
  const window = canvas.ownerDocument.defaultView
  if (window === null) throw new TypeError('Canvas must belong to a window')
  return {
    dpr: () => window.devicePixelRatio,
    observeChanges: (notify) => {
      const observer = new ResizeObserver(notify)
      observer.observe(canvas)
      let media: MediaQueryList | undefined
      const changed = (): void => {
        media?.removeEventListener('change', changed)
        media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
        media.addEventListener('change', changed)
        notify()
      }
      changed()
      window.addEventListener('resize', changed)
      // Host token adapters resolve theme values on attachment/changes, never per frame.
      const themeObserver = new MutationObserver(notify)
      let ancestor = canvas.parentElement
      while (ancestor !== null) {
        themeObserver.observe(ancestor, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme'],
        })
        ancestor = ancestor.parentElement
      }
      return () => {
        observer.disconnect()
        themeObserver.disconnect()
        media?.removeEventListener('change', changed)
        window.removeEventListener('resize', changed)
      }
    },
  }
}
/** Configure a single canvas strip without starting sources, clocks, or observers. */
export const makeCanvasStrip = (options: {
  readonly canvas: HTMLCanvasElement
  readonly meters: { readonly store: SeriesStore; readonly clock: FrameClock }
  readonly blocks: readonly CanvasBlockSpec[]
  readonly heightPx?: number
  readonly gapPx?: number
  readonly historyMs?: number
  readonly readTheme: () => MeterTheme
  readonly view?: StripView
  readonly platform?: CanvasPlatform
}): Renderer => ({
  attach: Effect.gen(function* () {
    if (options.blocks.length === 0) return
    const canvas = options.canvas
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const historyMs = options.historyMs ?? 10000
    if (Number.isFinite(historyMs) === false || historyMs <= 0)
      throw new TypeError('History horizon must be positive')
    const view =
      options.view ?? makeStripView({ store: options.meters.store, blocks: options.blocks })
    const platform = options.platform ?? browserCanvasPlatform(canvas)
    let theme: MeterTheme
    let layout: StripLayout
    const widths = options.blocks.map((item) => item.widthPx)
    const draw = (nowMs: number): void => {
      ctx.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0)
      ctx.clearRect(0, 0, layout.widthPx, layout.heightPx)
      ctx.fillStyle = theme.background
      ctx.fillRect(0, 0, layout.widthPx, layout.heightPx)
      for (let index = 0; index < view.readers.length; index++) {
        const reader = view.readers[index]
        const rect = layout.rects[index]
        if (reader !== undefined && rect !== undefined)
          reader.draw({ ctx, rect, nowMs: view.frozenAtMs ?? nowMs, historyMs, theme })
      }
    }
    const update = (): void => {
      layout = layoutStrip({
        widths,
        heightPx: options.heightPx ?? 32,
        gapPx: options.gapPx ?? 2,
        dpr: platform.dpr(),
      })
      if (canvas.width !== layout.backingWidth) canvas.width = layout.backingWidth
      if (canvas.height !== layout.backingHeight) canvas.height = layout.backingHeight
      canvas.style.width = `${layout.widthPx}px`
      canvas.style.height = `${layout.heightPx}px`
      theme = resolveMeterTheme({ canvas, theme: options.readTheme() })
      draw(options.meters.clock.now())
    }
    update()
    yield* Effect.acquireRelease(
      Effect.sync(() => platform.observeChanges(update)),
      (unsubscribe) => Effect.sync(unsubscribe),
    )
    yield* options.meters.clock.subscribe({ phase: 'Draw', listener: (tick) => draw(tick.atMs) })
  }),
})
