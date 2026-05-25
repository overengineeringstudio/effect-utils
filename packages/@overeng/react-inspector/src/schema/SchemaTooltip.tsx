import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FC, ReactNode } from 'react'

import type { SchemaInfo } from './effectSchema.tsx'

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
 * - Renders into a fixed-position portal-like overlay via `position: fixed`
 *   on a transform-anchored wrapper, so the tooltip isn't clipped by
 *   `overflow: hidden` on inspector containers.
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

  const computeCoords = useCallback(() => {
    const trig = triggerRef.current
    if (trig === null) return
    const rect = trig.getBoundingClientRect()
    setCoords({
      top: rect.bottom + 6,
      left: rect.left,
    })
  }, [])

  const handleOpen = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    if (open) return
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

  /* Close on Escape per WCAG; common-sense for any popup-like element. */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => () => clearTimers(), [clearTimers])

  if (info === undefined || !info.hasContent) {
    return <>{children}</>
  }

  return (
    <>
      <span
        ref={triggerRef}
        tabIndex={0}
        aria-describedby={open ? id : undefined}
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
            /*
             * Crucial: must not intercept pointer events. Tree rows are dense
             * (~14px tall) so the tooltip below a row would otherwise sit on
             * top of the next row's trigger and prevent hovering it.
             */
            pointerEvents: 'none',
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
