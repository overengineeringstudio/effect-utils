import { Effect } from 'effect'
import * as React from 'react'

import {
  formatMeterValue,
  makeCanvasStrip,
  makeStripView,
  type BlockEvidence,
  type CanvasBlockSpec,
  type CanvasPlatform,
  type MeterFreeze,
  type MeterSession,
  type MeterTheme,
} from '../canvas/index.ts'
import { runScoped } from './scoped.ts'

/** The action that captured an evidence snapshot; the card names it so it never reads as live. */
export type MeterEvidenceTrigger = 'Focus' | 'Hover' | 'Activation' | 'Refresh'

/** A pure evidence card: everything it shows comes from one captured `BlockEvidence`. */
export interface MeterEvidenceProps {
  readonly id: string
  readonly evidence: BlockEvidence
  readonly trigger: MeterEvidenceTrigger
  readonly frozen: boolean
  readonly theme: MeterTheme
  readonly style?: React.CSSProperties | undefined
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

/** Ages are measured back from the evaluation instant, never from a wall clock. */
const latestText = (evidence: BlockEvidence): string => {
  const latest = evidence.latest
  if (latest === undefined) return 'no sample before evaluation'
  const before = `${seconds(evidence.evaluatedAtMs - latest.atMs)} before evaluation`
  switch (latest._tag) {
    case 'Value':
      return `latest sample ${before}`
    case 'Unavailable':
      // Source-owned freshness keeps the last real sample's time; its age shares the instant.
      return latest.lastKnownAtMs === undefined
        ? `unavailable (${latest.reason}) ${before}`
        : `unavailable (${latest.reason}) ${before}; last sample ${seconds(evidence.evaluatedAtMs - latest.lastKnownAtMs)} before evaluation`
    case 'Gap':
      return `gap (${latest.reason}, ${seconds(latest.durationMs)}) ending ${before}`
  }
}

/** The extrema cover completed buckets, so the window names its own end, not evaluation. */
const rangeText = (evidence: BlockEvidence): string | undefined => {
  const aggregation = evidence.aggregation
  if (aggregation._tag !== 'Bucket') return undefined
  const range = evidence.range
  const windowMs = range?.windowMs ?? aggregation.bucketMs * aggregation.buckets
  const endMs = range?.endMs ?? aggregation.endMs
  const windowText = `range over ${seconds(windowMs)} ending ${seconds(evidence.evaluatedAtMs - endMs)} before evaluation`
  if (range === undefined) return `${windowText}: no values`
  const format = (value: number): string => formatMeterValue({ value, unit: evidence.unit })
  return `${windowText}: min ${format(range.minimum)} / max ${format(range.maximum)}`
}

const triggerText: Record<MeterEvidenceTrigger, string> = {
  Focus: 'Snapshot taken on focus',
  Hover: 'Snapshot taken on hover',
  Activation: 'Snapshot taken on activation',
  Refresh: 'Snapshot refreshed',
}

/** Render one captured snapshot as a tooltip; it never subscribes to or reads the store. */
export const MeterEvidence = (props: MeterEvidenceProps): React.ReactNode => {
  const { evidence, theme } = props
  const range = rangeText(evidence)
  return (
    <div
      id={props.id}
      role="tooltip"
      style={{
        display: 'grid',
        gap: 2,
        maxWidth: '24rem',
        margin: 0,
        padding: '6px 8px',
        font: theme.font,
        lineHeight: 1.45,
        color: theme.foreground,
        background: theme.background,
        border: `1px solid ${theme.border}`,
        borderRadius: 4,
        pointerEvents: 'none',
        ...props.style,
      }}
    >
      <span>
        <span style={{ fontWeight: 600 }}>{evidence.label}</span> {evidence.text}
      </span>
      <span>{latestText(evidence)}</span>
      {range !== undefined && <span>{range}</span>}
      <span style={{ color: theme.muted }}>
        evaluated at session clock {seconds(evidence.evaluatedAtMs)}
        {props.frozen === true ? ' (frozen)' : ''} · revision {evidence.revision}
      </span>
      <span style={{ color: theme.muted }}>{triggerText[props.trigger]} · R refreshes</span>
    </div>
  )
}

/** One canvas meter tile; its card shows evidence captured on focus, hover or activation. */
export interface MeterTileProps {
  readonly meters: MeterSession
  /** Usually a `tileBlock`; its drawn label is the tile's static accessible name. */
  readonly block: CanvasBlockSpec
  readonly theme: MeterTheme
  /** A shared snapshot from `freezeMeters`; absent means the tile draws live evidence. */
  readonly frozen?: MeterFreeze | undefined
  readonly heightPx?: number | undefined
  readonly platform?: CanvasPlatform | undefined
}

interface Captured {
  readonly trigger: MeterEvidenceTrigger
  readonly evidence: BlockEvidence
}

/** Place the top-layer card above the tile, aligned to the tile edge nearer the viewport middle. */
const placeCard = (options: { readonly card: HTMLElement; readonly tile: HTMLElement }): void => {
  const window = options.tile.ownerDocument.defaultView
  if (window === null) return
  const rect = options.tile.getBoundingClientRect()
  const style = options.card.style
  style.position = 'fixed'
  style.inset = 'auto'
  style.bottom = `${Math.max(0, window.innerHeight - rect.top + 4)}px`
  if (rect.left + rect.width / 2 > window.innerWidth / 2)
    style.right = `${Math.max(0, window.innerWidth - rect.right)}px`
  else style.left = `${Math.max(0, rect.left)}px`
}

/** The one tile per session whose card is open; a capture on another tile dismisses it. */
const cardOwners = new WeakMap<MeterSession, () => void>()

/**
 * Draw one block on its own canvas through the session's shared Draw phase. Samples cause no
 * DOM writes and no React commits: only focus, hover, activation and R capture evidence.
 */
export const MeterTile = (props: MeterTileProps): React.ReactNode => {
  const { meters, block, theme, frozen } = props
  const heightPx = props.heightPx ?? 32
  const cardId = React.useId()
  const view = React.useMemo(
    () =>
      frozen?.view(block.id) ??
      makeStripView({ store: meters.store, blocks: [block], now: meters.clock.now }),
    [meters, block, frozen],
  )
  const attach = React.useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (canvas === null) return
      return runScoped(
        makeCanvasStrip({
          canvas,
          meters,
          blocks: [block],
          view,
          heightPx,
          gapPx: 0,
          readTheme: () => theme,
          ...(props.platform === undefined ? {} : { platform: props.platform }),
        }).attach.pipe(Effect.andThen(Effect.never)),
      )
    },
    [meters, block, view, heightPx, theme, props.platform],
  )
  const [captured, setCaptured] = React.useState<Captured | undefined>(undefined)
  const hovered = React.useRef(false)
  const dismiss = React.useCallback(() => setCaptured(undefined), [])
  React.useEffect(
    () => () => {
      if (cardOwners.get(meters) === dismiss) cardOwners.delete(meters)
    },
    [meters, dismiss],
  )
  const capture = (trigger: MeterEvidenceTrigger): void => {
    const reader = view.readers[0]
    if (reader === undefined) return
    const previous = cardOwners.get(meters)
    if (previous !== undefined && previous !== dismiss) previous()
    cardOwners.set(meters, dismiss)
    setCaptured({
      trigger,
      evidence: reader.evidence({ nowMs: view.frozenAtMs ?? meters.clock.now() }),
    })
  }
  // A freeze or unfreeze replaces the view; a card from the previous view would mix snapshots.
  const [capturedView, setCapturedView] = React.useState(view)
  if (capturedView !== view) {
    setCapturedView(view)
    setCaptured(undefined)
  }
  const tileRef = React.useRef<HTMLButtonElement>(null)
  const cardRef = React.useCallback((card: HTMLDivElement | null) => {
    const tile = tileRef.current
    if (card === null || tile === null) return
    placeCard({ card, tile })
    // The top layer escapes host scrollports such as the devbar row.
    if (typeof card.showPopover === 'function' && card.isConnected === true) card.showPopover()
  }, [])
  const label = block.shortLabel ?? block.label
  return (
    <>
      <button
        ref={tileRef}
        type="button"
        // Static name and title: values live in the evidence card, never in the name.
        aria-label={label}
        title={block.label}
        aria-describedby={captured === undefined ? undefined : cardId}
        aria-keyshortcuts="R"
        onClick={() => capture('Activation')}
        onFocus={() => capture('Focus')}
        onBlur={() => {
          if (hovered.current === false) setCaptured(undefined)
        }}
        onMouseEnter={() => {
          hovered.current = true
          if (captured === undefined) capture('Hover')
        }}
        onMouseLeave={(event) => {
          hovered.current = false
          // A focused tile keeps its card until blur or Escape.
          if (event.currentTarget.ownerDocument.activeElement !== event.currentTarget)
            setCaptured(undefined)
        }}
        onKeyDown={(event) => {
          if (event.key === 'r' || event.key === 'R') {
            if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return
            event.preventDefault()
            capture('Refresh')
          }
          // The first Escape dismisses the card; the next reaches the host.
          if (event.key === 'Escape' && captured !== undefined) {
            event.preventDefault()
            setCaptured(undefined)
          }
        }}
        style={{
          display: 'block',
          flexShrink: 0,
          width: block.widthPx,
          height: heightPx,
          padding: 0,
          border: 0,
          borderRadius: 2,
          background: theme.background,
          cursor: 'pointer',
          outlineColor: theme.focus,
          outlineOffset: -2,
        }}
      >
        <div style={{ width: block.widthPx, height: heightPx }}>
          <canvas ref={attach} aria-hidden="true" style={{ display: 'block' }} />
        </div>
      </button>
      {captured !== undefined && (
        <div ref={cardRef} popover="manual" style={{ padding: 0, border: 0, background: 'none' }}>
          <MeterEvidence
            id={cardId}
            evidence={captured.evidence}
            trigger={captured.trigger}
            frozen={view.frozenAtMs !== undefined}
            theme={theme}
          />
        </div>
      )}
    </>
  )
}

