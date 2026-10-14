import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles } from '@stylexjs/stylex'
import * as React from 'react'

import { devbarTokens } from './tokens.stylex.ts'

/** Nonmodal, lazy host-content dialog anchored to a native button. */
export interface AnchoredDisclosureProps {
  readonly label: string
  readonly trigger: React.ReactNode
  readonly triggerLabel: string
  readonly hasUnseen?: boolean | undefined
  readonly children: React.ReactNode
  readonly onOpenChange?: ((open: boolean) => void) | undefined
  readonly style?: StyleXStyles | undefined
  /** Shares the actual native button with composed tooltip positioning. */
  readonly triggerRef?: React.RefObject<HTMLButtonElement | null> | undefined
  /** Optional trigger semantics for composed identity tooltips. */
  readonly triggerProps?:
    | Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onFocus' | 'onBlur' | 'aria-describedby'>
    | undefined
}

/** Keeps host content unmounted until its native top-layer disclosure opens. */
export const AnchoredDisclosure = ({
  label,
  trigger,
  triggerLabel,
  hasUnseen,
  children,
  onOpenChange,
  style,
  triggerProps,
  triggerRef,
}: AnchoredDisclosureProps): React.ReactNode => {
  const disclosure = useAnchoredPopover({ onOpenChange })
  const setTriggerRef = React.useCallback(
    (node: HTMLButtonElement | null): void => {
      disclosure.triggerRef.current = node
      if (triggerRef !== undefined) triggerRef.current = node
    },
    [disclosure.triggerRef, triggerRef],
  )
  return (
    <>
      <button
        ref={setTriggerRef}
        type="button"
        aria-label={triggerLabel}
        aria-expanded={disclosure.expanded}
        aria-controls={disclosure.id}
        aria-haspopup="dialog"
        onClick={disclosure.toggle}
        {...triggerProps}
        {...stylex.props(styles.trigger, style)}
      >
        {trigger}
        {hasUnseen === true && <UnseenDot />}
      </button>
      <div
        ref={disclosure.popoverRef}
        id={disclosure.id}
        popover="auto"
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        data-devbar-disclosure={disclosure.expanded === true ? '' : undefined}
        onToggle={disclosure.onToggle}
        {...stylex.props(
          anchoredPopoverStyles.surface,
          anchoredPopoverStyles.position(
            disclosure.position.top,
            disclosure.position.bottom,
            disclosure.position.left,
            disclosure.position.maxHeight,
          ),
        )}
      >
        {disclosure.expanded === true && children}
      </div>
    </>
  )
}

/** Shared alert marker; its meaning is carried by the trigger's accessible name. */
export const UnseenDot = (): React.ReactNode => (
  <span aria-hidden="true" data-devbar-unseen {...stylex.props(styles.dot)} />
)

/** Shared native-popover surface, retaining the host's inherited theme. */
export const anchoredPopoverStyles = stylex.create({
  surface: {
    position: 'fixed',
    inset: 'auto',
    margin: 0,
    zIndex: 201,
    width: 'max-content',
    maxWidth: 'calc(100vw - 1rem)',
    overflow: 'auto',
    padding: '0.5rem',
    boxSizing: 'border-box',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: devbarTokens.border,
    borderRadius: '0.25rem',
    backgroundColor: devbarTokens.panel,
    color: devbarTokens.text,
    fontFamily: devbarTokens.fontUi,
    fontSize: '0.75rem',
    outlineWidth: { default: 0, ':focus-visible': 2 },
    outlineStyle: 'solid',
    outlineColor: devbarTokens.focusRing,
    outlineOffset: '-2px',
  },
  position: (top: number | null, bottom: number | null, left: number, maxHeight: number) => ({
    top,
    bottom,
    left,
    maxHeight: `min(24rem, ${maxHeight}px)`,
  }),
})

/** Native open state and lifecycle shared by overflow and composed disclosures. */
export const useAnchoredPopover = ({
  onOpenChange,
  enabled = true,
  overflow = false,
}: {
  readonly onOpenChange?: ((open: boolean) => void) | undefined
  readonly enabled?: boolean | undefined
  readonly overflow?: boolean | undefined
}) => {
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const popoverRef = React.useRef<HTMLDivElement>(null)
  const id = React.useId()
  const [expanded, setExpanded] = React.useState(false)
  const [position, setPosition] = React.useState<{
    top: number | null
    bottom: number | null
    left: number
    maxHeight: number
  }>({ top: null, bottom: 0, left: 8, maxHeight: 0 })
  const openRef = React.useRef(false)
  const callback = React.useRef(onOpenChange)
  callback.current = onOpenChange
  const change = (open: boolean): void => {
    if (openRef.current === open) return
    openRef.current = open
    setExpanded(open)
    callback.current?.(open)
  }
  const close = (restoreFocus: boolean): void => {
    popoverRef.current?.hidePopover()
    change(false)
    if (restoreFocus === true) triggerRef.current?.focus()
  }
  React.useLayoutEffect(() => {
    if (enabled === false && expanded === true) close(false)
  }, [enabled, expanded])
  React.useLayoutEffect(() => {
    if (expanded === true && triggerRef.current?.closest('[inert]') !== null) close(false)
  })
  React.useLayoutEffect(() => {
    if (expanded === false) return
    const popover = popoverRef.current
    const trigger = triggerRef.current
    if (popover === null || trigger === null) return
    popover.showPopover()
    const positionPopover = (): void => {
      const bounds = trigger.getBoundingClientRect()
      const width = popover.getBoundingClientRect().width
      const above = Math.max(0, bounds.top - 8)
      const below = Math.max(0, window.innerHeight - bounds.bottom - 8)
      const placeBelow = above < below
      setPosition({
        top: placeBelow === true ? bounds.bottom : null,
        bottom: placeBelow === true ? null : window.innerHeight - bounds.top,
        left: Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)),
        maxHeight: placeBelow === true ? below : above,
      })
    }
    positionPopover()
    popover.focus()
    const observer = new ResizeObserver(positionPopover)
    observer.observe(popover)
    window.addEventListener('resize', positionPopover)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented === true) return
      // Nested disclosures and identity tooltips consume Escape before overflow.
      if (
        overflow === true &&
        (document.querySelector('[data-devbar-disclosure]') !== null ||
          document.querySelector('[data-devbar-identity-tooltip]') !== null)
      )
        return
      event.preventDefault()
      event.stopPropagation()
      close(true)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', positionPopover)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [expanded, overflow])
  React.useLayoutEffect(
    () => () => {
      if (openRef.current === true) {
        openRef.current = false
        callback.current?.(false)
      }
    },
    [],
  )
  return {
    triggerRef,
    popoverRef,
    id,
    expanded,
    position,
    toggle: (): void => (expanded === true ? close(true) : change(true)),
    onToggle: (event: React.ToggleEvent<HTMLDivElement>): void => {
      // Toggle events are coalesced by the browser; use the current native state.
      change(event.currentTarget.matches(':popover-open'))
    },
  }
}

const styles = stylex.create({
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.3rem',
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    cursor: 'pointer',
    outlineWidth: { default: 0, ':focus-visible': 2 },
    outlineStyle: 'solid',
    outlineColor: devbarTokens.focusRing,
  },
  dot: {
    display: 'inline-block',
    width: 6,
    height: 6,
    flexShrink: 0,
    borderRadius: '50%',
    backgroundColor: devbarTokens.focusRing,
  },
})
