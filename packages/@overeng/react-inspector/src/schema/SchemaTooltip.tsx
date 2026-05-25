import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FC, ReactNode } from 'react'

import type { LineageBundle, SchemaInfo } from './effectSchema.tsx'

export interface SchemaTooltipProps {
  /** Display-ready schema info; pass undefined to render children without a tooltip. */
  info: SchemaInfo | undefined
  /** The element the tooltip describes. */
  children: ReactNode
  /** Delay before showing on hover/focus, in ms. */
  openDelay?: number
  /** Delay before hiding after pointer leaves, in ms. */
  closeDelay?: number
}

/**
 * Hoverable/focusable tooltip showing Effect Schema annotations
 * (description, examples, default, constraints, possible values).
 *
 * Renders children as-is when `info` is undefined or contains no surfaceable
 * content — keeps the DOM clean for fields without any annotations.
 *
 * Implementation notes:
 * - We hand-roll the tooltip with React state instead of pulling React Aria.
 *   The interaction we need (hover + keyboard focus, with aria-describedby
 *   wiring) is small enough that the dep isn't worth the weight here, and
 *   RAC's `TooltipTrigger` requires its child to be a Pressable/Focusable
 *   with an interactive ARIA role — which a tree-item field-name span isn't.
 * - The tooltip element is a sibling of the trigger with `position: fixed`,
 *   so it isn't clipped by `overflow: hidden` on inspector containers. The
 *   trigger's `getBoundingClientRect()` is captured at open time; we close
 *   on scroll/resize rather than tracking, since by then the user's intent
 *   has changed.
 * - Tooltip is positioned to the right of the trigger by default (falling
 *   back to left, then below if it would overflow the viewport). This keeps
 *   the tooltip out of the tree's left column, so it doesn't overlap
 *   adjacent row triggers — which lets the tooltip body stay pointer-
 *   interactive (move into it to read long content / select text) without
 *   blocking hover on neighboring rows.
 */
export const SchemaTooltip: FC<SchemaTooltipProps> = ({
  info,
  children,
  openDelay = 250,
  closeDelay = 100,
}) => {
  const id = useId()
  const triggerRef = useRef<HTMLSpanElement | null>(null)
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  /*
   * Position the tooltip to the *right* of the trigger by default, vertically
   * aligned with the trigger's top edge. This keeps the tooltip out of the
   * tree's left column, so it doesn't visually overlap sibling row triggers
   * below the active row — which means we can leave `pointer-events: auto`
   * on the tooltip body (users can move into it to read long content or
   * select text) without blocking hover on neighboring rows.
   *
   * Fallback order: right → left (if right would overflow viewport) → below
   * (clamped to viewport). The 360px constant matches the tooltip's
   * `maxWidth`. We don't measure the actual rendered tooltip width because
   * we'd need a two-pass render; using max-width as the safety bound is
   * good enough and avoids a flash.
   */
  const computeCoords = useCallback(() => {
    const trig = triggerRef.current
    if (trig === null) return
    const rect = trig.getBoundingClientRect()
    const gap = 8
    const maxTooltipWidth = 360
    const viewportPadding = 8

    let left = rect.right + gap
    let top = rect.top
    if (left + maxTooltipWidth > window.innerWidth - viewportPadding) {
      const leftCandidate = rect.left - maxTooltipWidth - gap
      if (leftCandidate >= viewportPadding) {
        left = leftCandidate
      } else {
        // Last resort: below, clamped horizontally.
        left = Math.max(
          viewportPadding,
          Math.min(rect.left, window.innerWidth - maxTooltipWidth - viewportPadding),
        )
        top = rect.bottom + gap
      }
    }

    setCoords({ top, left })
  }, [])

  const handleOpen = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    if (open === true) return
    openTimerRef.current = setTimeout(() => {
      computeCoords()
      setOpen(true)
    }, openDelay)
  }, [open, openDelay, computeCoords])

  const handleClose = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    closeTimerRef.current = setTimeout(() => setOpen(false), closeDelay)
  }, [closeDelay])

  /*
   * Close on Escape per WCAG, and on scroll/resize because our captured
   * coords would otherwise drift away from the trigger.
   */
  useEffect(() => {
    if (open === false) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onScrollOrResize = () => setOpen(false)
    window.addEventListener('keydown', onKey)
    /* Capture phase + true useCapture catches scrolls in nested containers. */
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open])

  useEffect(() => () => clearTimers(), [clearTimers])

  if (info === undefined || info.hasContent === false) {
    return <>{children}</>
  }

  return (
    <>
      <span
        ref={triggerRef}
        tabIndex={0}
        aria-describedby={open === true ? id : undefined}
        onMouseEnter={handleOpen}
        onMouseLeave={handleClose}
        onFocus={handleOpen}
        onBlur={handleClose}
        style={{
          outline: 'none',
          cursor: 'help',
          textDecoration: 'underline dotted 1px',
          textUnderlineOffset: 2,
        }}
      >
        {children}
      </span>
      {open && coords !== null && (
        <div
          id={id}
          role="tooltip"
          data-testid="schema-tooltip-content"
          /*
           * Keep the tooltip interactive: moving the cursor from the trigger
           * onto the tooltip body cancels the close timer, so users can read
           * long content / select text without it vanishing. Adjacent-row
           * triggers are not blocked because we position the tooltip to the
           * right of the trigger (see `computeCoords`).
           */
          onMouseEnter={() => {
            if (closeTimerRef.current !== null) {
              clearTimeout(closeTimerRef.current)
              closeTimerRef.current = null
            }
          }}
          onMouseLeave={handleClose}
          style={{
            position: 'fixed',
            top: coords.top,
            left: coords.left,
            background: 'rgb(28, 28, 32)',
            color: 'rgb(232, 232, 240)',
            border: '1px solid rgb(60, 60, 70)',
            borderRadius: 6,
            padding: '8px 10px',
            maxWidth: 360,
            fontFamily:
              'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            fontSize: 12,
            lineHeight: 1.4,
            boxShadow: '0 6px 24px rgba(0, 0, 0, 0.35)',
            zIndex: 10000,
            pointerEvents: 'auto',
          }}
        >
          <SchemaTooltipContent info={info} />
        </div>
      )}
    </>
  )
}

