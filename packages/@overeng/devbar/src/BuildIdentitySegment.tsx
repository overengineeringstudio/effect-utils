import * as stylex from '@stylexjs/stylex'
import type { StyleXStyles } from '@stylexjs/stylex'
import * as React from 'react'

import {
  formatBuildIdentityDetails,
  formatBuildIdentityShort,
  type BuildIdentity,
} from '@overeng/utils/build-identity'

import { AnchoredDisclosure } from './disclosure.tsx'
import { devbarTokens } from './tokens.stylex.ts'

/** Optional build identity disclosure with a live or caller-supplied clock. */
export interface BuildIdentitySegmentProps {
  /** Pass virtual:build-identity's buildIdentity directly; hosts do no formatting. */
  readonly identity: BuildIdentity
  /** Optional fixed Unix seconds for deterministic rendering; otherwise ticks every minute. */
  readonly now?: number | undefined
  readonly style?: StyleXStyles
  readonly disclosure?: BuildIdentityDisclosure | undefined
}

/** Host-owned disclosure content and unseen state; rendering is lazy while open. */
export interface BuildIdentityDisclosure {
  readonly label: string
  readonly hasUnseen?: boolean | undefined
  readonly render: () => React.ReactNode
  readonly onOpenChange?: ((open: boolean) => void) | undefined
}

/** Optional segment component: import from @overeng/devbar/build-identity, not the shell entry. */
export const BuildIdentitySegment = (props: BuildIdentitySegmentProps): React.ReactNode =>
  props.now === undefined ? (
    <LiveIdentity {...props} />
  ) : (
    <IdentityView {...props} now={props.now} />
  )

// Shared by mounted segments, never scheduled merely by importing this optional entry.
let clockNow = Math.floor(Date.now() / 1000)
let clockTimer: number | undefined
const clockListeners = new Set<() => void>()
const clockSnapshot = (): number => clockNow
const subscribeClock = (notify: () => void): (() => void) => {
  clockListeners.add(notify)
  if (clockTimer === undefined) {
    clockNow = Math.floor(Date.now() / 1000)
    clockTimer = window.setInterval(() => {
      clockNow = Math.floor(Date.now() / 1000)
      for (const listener of clockListeners) listener()
    }, 60_000)
  }
  return () => {
    clockListeners.delete(notify)
    if (clockListeners.size === 0) {
      window.clearInterval(clockTimer)
      clockTimer = undefined
    }
  }
}

const styles = stylex.create({
  root: { display: 'inline-flex', alignItems: 'center', minWidth: 0 },
  trigger: {
    appearance: 'none',
    borderWidth: 0,
    backgroundColor: { default: 'transparent', ':hover': devbarTokens.panelActive },
    color: devbarTokens.mutedText,
    fontFamily: devbarTokens.fontData,
    fontSize: 'inherit',
    lineHeight: '1.5rem',
    paddingBlock: 0,
    paddingInline: '0.25rem',
    borderRadius: '0.25rem',
    whiteSpace: 'nowrap',
    cursor: 'help',
    outlineOffset: '2px',
    outlineWidth: { default: 0, ':focus-visible': 2 },
    outlineStyle: 'solid',
    outlineColor: devbarTokens.focusRing,
  },
  action: { cursor: 'pointer' },
  details: {
    // Fixed descendants escape the row's horizontal scrollport without losing its theme.
    position: 'fixed',
    zIndex: 201,
    maxWidth: 'min(36rem, calc(100vw - 1rem))',
    padding: '0.5rem',
    boxSizing: 'border-box',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: devbarTokens.border,
    borderRadius: '0.25rem',
    backgroundColor: devbarTokens.panel,
    color: devbarTokens.text,
    fontFamily: devbarTokens.fontData,
    fontSize: '0.75rem',
    lineHeight: 1.5,
    overflowWrap: 'anywhere',
    whiteSpace: 'normal',
  },
  position: (bottom: number, right: number) => ({ bottom, right }),
  line: { display: 'block' },
  label: { color: devbarTokens.mutedText },
})

const IdentityView = ({
  identity,
  now,
  style,
  disclosure,
}: BuildIdentitySegmentProps & { readonly now: number }): React.ReactNode => {
  const tooltipId = React.useId()
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const [hovered, setHovered] = React.useState(false)
  const [focused, setFocused] = React.useState(false)
  const [dismissed, setDismissed] = React.useState(false)
  const [disclosureOpen, setDisclosureOpen] = React.useState(false)
  const [position, setPosition] = React.useState({ bottom: 0, right: 8 })
  const show = (): void => setDismissed(false)
  const visible =
    (hovered === true || focused === true) && dismissed === false && disclosureOpen === false
  React.useLayoutEffect(() => {
    if (visible === false) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect !== undefined) {
      setPosition({
        bottom: window.innerHeight - rect.top,
        right: Math.max(8, window.innerWidth - rect.right),
      })
    }
  }, [visible])
  React.useLayoutEffect(() => {
    if (visible === false) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented === true) return
      event.preventDefault()
      // Dismiss hover-only disclosures before Escape reaches the shell's window listener.
      event.stopPropagation()
      setDismissed(true)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [visible])
  const short = formatBuildIdentityShort({ identity, now })
  return (
    <span
      {...stylex.props(styles.root, style)}
      onMouseEnter={() => {
        setHovered(true)
        show()
      }}
      onMouseLeave={() => setHovered(false)}
    >
      {disclosure === undefined ? (
        <button
          ref={triggerRef}
          type="button"
          aria-label={`Build identity: ${short}`}
          aria-describedby={visible === true ? tooltipId : undefined}
          onFocus={() => {
            setFocused(true)
            show()
          }}
          onBlur={() => setFocused(false)}
          {...stylex.props(styles.trigger)}
        >
          {short}
        </button>
      ) : (
        <AnchoredDisclosure
          label={disclosure.label}
          trigger={short}
          triggerLabel={`Build identity: ${short}, show ${disclosure.label}${disclosure.hasUnseen === true ? ', unseen changes' : ''}`}
          hasUnseen={disclosure.hasUnseen}
          style={[styles.trigger, styles.action]}
          triggerRef={triggerRef}
          triggerProps={{
            'aria-describedby': visible === true ? tooltipId : undefined,
            onFocus: () => {
              setFocused(true)
              show()
            },
            onBlur: () => setFocused(false),
          }}
          onOpenChange={(open) => {
            setDisclosureOpen(open)
            setDismissed(true)
            disclosure.onOpenChange?.(open)
          }}
        >
          <DisclosureContent render={disclosure.render} />
        </AnchoredDisclosure>
      )}
      {visible === true && (
        <span
          id={tooltipId}
          role="tooltip"
          data-devbar-identity-tooltip
          {...stylex.props(styles.details, styles.position(position.bottom, position.right))}
        >
          {formatBuildIdentityDetails({ identity, now }).map((line) => (
            <span key={line.label} {...stylex.props(styles.line)}>
              <span {...stylex.props(styles.label)}>{line.label} </span>
              {line.value}
            </span>
          ))}
        </span>
      )}
    </span>
  )
}

const LiveIdentity = (props: Omit<BuildIdentitySegmentProps, 'now'>): React.ReactNode => {
  const now = React.useSyncExternalStore(subscribeClock, clockSnapshot, clockSnapshot)
  return <IdentityView {...props} now={now} />
}

const DisclosureContent = ({
  render,
}: {
  readonly render: () => React.ReactNode
}): React.ReactNode => render()
