import * as React from 'react'
import { Button, Link, type ButtonProps } from 'react-aria-components'

import type { OutlineEntry, OutlineHrefEntry } from './model.ts'

export type OutlineNavigationProps = {
  readonly activeId: string | undefined
  readonly 'aria-label'?: string
} & (
  | { readonly entries: readonly OutlineEntry[]; readonly onNavigate: (id: string) => void }
  | { readonly entries: readonly OutlineHrefEntry[]; readonly onNavigate?: undefined }
)

export type OutlineLinkProps = {
  readonly activeId: string | undefined
  readonly className?: string
  readonly style?: React.CSSProperties
  readonly children?: React.ReactNode
  readonly title?: string
} & (
  | { readonly entry: OutlineEntry; readonly onNavigate: (id: string) => void }
  | { readonly entry: OutlineHrefEntry; readonly onNavigate?: undefined }
)

/** Anchors retain native alternate activation; plain activation may delegate to a pane adapter. */
export const OutlineLink = ({
  entry,
  activeId,
  onNavigate,
  children,
  ...presentation
}: OutlineLinkProps): React.ReactNode => {
  const descriptionId = React.useId()
  const common = {
    ...presentation,
    'aria-current': entry.id === activeId ? ('location' as const) : undefined,
    'aria-describedby': entry.description === undefined ? undefined : descriptionId,
  }
  return (
    <>
      {entry.href !== undefined ? (
        <Link
          {...common}
          href={entry.href}
          onClick={(event) => {
            const target = event.currentTarget.getAttribute('target')
            if (
              onNavigate !== undefined &&
              event.button === 0 &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              !event.altKey &&
              !event.defaultPrevented &&
              (target === null || target === '' || target === '_self') &&
              !event.currentTarget.hasAttribute('download')
            ) {
              event.preventDefault()
              onNavigate(entry.id)
            }
          }}
        >
          {children ?? entry.label}
        </Link>
      ) : (
        <Button {...common} onPress={() => onNavigate?.(entry.id)}>
          {children ?? entry.label}
        </Button>
      )}
      {entry.description !== undefined && (
        <span id={descriptionId} hidden>
          {entry.description}
        </span>
      )}
    </>
  )
}

export interface OutlineRailInteractions {
  readonly isOpen: boolean
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>
  readonly panelRef: React.RefObject<HTMLDivElement | null>
  readonly navProps: React.HTMLAttributes<HTMLElement>
  readonly triggerProps: ButtonProps
  readonly panelProps: React.HTMLAttributes<HTMLDivElement>
}

/** A nonmodal navigation disclosure: normal Tab/Enter, no synthetic collection role. */
export const useOutlineRail = ({
  activeId,
}: {
  readonly activeId: string | undefined
}): OutlineRailInteractions => {
  const [isOpen, setOpen] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const hovered = React.useRef(false)
  const focused = React.useRef(false)
  const suppressed = React.useRef(false)
  const panelId = React.useId()

  React.useLayoutEffect(() => {
    if (!isOpen) return
    const panel = panelRef.current
    const active = panel?.querySelector<HTMLElement>('[aria-current="location"]')
    if (panel === null || active === undefined || active === null) return
    // Reading-state updates must not displace the row a keyboard user is navigating.
    if (panel.contains(panel.ownerDocument.activeElement)) return
    const panelRect = panel.getBoundingClientRect()
    const activeRect = active.getBoundingClientRect()
    if (activeRect.top < panelRect.top) panel.scrollTop += activeRect.top - panelRect.top
    else if (activeRect.bottom > panelRect.bottom)
      panel.scrollTop += activeRect.bottom - panelRect.bottom
  }, [isOpen, activeId])

  return {
    isOpen,
    triggerRef,
    panelRef,
    navProps: {
      onPointerEnter: () => {
        hovered.current = true
        suppressed.current = false
        setOpen(true)
      },
      onPointerLeave: () => {
        hovered.current = false
        if (!focused.current) setOpen(false)
      },
      onFocus: (event) => {
        focused.current = true
        if (!event.currentTarget.contains(event.relatedTarget) && !suppressed.current) setOpen(true)
      },
      onBlur: (event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return
        focused.current = false
        suppressed.current = false
        if (!hovered.current) setOpen(false)
      },
      onKeyDown: (event) => {
        if (event.key !== 'Escape' || !isOpen) return
        event.preventDefault()
        event.stopPropagation()
        suppressed.current = true
        setOpen(false)
        triggerRef.current?.focus()
      },
    },
    triggerProps: {
      'aria-expanded': isOpen,
      'aria-controls': panelId,
      onPress: () => {
        suppressed.current = false
        setOpen(true)
      },
    },
    panelProps: { id: panelId, hidden: !isOpen },
  }
}