/** Toggle the shared freeze; its accessible name is static and the state is `aria-pressed`. */
export interface MeterFreezeButtonProps {
  readonly frozenAtMs: number | undefined
  readonly onToggle: () => void
  readonly theme: MeterTheme
  /** Icon only, for narrow hosts; the accessible name stays `Freeze meters`. */
  readonly compact?: boolean | undefined
}

/** One freeze action for every tile of a host; the host owns the `MeterFreeze` snapshot. */
export const MeterFreezeButton = (props: MeterFreezeButtonProps): React.ReactNode => {
  const { theme } = props
  const frozen = props.frozenAtMs !== undefined
  return (
    <button
      type="button"
      aria-label="Freeze meters"
      aria-pressed={frozen}
      title={
        props.frozenAtMs === undefined
          ? 'Freeze meters'
          : `Frozen at session clock ${seconds(props.frozenAtMs)}`
      }
      onClick={props.onToggle}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        flexShrink: 0,
        height: 24,
        padding: props.compact === true ? 0 : '0 6px',
        minWidth: 24,
        justifyContent: 'center',
        border: 0,
        borderRadius: 4,
        font: theme.font,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        color: frozen === true ? theme.foreground : theme.muted,
        background: frozen === true ? theme.border : 'transparent',
        outlineColor: theme.focus,
        outlineOffset: -2,
      }}
    >
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
        <rect x="2.5" y="1.5" width="2.5" height="9" rx="0.5" />
        <rect x="7" y="1.5" width="2.5" height="9" rx="0.5" />
      </svg>
      {props.compact !== true && (
        <span aria-hidden="true">
          {props.frozenAtMs === undefined ? 'freeze' : `frozen ${seconds(props.frozenAtMs)}`}
        </span>
      )}
    </button>
  )
}
