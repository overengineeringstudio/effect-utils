import * as React from 'react'

const itemSelector = 'button, a[href], input, select, textarea, [tabindex]'
/** Text entry keeps its own arrow keys. */
const editable = 'input, select, textarea, [contenteditable="true"], [role="slider"]'

/** Reachable row items: not hidden in overflow (`inert`), not inside a popover, not disabled. */
const rowItems = (row: HTMLElement): HTMLElement[] =>
  Array.from(row.querySelectorAll<HTMLElement>(itemSelector)).filter(
    (element) =>
      element.closest('[inert], [popover], [aria-hidden="true"]') === null &&
      element.matches(':disabled') === false,
  )

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
  /** Watch host content for hidden or removed items; off for a row with only shell controls. */
  readonly observe: boolean
}): ((event: React.KeyboardEvent<HTMLElement>) => void) => {
  const current = React.useRef<HTMLElement | undefined>(undefined)
  const sync = React.useCallback((): HTMLElement[] => {
    const row = rowRef.current
    if (row === null) return []
    const items = rowItems(row)
    if (current.current === undefined || items.includes(current.current) === false)
      current.current = items[0]
    for (const item of items) {
      const tabIndex = item === current.current ? '0' : '-1'
      if (item.getAttribute('tabindex') !== tabIndex) item.setAttribute('tabindex', tabIndex)
    }
    return items
  }, [rowRef])

  React.useLayoutEffect(() => {
    const row = rowRef.current
    if (row === null) return
    let focusInside = false
    let lastIndex = 0
    const recover = (): void => {
      if (focusInside === false) return
      const active = row.ownerDocument.activeElement
      if (active !== null && active !== row.ownerDocument.body) {
        focusInside = row.contains(active)
        return
      }
      const lost = current.current
      const items = sync()
      // A click elsewhere also leaves the body focused; only a vanished item is recovered.
      if (lost !== undefined && items.includes(lost) === true) {
        focusInside = false
        return
      }
      const fallback =
        items.find((item) => item.hasAttribute('data-devbar-overflow-trigger')) ??
        items[Math.min(lastIndex, items.length - 1)]
      if (fallback === undefined) return
      current.current = fallback
      sync()
      fallback.focus()
    }
    const onFocusIn = (event: FocusEvent): void => {
      const items = rowItems(row)
      if (event.target instanceof HTMLElement && items.includes(event.target) === true) {
        current.current = event.target
        lastIndex = items.indexOf(event.target)
        focusInside = true
        sync()
      }
    }
    const onFocusOut = (event: FocusEvent): void => {
      if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget) === false)
        focusInside = false
      else queueMicrotask(recover)
    }
    sync()
    row.addEventListener('focusin', onFocusIn)
    row.addEventListener('focusout', onFocusOut)
    const observer =
      observe === true
        ? new MutationObserver(() => {
            // Recover first: it must see which item was focused before re-evaluation replaces it.
            recover()
            sync()
          })
        : undefined
    observer?.observe(row, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['inert', 'disabled', 'hidden', 'aria-hidden', 'popover'],
    })
    return () => {
      observer?.disconnect()
      row.removeEventListener('focusin', onFocusIn)
      row.removeEventListener('focusout', onFocusOut)
    }
  }, [rowRef, sync, observe])

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
