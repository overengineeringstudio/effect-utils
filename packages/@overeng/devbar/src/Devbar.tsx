import * as stylex from '@stylexjs/stylex'
import type { StyleXStylesWithout } from '@stylexjs/stylex'
import * as React from 'react'

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
  readonly render: () => React.ReactNode
}

/** Controlled composition of the developer shell; the host owns every slot and the selection. */
export interface DevbarProps {
  readonly panels: readonly DevbarPanel[]
  /** Host-owned renderer slot (for example a meter strip); absent means no strip work. */
  readonly strip?: React.ReactNode | undefined
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

/** How a proposal was initiated; only keyboard closes restore focus. */
type Activation = 'keyboard' | 'pointer'

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
    alignItems: 'center',
    flexShrink: 0,
    height: rowHeight,
    minHeight: rowHeight,
    maxHeight: rowHeight,
    boxSizing: 'border-box',
    gap: '0.5rem',
    paddingInline: '0.5rem',
    backgroundColor: devbarTokens.canvas,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: devbarTokens.border,
  },
  controls: { display: 'flex', alignItems: 'center', gap: '0.25rem', flexShrink: 0 },
  strip: {
    display: 'flex',
    alignItems: 'center',
    alignSelf: 'stretch',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    overflowX: 'auto',
    overflowY: 'hidden',
  },
  segments: { display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
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

const activationOf = (event: React.MouseEvent): Activation =>
  event.detail === 0 ? 'keyboard' : 'pointer'

/** Hosts supply every panel, the strip, and segments; selection is fully controlled. */
export const Devbar = ({
  panels,
  strip,
  segments,
  openPanel,
  onOpenPanelChange,
  placement = 'viewport',
  style,
}: DevbarProps): React.ReactNode => {
  const panelId = React.useId()
  const toggleRef = React.useRef<HTMLButtonElement>(null)
  const panelRef = React.useRef<HTMLElement>(null)
  /** Ephemeral toggle bookkeeping only; never selection state or persistence. */
  const lastPanel = React.useRef<string | undefined>(undefined)
  const initiator = React.useRef<HTMLElement | undefined>(undefined)
  const restoreFocus = React.useRef(false)

  const selected = panels.find((panel) => panel.id === openPanel)
  const selectedId = selected?.id

  React.useEffect(() => {
    if (selectedId !== undefined) lastPanel.current = selectedId
  }, [selectedId])

  React.useLayoutEffect(() => {
    if (restoreFocus.current === false) return
    restoreFocus.current = false
    if (selectedId !== undefined) return
    const target =
      initiator.current !== undefined && initiator.current.isConnected === true
        ? initiator.current
        : toggleRef.current
    target?.focus()
  }, [selectedId])

  const propose = ({
    next,
    activation,
    source,
  }: {
    next: string | undefined
    activation: Activation
    source: HTMLElement | undefined
  }) => {
    restoreFocus.current = false
    if (next === undefined) {
      const panel = panelRef.current
      restoreFocus.current =
        activation === 'keyboard' &&
        panel !== null &&
        panel.contains(document.activeElement) === true
    } else if (source !== undefined) {
      initiator.current = source
    }
    onOpenPanelChange(next)
  }

  const proposeToggle = ({
    activation,
    source,
  }: {
    activation: Activation
    source: HTMLElement | undefined
  }) => {
    if (selected !== undefined) {
      propose({ next: undefined, activation, source })
      return
    }
    const next = panels.find((panel) => panel.id === lastPanel.current)?.id ?? panels[0]?.id
    if (next !== undefined) propose({ next, activation, source })
  }

  const latest = React.useRef({ selected, proposeToggle, propose })
  React.useLayoutEffect(() => {
    latest.current = { selected, proposeToggle, propose }
  })

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented === true) return
      const current = latest.current
      if (
        event.code === 'Backquote' &&
        (event.ctrlKey === true || event.metaKey === true) &&
        event.altKey === false &&
        event.shiftKey === false
      ) {
        event.preventDefault()
        const focused = document.activeElement
        const panel = panelRef.current
        const source =
          focused instanceof HTMLElement &&
          focused !== document.body &&
          (panel === null || panel.contains(focused) === false)
            ? focused
            : (toggleRef.current ?? undefined)
        current.proposeToggle({ activation: 'keyboard', source })
      } else if (event.key === 'Escape' && current.selected !== undefined) {
        event.preventDefault()
        current.propose({ next: undefined, activation: 'keyboard', source: undefined })
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
    >
      {selected !== undefined && (
        <section
          ref={panelRef}
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
              onClick={(event) =>
                propose({ next: undefined, activation: activationOf(event), source: undefined })
              }
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
            onClick={(event) =>
              proposeToggle({ activation: activationOf(event), source: event.currentTarget })
            }
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
                onClick={(event) =>
                  propose({
                    next: isSelected === true ? undefined : panel.id,
                    activation: activationOf(event),
                    source: event.currentTarget,
                  })
                }
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
        <div {...stylex.props(styles.strip)}>{strip}</div>
        {segments !== undefined && segments.length > 0 && (
          <div {...stylex.props(styles.segments)}>
            {segments.map((segment) => (
              <React.Fragment key={segment.id}>{segment.render()}</React.Fragment>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}
