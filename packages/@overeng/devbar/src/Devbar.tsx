import * as stylex from '@stylexjs/stylex'
import type { StyleXStylesWithout } from '@stylexjs/stylex'
import * as React from 'react'

import { anchoredPopoverStyles, UnseenDot, useAnchoredPopover } from './disclosure.tsx'
import { fitSegments, type SegmentWidth } from './fitSegments.ts'
import { devbarTokens } from './tokens.stylex.ts'

/** A host-provided tool panel; only the selected panel's `render` is mounted. */
export interface DevbarPanel {
  /** Host-local, nonempty, case-sensitive ID, unique within `panels`. */
  readonly id: string
  readonly label: string
  readonly render: () => React.ReactNode
  readonly badge?: React.ReactNode
}

/** A host-owned status or action segment rendered at the trailing end of the bar. */
export interface DevbarSegment {
  /** Host-local, nonempty, case-sensitive ID, unique within `segments`. */
  readonly id: string
  /** Higher stays longer; default 0. Ties hide later-declared segments first. */
  readonly priority?: number | undefined
  /** Render at natural width; hidden content stays mounted in an inert measuring layer. */
  readonly render: () => React.ReactNode
  /** Host-owned alert mirrored on the overflow trigger when this segment is hidden. */
  readonly hasAlert?: boolean | undefined
  /** Display name for the overflow trigger's accessible name when hidden; defaults to `id`. */
  readonly label?: string | undefined
}

/** Controlled composition of the developer shell; the host owns every slot and the selection. */
export interface DevbarProps {
  readonly panels: readonly DevbarPanel[]
  /** Host-owned renderer slot (for example a meter strip); absent means no strip work. */
  readonly strip?: React.ReactNode | undefined
  /** Minimum strip slot width in CSS pixels before the whole row scrolls; defaults to 160. */
  readonly stripMinWidth?: number | undefined
  readonly segments?: readonly DevbarSegment[] | undefined
  /** Selected panel ID; an unknown ID renders no panel. */
  readonly openPanel: string | undefined
  /** Single proposal path for buttons, the close action, Ctrl/Meta+Backquote, and Escape. */
  readonly onOpenPanelChange: (id: string | undefined) => void
  /** Dock to the viewport, or stay within a host-positioned container. */
  readonly placement?: 'viewport' | 'container'
  /** Position is owned by placement; hosts can style all other root properties. */
  readonly style?: StyleXStylesWithout<{ position: 'fixed' }>
}

const rowHeight = '32px'

const styles = stylex.create({
  root: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 200,
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '100%',
    color: devbarTokens.text,
    fontFamily: devbarTokens.fontUi,
    fontSize: '0.75rem',
  },
  contained: { position: 'absolute' },
  panel: {
    height: 'min(48vh, 32rem)',
    minHeight: 0,
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: 'auto',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    backgroundColor: devbarTokens.canvas,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: devbarTokens.border,
  },
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
    height: '1.75rem',
    paddingInline: '0.5rem',
    backgroundColor: devbarTokens.panel,
    color: devbarTokens.mutedText,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: devbarTokens.border,
  },
  panelTitle: { margin: 0, fontSize: 'inherit', fontWeight: 600 },
  panelBody: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minHeight: 0,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'auto',
  },
  row: {
    display: 'flex',
    flexWrap: 'nowrap',
    alignItems: 'center',
    flexShrink: 0,
    height: rowHeight,
    minHeight: rowHeight,
    maxHeight: rowHeight,
    boxSizing: 'border-box',
    minWidth: 0,
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollbarWidth: 'thin',
    gap: '0.5rem',
    paddingInline: '0.5rem',
    backgroundColor: devbarTokens.canvas,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: devbarTokens.border,
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.25rem',
    flexShrink: 0,
    whiteSpace: 'nowrap',
  },
  strip: {
    display: 'flex',
    alignItems: 'center',
    alignSelf: 'stretch',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 'auto',
    overflowX: 'auto',
    overflowY: 'hidden',
  },
  stripWidth: (minimum: number) => ({ minWidth: minimum, width: minimum }),
  stripContent: {
    width: '100%',
    minWidth: 0,
    flexShrink: 0,
  },
  segments: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    flexGrow: 0,
    flexShrink: 1,
    whiteSpace: 'nowrap',
  },
  segmentWidth: (natural: number, overflow: number) => ({
    flexBasis: natural,
    minWidth: overflow,
  }),
  segment: { flexShrink: 0, width: 'max-content', whiteSpace: 'nowrap' },
  measuring: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 0,
    height: 0,
    overflow: 'hidden',
    visibility: 'hidden',
    pointerEvents: 'none',
  },
  overflow: { fontVariantNumeric: 'tabular-nums' },
  popoverItem: { width: 'max-content', paddingBlock: '0.25rem' },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    whiteSpace: 'nowrap',
    height: '1.5rem',
    paddingInline: '0.5rem',
    backgroundColor: { default: 'transparent', ':hover': devbarTokens.panel },
    color: devbarTokens.text,
    fontFamily: 'inherit',
    fontSize: 'inherit',
    borderWidth: 0,
    borderRadius: '0.25rem',
    cursor: { default: 'pointer', ':disabled': 'default' },
    opacity: { default: 1, ':disabled': 0.5 },
    outlineWidth: { default: 0, ':focus-visible': 2 },
    outlineStyle: 'solid',
    outlineColor: devbarTokens.focusRing,
    outlineOffset: '-2px',
  },
  active: { backgroundColor: devbarTokens.panelActive },
  badge: { marginLeft: '0.3rem', color: devbarTokens.mutedText },
})

