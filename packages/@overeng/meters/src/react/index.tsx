import { Cause, Effect, Fiber, type Scope } from 'effect'
import * as React from 'react'

import {
  layoutStrip,
  makeCanvasStrip,
  makeStripView,
  type CanvasBlockSpec,
  type CanvasPlatform,
  type MeterSession,
  type MeterTheme,
  type StripLayout,
} from '../canvas/index.ts'
import type { CounterToken, Instrumentation } from '../instrumentation/index.ts'
import type { Sample, Series, SeriesSnapshot } from '../series/index.ts'
import type { Meters } from '../session/index.ts'
import { associateProfiler, type ReactCommit } from './commits.ts'

export { reactCommitsSource, type ReactCommit } from './commits.ts'
export { MetersPanel, type MetersPanelProps } from './panel.tsx'

const MetersContext = React.createContext<MeterSession | undefined>(undefined)
/** Fork one scoped program on the ambient runtime; unexpected causes are logged, unmount interruption is not. */
const forkScoped = <A, E>(program: Effect.Effect<A, E, Scope.Scope>): Fiber.Fiber<A, E> =>
  Effect.runFork(
    program.pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause) === true
          ? Effect.void
          : Effect.logError('Meters React effect failed', cause),
      ),
      Effect.scoped,
    ),
  )
/** Run one scoped program and return the cancel that interrupts it; its scope closes with the fiber. */
const runScoped = <A, E>(program: Effect.Effect<A, E, Scope.Scope>): (() => void) => {
  const fiber = forkScoped(program)
  return () => {
    void Effect.runFork(Fiber.interrupt(fiber))
  }
}
/** Run one scoped program for the whole component lifetime; StrictMode remounts serialize behind the session lease. */
const useScopedLifetime = <A, E>(program: Effect.Effect<A, E, Scope.Scope>): void => {
  React.useEffect(() => runScoped(program), [program])
}
/** The fully provided session owned by the provider; the host supplies any Effect environment when constructing sources. */
export interface MetersProviderProps {
  readonly meters: Meters<never>
  readonly children: React.ReactNode
}
/** Acquire one scoped session lease; rendering strips never acquire another lease. */
export const MetersProvider = (props: MetersProviderProps): React.ReactNode => {
  const lease = React.useMemo(
    () => props.meters.start.pipe(Effect.andThen(Effect.never)),
    [props.meters],
  )
  useScopedLifetime(lease)
  return <MetersContext.Provider value={props.meters}>{props.children}</MetersContext.Provider>
}
/** Read the shared renderer session from the nearest provider. */
export const useMeters = (): MeterSession => {
  const meters = React.useContext(MetersContext)
  if (meters === undefined) throw new TypeError('useMeters requires a MetersProvider')
  return meters
}
/** The minimal store shape React can subscribe to directly; snapshots stay identity-stable per revision. */
interface ExternalStore<TSnapshot> {
  readonly getSnapshot: () => TSnapshot
  readonly subscribe: (notify: () => void) => () => void
}
/** Subscribe React to an identity-stable external store without an Effect runtime provider. */
const useExternalStore = <TSnapshot,>(store: ExternalStore<TSnapshot>): TSnapshot =>
  React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
