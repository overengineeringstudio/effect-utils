import * as React from 'react'

const contentEditable = '[contenteditable]:not([contenteditable="false"])'
const itemSelector = `button, a[href], input, select, textarea, [tabindex], ${contentEditable}`
/** Text entry keeps its own arrow keys. */
const editable = `input, select, textarea, ${contentEditable}, [role="slider"]`

/**
 * Elements that cannot hold focus, or are hidden from assistive tech, in the row. CSS-hidden items
 * are re-checked on every render, focus and key press; style changes alone do not trigger it.
 */
const unreachable = (element: HTMLElement): boolean =>
  element.closest('[inert], [hidden], [aria-hidden="true"]') !== null ||
  element.matches(':disabled, input[type="hidden"]') === true ||
  (typeof element.checkVisibility === 'function' &&
    element.checkVisibility({ visibilityProperty: true }) === false)

/** Row candidates outside popovers, whose own focus order the shell leaves alone. */
const rowCandidates = (row: HTMLElement): HTMLElement[] =>
  Array.from(row.querySelectorAll<HTMLElement>(itemSelector)).filter(
    (element) => element.closest('[popover]') === null,
  )

/** Reachable row items: not hidden (including into overflow, `inert`), not inside a popover, not disabled. */
const rowItems = (row: HTMLElement): HTMLElement[] =>
  rowCandidates(row).filter((element) => unreachable(element) === false)

/**
 * One Tab stop for the whole row (roving tabindex): arrows, Home and End move between items, and
 * focus that falls out of the row because its item was hidden or removed lands on the overflow
 * control, or the nearest item, instead of the document body.
 */
export const useRovingFocus = ({
  rowRef,
  observe,
}: {
  readonly rowRef: React.RefObject<HTMLElement | null>
  /** Watch host content for hidden or removed items; shell controls change only through renders. */
  readonly observe: boolean
}): ((event: React.KeyboardEvent<HTMLElement>) => void) => {
  const current = React.useRef<HTMLElement | undefined>(undefined)
  // Refs, not effect locals: recovery state must survive `observe` switching on or off.
  const focusInside = React.useRef(false)
  const lastIndex = React.useRef(0)
  const sync = React.useCallback((): HTMLElement[] => {
    const row = rowRef.current
    if (row === null) return []
    const candidates = rowCandidates(row)
    const items = candidates.filter((element) => unreachable(element) === false)
    if (current.current === undefined || items.includes(current.current) === false)
      current.current = items[0]
    // Unreachable candidates leave the Tab sequence too: `aria-hidden` alone keeps them focusable.
    for (const candidate of candidates) {
      const tabIndex = candidate === current.current ? '0' : '-1'
      if (candidate.getAttribute('tabindex') !== tabIndex)
        candidate.setAttribute('tabindex', tabIndex)
    }
    return items
  }, [rowRef])

  /** Moves focus that fell to the body, or onto an item that became unreachable, to a reachable item. */
  const recover = React.useCallback((): void => {
    const row = rowRef.current
    if (row === null || focusInside.current === false) return
    const body = row.ownerDocument.body
    const active = row.ownerDocument.activeElement
    if (active !== null && active !== body) {
      if (row.contains(active) === false) {
        focusInside.current = false
        return
      }
      // Focus on a reachable item, or inside an open popover, stays where it is.
      if ((active instanceof HTMLElement && unreachable(active)) === false) return
    }
    const lost = current.current
    const items = sync()
    // A click elsewhere also leaves the body focused; only a vanished item is recovered.
    if (active === body && lost !== undefined && items.includes(lost) === true) {
      focusInside.current = false
      return
    }
    const fallback =
      items.find((item) => item.hasAttribute('data-devbar-overflow-trigger')) ??
      items[Math.min(lastIndex.current, items.length - 1)]
    if (fallback === undefined) return
    current.current = fallback
    sync()
    fallback.focus()
  }, [rowRef, sync])

  // Every commit: shell controls (panel buttons, the toggle) are added or removed only by renders.
  React.useLayoutEffect(() => {
    recover()
    sync()
  })

  React.useLayoutEffect(() => {
    const row = rowRef.current
    if (row === null) return
    const onFocusIn = (event: FocusEvent): void => {
      const items = rowItems(row)
      if (event.target instanceof HTMLElement && items.includes(event.target) === true) {
        current.current = event.target
        lastIndex.current = items.indexOf(event.target)
        focusInside.current = true
        sync()
      }
    }
    const onFocusOut = (event: FocusEvent): void => {
      if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget) === false)
        focusInside.current = false
      else queueMicrotask(recover)
    }
    row.addEventListener('focusin', onFocusIn)
    row.addEventListener('focusout', onFocusOut)
    return () => {
      row.removeEventListener('focusin', onFocusIn)
      row.removeEventListener('focusout', onFocusOut)
    }
  }, [rowRef, sync, recover])

  React.useLayoutEffect(() => {
    const row = rowRef.current
    if (row === null || observe === false) return
    const observer = new MutationObserver(() => {
      // Recover first: it must see which item was focused before re-evaluation replaces it.
      recover()
      sync()
    })
    observer.observe(row, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['inert', 'disabled', 'hidden', 'aria-hidden', 'popover', 'type'],
    })
    return () => observer.disconnect()
  }, [rowRef, sync, recover, observe])

  return React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (
        event.defaultPrevented === true ||
        event.altKey === true ||
        event.ctrlKey === true ||
        event.metaKey === true
      )
        return
      if (event.target instanceof HTMLElement && event.target.matches(editable) === true) return
      const items = sync()
      const index = items.indexOf(event.target as HTMLElement)
      if (index === -1) return
      const target =
        event.key === 'ArrowRight'
          ? items[(index + 1) % items.length]
          : event.key === 'ArrowLeft'
            ? items[(index - 1 + items.length) % items.length]
            : event.key === 'Home'
              ? items[0]
              : event.key === 'End'
                ? items[items.length - 1]
                : undefined
      if (target === undefined) return
      event.preventDefault()
      current.current = target
      sync()
      target.focus()
    },
    [sync],
  )
}