/** Hosts supply every panel, the strip, and segments; selection is fully controlled. */
export const Devbar = ({
  panels,
  strip,
  stripMinWidth = 160,
  segments,
  openPanel,
  onOpenPanelChange,
  placement = 'viewport',
  style,
}: DevbarProps): React.ReactNode => {
  const panelId = React.useId()
  const toggleRef = React.useRef<HTMLButtonElement>(null)
  /** Ephemeral toggle bookkeeping only; never selection state or persistence. */
  const lastPanel = React.useRef<string | undefined>(undefined)
  const restoreFocus = React.useRef(false)
  const escapeFocus = React.useRef<Element | undefined>(undefined)

  const selected = panels.find((panel) => panel.id === openPanel)
  const selectedId = selected?.id

  React.useEffect(() => {
    if (selectedId !== undefined) lastPanel.current = selectedId
  }, [selectedId])

  React.useLayoutEffect(() => {
    if (selectedId === undefined && restoreFocus.current === true) {
      restoreFocus.current = false
      toggleRef.current?.focus()
    }
  }, [selectedId])

  // Capture focus before React removes a panel, including host-controlled closes.
  const attachPanel = React.useCallback((panel: HTMLElement | null) => {
    if (panel === null) return
    return () => {
      const focused = document.activeElement
      restoreFocus.current =
        panel.contains(focused) === true ||
        (focused === escapeFocus.current && panel.parentElement?.contains(focused) === true)
      escapeFocus.current = undefined
    }
  }, [])

  const propose = ({
    next,
    restoreFrom,
  }: {
    next: string | undefined
    restoreFrom?: Element | undefined
  }) => {
    restoreFocus.current = false
    escapeFocus.current = restoreFrom
    onOpenPanelChange(next)
  }

  const proposeToggle = () => {
    if (selected !== undefined) {
      propose({ next: undefined })
      return
    }
    const next = panels.find((panel) => panel.id === lastPanel.current)?.id ?? panels[0]?.id
    if (next !== undefined) propose({ next })
  }

  const latest = React.useRef(proposeToggle)
  React.useLayoutEffect(() => {
    latest.current = proposeToggle
  })

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented === true) return
      if (
        event.code === 'Backquote' &&
        (event.ctrlKey === true || event.metaKey === true) &&
        event.altKey === false &&
        event.shiftKey === false
      ) {
        event.preventDefault()
        latest.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const isOpen = selected !== undefined
  return (
    <aside
      aria-label="Developer tools"
      {...stylex.props(styles.root, placement === 'container' && styles.contained, style)}
      onKeyDown={(event) => {
        if (
          event.key === 'Escape' &&
          event.defaultPrevented === false &&
          event.target instanceof Node &&
          event.currentTarget.contains(event.target) === true &&
          selected !== undefined
        ) {
          event.preventDefault()
          propose({ next: undefined, restoreFrom: document.activeElement ?? undefined })
        }
      }}
    >
      {selected !== undefined && (
        <section
          ref={attachPanel}
          id={panelId}
          aria-label={selected.label}
          {...stylex.props(styles.panel)}
        >
          <header {...stylex.props(styles.panelHeader)}>
            <h2 {...stylex.props(styles.panelTitle)}>{selected.label}</h2>
            <button
              type="button"
              aria-label={`Close ${selected.label} panel`}
              aria-controls={panelId}
              onClick={() => propose({ next: undefined })}
              {...stylex.props(styles.button)}
            >
              Close
            </button>
          </header>
          <div {...stylex.props(styles.panelBody)}>{selected.render()}</div>
        </section>
      )}
      <div role="group" aria-label="Developer bar" {...stylex.props(styles.row)}>
        <div {...stylex.props(styles.controls)}>
          <button
            ref={toggleRef}
            type="button"
            aria-label="Toggle developer tools"
            aria-keyshortcuts="Control+Backquote Meta+Backquote"
            aria-expanded={isOpen}
            aria-controls={isOpen === true ? panelId : undefined}
            disabled={isOpen === false && panels.length === 0}
            onClick={proposeToggle}
            {...stylex.props(styles.button)}
          >
            Dev tools
          </button>
          {panels.map((panel) => {
            const isSelected = panel.id === selectedId
            return (
              <button
                key={panel.id}
                type="button"
                aria-expanded={isSelected}
                aria-controls={isSelected === true ? panelId : undefined}
                onClick={() => propose({ next: isSelected === true ? undefined : panel.id })}
                {...stylex.props(styles.button, isSelected === true && styles.active)}
              >
                {panel.label}
                {panel.badge !== undefined && (
                  <span {...stylex.props(styles.badge)}>{panel.badge}</span>
                )}
              </button>
            )
          })}
        </div>
        <div {...stylex.props(styles.strip, styles.stripWidth(stripMinWidth))}>
          <div {...stylex.props(styles.stripContent)}>{strip}</div>
        </div>
        {segments !== undefined && segments.length > 0 && (
          <SegmentGroup segments={segments} stripMinWidth={stripMinWidth} />
        )}
      </div>
    </aside>
  )
}