const sectionStyle: React.CSSProperties = {
  marginTop: 6,
}

const labelStyle: React.CSSProperties = {
  display: 'inline-block',
  textTransform: 'uppercase',
  fontSize: 10,
  letterSpacing: '0.04em',
  color: 'rgb(150, 150, 165)',
  marginRight: 6,
}

const monoStyle: React.CSSProperties = {
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 11,
  color: 'rgb(220, 220, 230)',
}

const SchemaTooltipContent: FC<{ info: SchemaInfo }> = ({ info }) => {
  return (
    <div>
      {(info.displayName !== undefined || info.typeKind !== undefined) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          {info.displayName !== undefined && (
            <span style={{ fontWeight: 600 }}>{info.displayName}</span>
          )}
          {info.typeKind !== undefined && (
            <span style={{ fontSize: 10, color: 'rgb(150, 150, 165)' }}>{info.typeKind}</span>
          )}
        </div>
      )}

      {info.description !== undefined && (
        <div style={{ ...sectionStyle, color: 'rgb(220, 220, 230)' }}>{info.description}</div>
      )}

      {info.documentation !== undefined && (
        <div style={{ ...sectionStyle, color: 'rgb(180, 180, 200)', fontStyle: 'italic' }}>
          {info.documentation}
        </div>
      )}

      {info.possibleValues !== undefined && (
        <div style={sectionStyle}>
          <span style={labelStyle}>Allowed</span>
          <span style={monoStyle}>
            {info.possibleValues.join(' | ')}
            {info.possibleValuesTruncated !== undefined && info.possibleValuesTruncated > 0
              ? ` … +${info.possibleValuesTruncated} more`
              : ''}
          </span>
        </div>
      )}

      {info.constraints !== undefined && (
        <div style={sectionStyle}>
          <span style={labelStyle}>Constraints</span>
          <span style={monoStyle}>
            {info.constraints
              .map((c) => (c.value === '' ? c.label : `${c.label} ${c.value}`))
              .join(', ')}
          </span>
        </div>
      )}

      {info.defaultValue !== undefined && (
        <div style={sectionStyle}>
          <span style={labelStyle}>Default</span>
          <span style={monoStyle}>{info.defaultValue}</span>
        </div>
      )}

      {info.lineage !== undefined && <LineageSection bundle={info.lineage} />}

      {info.examples !== undefined && (
        <div style={sectionStyle}>
          <span style={labelStyle}>Examples</span>
          <ul
            style={{
              margin: '4px 0 0',
              padding: '0 0 0 16px',
              listStyle: 'disc',
              ...monoStyle,
            }}
          >
            {info.examples.map((ex, i) => (
              // eslint-disable-next-line react/no-array-index-key -- example values are positional, stable for the lifetime of the schema
              <li key={i}>{ex}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

const lineagePathStyle: React.CSSProperties = {
  ...monoStyle,
  color: 'rgb(160, 200, 255)',
}

/**
 * Render the LINEAGE section plus any companion annotation rows
 * (AUTHORITY / FRESHNESS / REF) inside the tooltip body.
 *
 * Field paths inside derived/projection/cache lineage are emitted with a
 * `data-lineage-target` attribute so future “jump to source” wiring can find
 * them without re-parsing the rendered tooltip.
 *
 * @see https://github.com/overengineeringstudio/effect-utils/issues/687
 */
const LineageSection: FC<{ bundle: LineageBundle }> = ({ bundle }) => {
  const { display, authority, freshness, reference } = bundle
  const hasPrimary = display.kindLabel !== ''
  return (
    <>
      {hasPrimary && (
        <div style={sectionStyle}>
          <div style={{ marginBottom: 2 }}>
            <span style={labelStyle}>Lineage</span>
          </div>
          <div>
            <span style={{ fontWeight: 600, marginRight: 6 }}>
              <span aria-hidden="true" style={{ marginRight: 4 }}>
                {display.badge}
              </span>
              {display.kindLabel}
            </span>
            <span style={{ color: 'rgb(220, 220, 230)' }}>
              {renderSummaryWithPaths(display.summary)}
            </span>
          </div>
          {display.details !== undefined && display.details.length > 0 && (
            <div style={{ marginTop: 2 }}>
              {display.details.map((d) => (
                <div key={d.label}>
                  <span style={labelStyle}>{d.label}</span>
                  <span style={monoStyle}>{d.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {authority !== undefined && (
        <div style={sectionStyle}>
          <span style={labelStyle}>Authority</span>
          <span style={monoStyle}>
            writers: {authority.writers.join(', ')}
            {authority.readers !== undefined && authority.readers.length > 0
              ? `; readers: ${authority.readers.join(', ')}`
              : ''}
          </span>
        </div>
      )}

      {freshness !== undefined && (
        <div style={sectionStyle}>
          <span style={labelStyle}>Freshness</span>
          <span style={monoStyle}>{formatFreshness(freshness)}</span>
        </div>
      )}

      {reference !== undefined && (
        <div style={sectionStyle}>
          <span style={labelStyle}>Ref</span>
          <span style={lineagePathStyle} data-lineage-target={reference.targetField ?? ''}>
            → {reference.targetSchema}
            {reference.targetField !== undefined ? `.${reference.targetField}` : ''}
          </span>
        </div>
      )}
    </>
  )
}

/*
 * Highlight `$.foo` / `$.foo.bar` tokens inside the lineage summary so source
 * field paths stand out from prose. Token shape mirrors LineageRef Field
 * paths produced by `lineage.ts`.
 */
const PATH_TOKEN_RE = /\$\.[A-Za-z_$][\w$.[\]]*/g

const renderSummaryWithPaths = (summary: string): ReactNode => {
  const parts: ReactNode[] = []
  let lastIndex = 0
  let key = 0
  for (const match of summary.matchAll(PATH_TOKEN_RE)) {
    const start = match.index
    if (start === undefined) continue
    if (start > lastIndex) parts.push(summary.slice(lastIndex, start))
    parts.push(
      <span key={key++} style={lineagePathStyle} data-lineage-target={match[0]}>
        {match[0]}
      </span>,
    )
    lastIndex = start + match[0].length
  }
  if (lastIndex < summary.length) parts.push(summary.slice(lastIndex))
  return parts.length > 0 ? parts : summary
}

const formatFreshness = (freshness: { capturedAt?: string; maxAgeMs?: number }): string => {
  const parts: string[] = []
  if (freshness.capturedAt !== undefined) parts.push(freshness.capturedAt)
  if (freshness.maxAgeMs !== undefined) parts.push(`≤ ${freshness.maxAgeMs}ms`)
  return parts.length > 0 ? parts.join(' ') : 'unspecified'
}