/** Select a revision-stable series history through React's external-store subscription. */
export const useSeriesSnapshot = <TValue,>(series: Series<TValue>): SeriesSnapshot<TValue> => {
  const meters = useMeters()
  const store = React.useMemo<ExternalStore<SeriesSnapshot<TValue>>>(
    () => ({
      getSnapshot: () => meters.store.snapshotSeries({ series }),
      subscribe: (notify) => meters.store.subscribe({ notify }),
    }),
    [meters, series],
  )
  return useExternalStore(store)
}
/** Read current typed evidence, returning explicit NoSamples before the first observation. */
export const useSeries = <TValue,>(series: Series<TValue>): Sample<TValue> => {
  const snapshot = useSeriesSnapshot(series)
  return (
    snapshot.samples[snapshot.samples.length - 1] ?? {
      _tag: 'Unavailable',
      atMs: 0,
      reason: 'NoSamples',
    }
  )
}
/** One renderer-only strip with host-owned detail activation and freeze state. */
export interface MeterStripProps {
  readonly meters: MeterSession
  readonly blocks: readonly CanvasBlockSpec[]
  readonly theme: MeterTheme
  readonly frozen: boolean
  readonly onFrozenChange: (frozen: boolean) => void
  readonly onOpenDetail: (selection: { readonly id: string }) => void
  readonly heightPx?: number
  readonly gapPx?: number
  readonly historyMs?: number
  readonly platform?: CanvasPlatform
}
/** Draw one DPR-aware canvas plus equivalent DOM outputs, focus targets, and keyboard tooltips. */
export const MeterStrip = (props: MeterStripProps): React.ReactNode => {
  const tooltipId = React.useId()
  const [interaction, setInteraction] = React.useState<
    { readonly _tag: 'None' } | { readonly _tag: 'Focus' | 'Hover'; readonly id: string }
  >({ _tag: 'None' })
  const view = React.useMemo(
    () =>
      makeStripView({
        store: props.meters.store,
        blocks: props.blocks,
        ...(props.frozen === true ? { frozenAtMs: props.meters.clock.now() } : {}),
      }),
    [props.meters, props.blocks, props.frozen],
  )
  const texts = useExternalStore(view)
  const heightPx = props.heightPx ?? 32
  const gapPx = props.gapPx ?? 2
  // The canvas attachment owns measurement; DOM overlays reuse its resolved layout.
  const [measured, setMeasured] = React.useState<StripLayout | undefined>(undefined)
  const nominal = layoutStrip({
    widths: props.blocks.map((item) => item.widthPx),
    heightPx,
    gapPx,
    dpr: 1,
  })
  const layout =
    measured !== undefined && measured.rects.length === props.blocks.length ? measured : nominal
  const onLayout = React.useCallback((next: StripLayout) => {
    // Re-render overlays only when CSS geometry changes; DPR-only changes keep identity.
    setMeasured((current) =>
      current !== undefined &&
      current.heightPx === next.heightPx &&
      current.rects.length === next.rects.length &&
      current.rects.every(
        // oxlint-disable-next-line overeng/named-args -- Native Array.every callback signature.
        (rect, index) => rect.x === next.rects[index]?.x && rect.width === next.rects[index]?.width,
      ) === true
        ? current
        : next,
    )
  }, [])
  const attach = React.useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (canvas === null) return
      return runScoped(
        makeCanvasStrip({
          canvas,
          meters: props.meters,
          blocks: props.blocks,
          view,
          heightPx,
          gapPx,
          ...(props.historyMs === undefined ? {} : { historyMs: props.historyMs }),
          ...(props.platform === undefined ? {} : { platform: props.platform }),
          readTheme: () => props.theme,
          onLayout,
        }).attach.pipe(Effect.andThen(Effect.never)),
      )
    },
    [
      props.meters,
      props.blocks,
      props.theme,
      props.platform,
      props.historyMs,
      view,
      heightPx,
      gapPx,
      onLayout,
    ],
  )
  const activeIndex =
    interaction._tag !== 'None' ? props.blocks.findIndex((item) => item.id === interaction.id) : -1
  return (
    <div
      role="group"
      aria-label="Meters"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        minWidth: 0,
        height: heightPx,
        color: props.theme.foreground,
        background: props.theme.background,
        font: props.theme.font,
      }}
    >
      <div
        style={{
          position: 'relative',
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: 0,
          minWidth: 0,
          height: heightPx,
        }}
      >
        <canvas ref={attach} aria-hidden="true" style={{ display: 'block' }} />
        {props.blocks.map(
          // oxlint-disable-next-line overeng/named-args -- Native Array.map callback signature.
          (item, index) => (
            <button
              key={item.id}
              type="button"
              aria-label={`${item.label}: ${texts[index] ?? 'n/a (NoSamples)'}`}
              aria-describedby={activeIndex === index ? tooltipId : undefined}
              onClick={() => props.onOpenDetail({ id: item.id })}
              onFocus={() => setInteraction({ _tag: 'Focus', id: item.id })}
              onBlur={() => setInteraction({ _tag: 'None' })}
              onMouseEnter={() =>
                setInteraction((current) =>
                  current._tag === 'Focus' ? current : { _tag: 'Hover', id: item.id },
                )
              }
              onMouseLeave={() =>
                setInteraction((current) => (current._tag === 'Hover' ? { _tag: 'None' } : current))
              }
              onKeyDown={(event) => {
                if (event.key === 'Escape') setInteraction({ _tag: 'None' })
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  props.onOpenDetail({ id: item.id })
                }
              }}
              style={{
                position: 'absolute',
                left: layout.rects[index]?.x,
                top: 0,
                width: layout.rects[index]?.width ?? item.widthPx,
                height: heightPx,
                padding: 0,
                border: 0,
                background: 'transparent',
                color: 'transparent',
                outlineColor: props.theme.focus,
              }}
            >
              <output
                aria-label={item.label}
                style={{
                  position: 'absolute',
                  width: 1,
                  height: 1,
                  overflow: 'hidden',
                  clipPath: 'inset(50%)',
                  whiteSpace: 'nowrap',
                }}
              >
                {texts[index]}
              </output>
            </button>
          ),
        )}
        {activeIndex >= 0 && (
          <div
            id={tooltipId}
            role="tooltip"
            style={{
              position: 'absolute',
              bottom: heightPx + 4,
              left: layout.rects[activeIndex]?.x,
              padding: '4px 8px',
              color: props.theme.foreground,
              background: props.theme.background,
              border: `1px solid ${props.theme.border}`,
              whiteSpace: 'nowrap',
            }}
          >
            {props.blocks[activeIndex]?.label}: {texts[activeIndex]}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label={props.frozen === true ? 'Resume meters' : 'Freeze meters'}
        aria-pressed={props.frozen}
        title={props.frozen === true ? 'Resume meters' : 'Freeze meters'}
        onClick={() => props.onFrozenChange(props.frozen === false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          width: 24,
          height: 24,
          padding: 0,
          borderWidth: 0,
          borderRadius: 4,
          cursor: 'pointer',
          color: props.frozen === true ? props.theme.foreground : props.theme.muted,
          background: props.frozen === true ? props.theme.border : 'transparent',
          outlineColor: props.theme.focus,
          outlineOffset: -2,
        }}
      >
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          {props.frozen === true ? (
            <path d="M3 1.5v9l7.5-4.5z" />
          ) : (
            <>
              <rect x="2.5" y="1.5" width="2.5" height="9" rx="0.5" />
              <rect x="7" y="1.5" width="2.5" height="9" rx="0.5" />
            </>
          )}
        </svg>
      </button>
    </div>
  )
}
/** Explicitly injected commit instrumentation; optional callback is external fan-out only. */
export interface RenderProfilerProps {
  readonly instrumentation: Instrumentation
  readonly counter: CounterToken
  readonly id: string
  readonly children: React.ReactNode
  readonly onCommit?: (commit: ReactCommit) => void
}
/** Publish actual Profiler callbacks to the same feed/counter read by the event source. */
export const RenderProfiler = (props: RenderProfilerProps): React.ReactNode => {
  const { feed, registration } = React.useMemo(
    () => ({
      feed: associateProfiler({
        instrumentation: props.instrumentation,
        counter: props.counter,
        id: props.id,
      }),
      registration: { capable: false },
    }),
    [props.instrumentation, props.counter, props.id],
  )
  const lifecycle = React.useMemo(
    () =>
      Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          if (registration.capable === true) {
            registration.capable = false
            feed.configured--
            if (feed.configured === 0) for (const listener of feed.listeners) listener(undefined)
          }
        }),
      ).pipe(Effect.andThen(Effect.never)),
    [feed, registration],
  )
  useScopedLifetime(lifecycle)
  // oxlint-disable-next-line overeng/named-args -- Native React.Profiler callback signature.
  const onRender: React.ProfilerOnRenderCallback = (
    id,
    phase,
    actualDuration,
    baseDuration,
    _startTime,
    commitTime,
  ) => {
    if (registration.capable === false) {
      registration.capable = true
      feed.configured++
    }
    const counter = props.instrumentation.counter({ token: props.counter })
    counter.add({ by: 1 })
    const commit: ReactCommit = {
      _tag: 'ReactCommit',
      id,
      phase,
      actualDurationMs: actualDuration,
      baseDurationMs: baseDuration,
      commitTimeMs: commitTime,
      commits: counter.read(),
    }
    feed.latest = commit
    for (const listener of feed.listeners) listener(commit)
    props.onCommit?.(commit)
  }
  return (
    <React.Profiler id={props.id} onRender={onRender}>
      {props.children}
    </React.Profiler>
  )
}