interface SegmentMeasurements {
  readonly segments: readonly SegmentWidth[]
  readonly available: number
  readonly overflowWidth: number
  readonly gap: number
}

/** Natural-size nodes stay mounted, but hidden nodes leave flow and the accessibility tree. */
const SegmentGroup = ({
  segments,
  stripMinWidth,
}: {
  readonly segments: readonly DevbarSegment[]
  readonly stripMinWidth: number
}): React.ReactNode => {
  const groupRef = React.useRef<HTMLDivElement>(null)
  const overflowMeasureRef = React.useRef<HTMLSpanElement>(null)
  const [measurements, setMeasurements] = React.useState<SegmentMeasurements | undefined>(undefined)

  React.useLayoutEffect(() => {
    const group = groupRef.current
    const overflow = overflowMeasureRef.current
    if (group === null || overflow === null) return
    const row = group.parentElement
    const controls = row?.firstElementChild
    if (row === null || controls === undefined || controls === null) return
    const nodes = Array.from(
      group.querySelectorAll<HTMLElement>(
        ':scope > [data-devbar-segment] > [data-devbar-segment-content]',
      ),
    )
    const measure = () => {
      const rowStyle = getComputedStyle(row)
      const padding =
        (Number.parseFloat(rowStyle.paddingLeft) || 0) +
        (Number.parseFloat(rowStyle.paddingRight) || 0)
      const rowGap = Number.parseFloat(rowStyle.columnGap) || 0
      // Budget from fixed neighbours, never from the current visible set.
      const available = Math.max(
        0,
        row.clientWidth -
          padding -
          controls.getBoundingClientRect().width -
          stripMinWidth -
          rowGap * 2,
      )
      const next: SegmentMeasurements = {
        segments: nodes.map((node, index) => ({
          id: segments[index]!.id,
          // Conservative CSS-pixel rounding makes boundary decisions deterministic.
          width: Math.ceil(node.getBoundingClientRect().width),
        })),
        available: Math.floor(available),
        overflowWidth: Math.ceil(overflow.getBoundingClientRect().width),
        gap: Number.parseFloat(getComputedStyle(group).columnGap) || 0,
      }
      setMeasurements((previous) =>
        previous !== undefined &&
        previous.available === next.available &&
        previous.overflowWidth === next.overflowWidth &&
        previous.gap === next.gap &&
        previous.segments.length === next.segments.length &&
        previous.segments.every(
          (segment, index) =>
            segment.id === next.segments[index]!.id &&
            segment.width === next.segments[index]!.width,
        ) === true
          ? previous
          : next,
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(group)
    observer.observe(row)
    observer.observe(controls)
    observer.observe(overflow)
    for (const node of nodes) observer.observe(node)
    return () => observer.disconnect()
  }, [segments, stripMinWidth])

  const widths = segments.map((segment) => ({
    id: segment.id,
    priority: segment.priority,
    width: measurements?.segments.find((measured) => measured.id === segment.id)?.width ?? 0,
  }))
  const visible =
    measurements === undefined ? [] : fitSegments({ ...measurements, segments: widths })
  const hidden = segments.filter((segment) => visible.includes(segment.id) === false)
  const {
    triggerRef,
    popoverRef,
    id: popoverId,
    expanded,
    position,
    toggle,
    onToggle,
    onKeyDown,
  } = useAnchoredPopover({ enabled: hidden.length > 0 })
  const natural =
    widths.reduce((total, segment) => total + segment.width, 0) +
    Math.max(0, segments.length - 1) * (measurements?.gap ?? 0)

  // The browser's top layer escapes the row scrollport and preserves inherited host tokens.
  // Native auto-popovers provide pointer light dismissal; Escape restores trigger focus.
  return (
    <div
      ref={groupRef}
      aria-label="Status items"
      {...stylex.props(
        styles.segments,
        styles.segmentWidth(natural, hidden.length > 0 ? (measurements?.overflowWidth ?? 0) : 0),
      )}
    >
      {segments.map((segment) => {
        const isHidden = visible.includes(segment.id) === false
        return (
          <div
            key={segment.id}
            data-devbar-segment={segment.id}
            aria-hidden={isHidden === true ? true : undefined}
            inert={isHidden}
            {...stylex.props(styles.segment, isHidden === true && styles.measuring)}
          >
            <div data-devbar-segment-content {...stylex.props(styles.segment)}>
              {segment.render()}
            </div>
          </div>
        )
      })}
      <div aria-hidden="true" inert {...stylex.props(styles.measuring)}>
        <span
          ref={overflowMeasureRef}
          {...stylex.props(styles.button, styles.overflow, styles.segment)}
        >
          +{segments.length}
          {segments.some((segment) => segment.hasAlert === true) === true && <UnseenDot />}
        </span>
      </div>
      {hidden.length > 0 && measurements !== undefined && (
        <button
          ref={triggerRef}
          type="button"
          aria-label={`${hidden.length} more status items: ${hidden.map((segment) => segment.label ?? segment.id).join(', ')}${hidden.some((segment) => segment.hasAlert === true) === true ? ', including unseen changes' : ''}`}
          aria-expanded={expanded}
          aria-controls={popoverId}
          aria-haspopup="dialog"
          onClick={toggle}
          onKeyDown={onKeyDown}
          {...stylex.props(styles.button, styles.overflow)}
        >
          +{hidden.length}
          {hidden.some((segment) => segment.hasAlert === true) === true && <UnseenDot />}
        </button>
      )}
      <div
        ref={popoverRef}
        id={popoverId}
        popover="auto"
        role="dialog"
        aria-label="More status items"
        tabIndex={-1}
        onToggle={onToggle}
        onKeyDown={onKeyDown}
        {...stylex.props(
          anchoredPopoverStyles.surface,
          anchoredPopoverStyles.position(
            position.top,
            position.bottom,
            position.left,
            position.maxHeight,
          ),
        )}
      >
        {expanded === true &&
          hidden.map((segment) => (
            <div
              key={segment.id}
              data-devbar-overflow-segment={segment.id}
              {...stylex.props(styles.popoverItem)}
            >
              {segment.render()}
            </div>
          ))}
      </div>
    </div>
  )
}
