import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles, StyleXStylesWithout } from '@stylexjs/stylex'
import * as React from 'react'

import { observeFps } from './fps-meter.ts'
import { devbarTokens } from './tokens.stylex.ts'

/** A host-provided tool panel rendered inside the developer bar. */
export interface DevbarPanel {
  readonly id: string
  readonly label: string
  readonly render: () => React.ReactNode
  readonly badge?: React.ReactNode
}

/** Configuration for the host-owned developer bar. */
export interface DevbarProps {
  readonly panels: readonly DevbarPanel[]
  /** A host-owned deep link can open a panel without turning it into a page/tab. */
  readonly deepLinkPanel?: string | undefined
  readonly storageKey?: string
  readonly persist?: boolean
  /** Embed in a positioned preview or inspector instead of docking to the viewport. */
  readonly placement?: 'viewport' | 'container'
  /** Position is owned by placement; hosts can style all other root properties. */
  readonly style?: StyleXStylesWithout<{ position: 'fixed' }>
}

const styles = stylex.create({
  dock: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 200,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: devbarTokens.canvas,
    color: devbarTokens.text,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: devbarTokens.border,
    fontFamily: devbarTokens.fontUi,
    fontSize: '0.75rem',
  },
  contained: { position: 'absolute' },
  bar: {
    display: 'flex',
    alignItems: 'center',
    minHeight: '2rem',
    gap: '0.25rem',
    paddingInline: '0.5rem',
  },
  toggle: {
    paddingBlock: '0.3rem',
    paddingInline: '0.5rem',
    backgroundColor: { default: 'transparent', ':hover': devbarTokens.panel },
    color: devbarTokens.text,
    borderWidth: 0,
    cursor: 'pointer',
    outlineWidth: { default: 0, ':focus-visible': 2 },
    outlineStyle: 'solid',
    outlineColor: devbarTokens.focusRing,
    outlineOffset: '-2px',
  },
  active: { backgroundColor: devbarTokens.panelActive, color: devbarTokens.text },
  badge: { marginLeft: '0.3rem', color: devbarTokens.mutedText },
  hint: { marginLeft: 'auto', color: devbarTokens.mutedText, whiteSpace: 'nowrap' },
  panel: {
    height: 'min(48vh, 32rem)',
    minHeight: '12rem',
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: devbarTokens.canvas,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: devbarTokens.border,
  },
  panelBody: {
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 'auto',
    display: 'flex',
    flexDirection: 'column',
  },
  fps: {
    padding: '1rem',
    fontFamily: devbarTokens.fontData,
    fontSize: '1.25rem',
    fontVariantNumeric: 'tabular-nums',
  },
})

/** Optional StyleX override for the sampled frame-rate output. */
export interface FpsMeterProps {
  readonly style?: StyleXStyles
}

/** Only mounted while the FPS panel is open; observation also pauses on page hide. */
export const FpsMeter = ({ style }: FpsMeterProps): React.ReactNode => {
  const sample = React.useRef<number | undefined>(undefined)
  const subscribe = React.useCallback(
    (notify: () => void) =>
      observeFps({
        clock: {
          requestFrame: (callback) => window.requestAnimationFrame(callback),
          cancelFrame: (id) => window.cancelAnimationFrame(id),
          visibility: document,
        },
        onSample: (fps) => {
          sample.current = fps
          notify()
        },
      }),
    [],
  )
  const fps = React.useSyncExternalStore(
    subscribe,
    () => sample.current,
    () => undefined,
  )
  return (
    <output aria-label="Frames per second" {...stylex.props(styles.fps, style)}>
      {fps ?? '—'} FPS
    </output>
  )
}

const defaultStorageKey = '@overeng/devbar:open-panel'

/** Hosts supply panels; this primitive does not know about their tools. */
export const Devbar = ({
  panels,
  deepLinkPanel,
  storageKey = defaultStorageKey,
  persist = true,
  placement = 'viewport',
  style,
}: DevbarProps): React.ReactNode => {
  const panelId = React.useId()
  const validPanel = React.useCallback(
    (id: string | undefined) => (panels.some((panel) => panel.id === id) === true ? id : undefined),
    [panels],
  )
  const [openPanel, setOpenPanel] = React.useState<string | undefined>(() => {
    const deepLink = validPanel(deepLinkPanel)
    if (deepLink !== undefined) return deepLink
    if (persist === false || typeof window === 'undefined') return undefined
    try {
      return validPanel(window.localStorage.getItem(storageKey) ?? undefined)
    } catch {
      return undefined
    }
  })
  const lastPanel = React.useRef(openPanel ?? panels[0]?.id)
  const select = React.useCallback(
    (next: string | undefined) => {
      if (next !== undefined) lastPanel.current = next
      setOpenPanel(next)
      if (persist === true) {
        try {
          window.localStorage.setItem(storageKey, next ?? '')
        } catch {
          /* Storage may be unavailable in an embedded or private browser. */
        }
      }
    },
    [persist, storageKey],
  )

  const requestedPanel = validPanel(deepLinkPanel)
  React.useEffect(() => {
    if (requestedPanel !== undefined) select(requestedPanel)
  }, [requestedPanel, select])

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.code === 'Backquote' &&
        (event.ctrlKey === true || event.metaKey === true) &&
        event.altKey === false &&
        event.shiftKey === false
      ) {
        event.preventDefault()
        select(
          openPanel === undefined ? (validPanel(lastPanel.current) ?? panels[0]?.id) : undefined,
        )
      } else if (
        event.key === 'Escape' &&
        openPanel !== undefined &&
        event.defaultPrevented === false
      ) {
        select(undefined)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openPanel, panels, select, validPanel])

  const selected = panels.find((panel) => panel.id === openPanel)
  const togglePanel = validPanel(lastPanel.current) ?? panels[0]?.id
  return (
    <aside
      aria-label="Developer tools"
      {...stylex.props(styles.dock, placement === 'container' && styles.contained, style)}
    >
      {selected !== undefined && (
        <section id={panelId} aria-label={selected.label} {...stylex.props(styles.panel)}>
          <div {...stylex.props(styles.panelBody)}>{selected.render()}</div>
        </section>
      )}
      <div {...stylex.props(styles.bar)}>
        <button
          type="button"
          aria-label="Toggle developer tools (Ctrl+Backquote)"
          aria-expanded={selected !== undefined}
          aria-controls={selected !== undefined ? panelId : undefined}
          onClick={() => select(selected === undefined ? togglePanel : undefined)}
          {...stylex.props(styles.toggle)}
        >
          Dev tools
        </button>
        {panels.map((panel) => (
          <button
            key={panel.id}
            type="button"
            aria-expanded={panel.id === openPanel}
            aria-controls={selected !== undefined ? panelId : undefined}
            onClick={() => select(panel.id === openPanel ? undefined : panel.id)}
            {...stylex.props(styles.toggle, panel.id === openPanel && styles.active)}
          >
            {panel.label}
            {panel.badge !== undefined && (
              <span {...stylex.props(styles.badge)}>{panel.badge}</span>
            )}
          </button>
        ))}
        <span aria-hidden="true" {...stylex.props(styles.hint)}>
          Ctrl+`
        </span>
      </div>
    </aside>
  )
}
