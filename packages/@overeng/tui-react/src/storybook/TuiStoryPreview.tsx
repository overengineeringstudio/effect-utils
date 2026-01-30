/**
 * TuiStoryPreview - Unified Storybook wrapper for TUI components
 *
 * Supports two modes:
 *
 * 1. **Simple mode** - Just wrap children in a terminal preview:
 *    ```tsx
 *    <TuiStoryPreview>
 *      <Box><Text>Hello</Text></Box>
 *    </TuiStoryPreview>
 *    ```
 *
 * 2. **Stateful mode** - Full state management with timeline playback:
 *    ```tsx
 *    <TuiStoryPreview
 *      View={MyView}
 *      stateSchema={MyState}
 *      actionSchema={MyAction}
 *      reducer={myReducer}
 *      initialState={initialState}
 *      timeline={events}
 *    />
 *    ```
 *
 * Features:
 * - Tabs for Visual/Fullscreen/String/JSON/NDJSON output modes
 * - Timeline playback with play/pause/scrub (stateful mode)
 * - Viewport size controls
 */

import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { Schema } from 'effect'
import '@xterm/xterm/css/xterm.css'
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'

import { renderToString } from '../renderToString.ts'
import { createRoot, type Root } from '../root.ts'
import { xtermTheme, containerStyles } from './theme.ts'

// =============================================================================
// Types
// =============================================================================

export type OutputTab = 'visual' | 'fullscreen' | 'string' | 'json' | 'ndjson'

export interface TimelineEvent<A> {
  /** Time offset in milliseconds from start */
  at: number
  /** Action to dispatch */
  action: A
}

/** Props for simple mode - just render children */
interface SimpleProps {
  /** React children to render in the terminal */
  children: React.ReactNode
  /** Terminal height in pixels */
  height?: number
  /** Which tabs to show (defaults to ['visual'] in simple mode) */
  tabs?: OutputTab[]
  /** Initial active tab */
  defaultTab?: OutputTab
}

/** Props for stateful mode - full state management */
interface StatefulProps<S, A> {
  /** The view component to render */
  View: React.ComponentType<{ state: S }>
  /** State schema for JSON encoding */
  stateSchema: Schema.Schema<S>
  /** Action schema for button generation */
  actionSchema: Schema.Schema<A>
  /** Reducer function */
  reducer: (params: { state: S; action: A }) => S
  /** Initial state */
  initialState: S
  /** Timeline of actions for auto-playback */
  timeline?: TimelineEvent<A>[]
  /** Terminal height in pixels */
  height?: number
  /** Whether to auto-run timeline on mount */
  autoRun?: boolean
  /** Playback speed multiplier */
  playbackSpeed?: number
  /** Which tabs to show (defaults to all) */
  tabs?: OutputTab[]
  /** Initial active tab */
  defaultTab?: OutputTab
}

export type TuiStoryPreviewProps<S, A> = SimpleProps | StatefulProps<S, A>

/** Type guard to check if props are for stateful mode */
const isStatefulProps = <S, A>(
  props: TuiStoryPreviewProps<S, A>,
): props is StatefulProps<S, A> => {
  return 'View' in props && props.View !== undefined
}

// =============================================================================
// Tab Button Component
// =============================================================================

const TabButton: React.FC<{
  active: boolean
  onClick: () => void
  children: React.ReactNode
  testId?: string
}> = ({ active, onClick, children, testId }) => (
  <button
    onClick={onClick}
    data-testid={testId}
    style={{
      padding: '8px 16px',
      border: 'none',
      borderBottom: active ? '2px solid #007acc' : '2px solid transparent',
      background: active ? '#1e1e1e' : '#2d2d2d',
      color: active ? '#fff' : '#888',
      cursor: 'pointer',
      fontSize: '13px',
      fontFamily: 'system-ui, sans-serif',
    }}
  >
    {children}
  </button>
)

// =============================================================================
// Playback Controls Component (Hybrid: Slider + Event Markers + Step Controls)
// =============================================================================

/** Format action tag for display */
const formatActionTag = (action: unknown): string => {
  if (action && typeof action === 'object' && '_tag' in action) {
    return String((action as { _tag: string })._tag)
  }
  return 'Action'
}

/** Get action details (nested _tag or key summary) */
const getActionDetails = (action: unknown): string | null => {
  if (!action || typeof action !== 'object') return null

  const obj = action as Record<string, unknown>

  // Look for nested state with _tag
  if ('state' in obj && obj.state && typeof obj.state === 'object') {
    const state = obj.state as Record<string, unknown>
    if ('_tag' in state) {
      // Get additional info from state
      const parts: string[] = [String(state._tag)]

      // Add counts for arrays
      for (const [key, value] of Object.entries(state)) {
        if (key !== '_tag' && Array.isArray(value)) {
          parts.push(`${key}: ${value.length}`)
        }
      }

      return parts.join(', ')
    }
  }

  // Summarize top-level keys (excluding _tag)
  const keys = Object.keys(obj).filter((k) => k !== '_tag')
  if (keys.length === 0) return null

  const summaryParts: string[] = []
  for (const key of keys.slice(0, 3)) {
    const value = obj[key]
    if (Array.isArray(value)) {
      summaryParts.push(`${key}: ${value.length} items`)
    } else if (typeof value === 'string') {
      summaryParts.push(`${key}: "${value.slice(0, 20)}${value.length > 20 ? '...' : ''}"`)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      summaryParts.push(`${key}: ${value}`)
    }
  }

  return summaryParts.length > 0 ? summaryParts.join(', ') : null
}

/** Small button style for step controls */
const smallButtonStyle: React.CSSProperties = {
  padding: '4px 8px',
  border: '1px solid #555',
  borderRadius: '4px',
  background: '#3d3d3d',
  color: '#fff',
  cursor: 'pointer',
  fontSize: '12px',
  minWidth: '32px',
}

/** Tooltip for event markers */
const EventTooltip: React.FC<{
  event: { at: number; action: unknown }
  index: number
  total: number
  prevEventAt: number | null
  position: { x: number; y: number }
}> = ({ event, index, total, prevEventAt, position }) => {
  const actionTag = formatActionTag(event.action)
  const actionDetails = getActionDetails(event.action)
  const deltaTime = prevEventAt !== null ? event.at - prevEventAt : null

  return (
    <div
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, -100%) translateY(-8px)',
        background: '#1e1e1e',
        border: '1px solid #4a9eff',
        borderRadius: '6px',
        padding: '8px 12px',
        zIndex: 1000,
        minWidth: '160px',
        maxWidth: '280px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        pointerEvents: 'none',
      }}
    >
      {/* Header: Event index */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '6px',
          paddingBottom: '6px',
          borderBottom: '1px solid #333',
        }}
      >
        <span style={{ color: '#888', fontSize: '11px' }}>
          Event {index + 1} of {total}
        </span>
        <span style={{ color: '#4a9eff', fontSize: '11px', fontFamily: 'Monaco, Menlo, monospace' }}>
          @ {(event.at / 1000).toFixed(1)}s
          {deltaTime !== null && (
            <span style={{ color: '#666' }}> (+{(deltaTime / 1000).toFixed(1)}s)</span>
          )}
        </span>
      </div>

      {/* Action tag */}
      <div
        style={{
          color: '#fff',
          fontSize: '12px',
          fontFamily: 'Monaco, Menlo, monospace',
          fontWeight: 'bold',
        }}
      >
        {actionTag}
      </div>

      {/* Action details */}
      {actionDetails && (
        <div
          style={{
            color: '#aaa',
            fontSize: '11px',
            fontFamily: 'Monaco, Menlo, monospace',
            marginTop: '4px',
            wordBreak: 'break-word',
          }}
        >
          → {actionDetails}
        </div>
      )}
    </div>
  )
}

const PlaybackControls = <A,>({
  isPlaying,
  currentTime,
  totalDuration,
  timeline,
  onPlay,
  onPause,
  onReset,
  onSeek,
}: {
  isPlaying: boolean
  currentTime: number
  totalDuration: number
  timeline: Array<{ at: number; action: A }>
  onPlay: () => void
  onPause: () => void
  onReset: () => void
  onSeek: (time: number) => void
}): React.ReactElement => {
  // Hover state for tooltip
  const [hoveredEvent, setHoveredEvent] = useState<{
    index: number
    position: { x: number; y: number }
  } | null>(null)

  // Calculate current event index (last event that has fired)
  const currentEventIndex = timeline.findIndex((e, i) => {
    const nextEvent = timeline[i + 1]
    return e.at <= currentTime && (!nextEvent || nextEvent.at > currentTime)
  })

  // Get current event info
  const currentEvent = currentEventIndex >= 0 ? timeline[currentEventIndex] : null
  const currentActionTag = currentEvent ? formatActionTag(currentEvent.action) : 'Ready'
  const currentActionDetails = currentEvent ? getActionDetails(currentEvent.action) : null

  // Step to previous event
  const handlePrev = () => {
    if (currentEventIndex <= 0) {
      onSeek(0)
    } else {
      const prevEvent = timeline[currentEventIndex - 1]
      if (prevEvent) onSeek(prevEvent.at)
    }
  }

  // Step to next event
  const handleNext = () => {
    const nextIndex = currentEventIndex + 1
    if (nextIndex < timeline.length) {
      const nextEvent = timeline[nextIndex]
      if (nextEvent) onSeek(nextEvent.at)
    }
  }

  const hasEvents = timeline.length > 0

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '8px 12px',
        background: '#2d2d2d',
        borderTop: '1px solid #3d3d3d',
      }}
    >
      {/* Row 1: Step controls + Event index + Time */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {/* Step controls */}
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            onClick={handlePrev}
            style={smallButtonStyle}
            disabled={currentEventIndex <= 0 && currentTime === 0}
            title="Previous event"
            aria-label="Previous event"
          >
            ◀
          </button>
          <button
            onClick={isPlaying ? onPause : onPlay}
            style={{ ...smallButtonStyle, minWidth: '40px' }}
            title={isPlaying ? 'Pause' : 'Play'}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button
            onClick={handleNext}
            style={smallButtonStyle}
            disabled={currentEventIndex >= timeline.length - 1}
            title="Next event"
            aria-label="Next event"
          >
            ▶
          </button>
          <button
            onClick={onReset}
            style={smallButtonStyle}
            title="Reset to beginning"
            aria-label="Reset"
          >
            ↺
          </button>
        </div>

        {/* Event index + timestamp */}
        {hasEvents && (
          <span style={{ color: '#888', fontSize: '11px' }}>
            Event {Math.max(0, currentEventIndex + 1)} of {timeline.length}
            {currentEvent && (
              <span style={{ color: '#666' }}> @ {(currentEvent.at / 1000).toFixed(1)}s</span>
            )}
          </span>
        )}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Time display */}
        <span style={{ color: '#888', fontSize: '12px', fontFamily: 'Monaco, Menlo, monospace' }}>
          {(currentTime / 1000).toFixed(1)}s / {(totalDuration / 1000).toFixed(1)}s
        </span>
      </div>

      {/* Row 2: Current action details */}
      {hasEvents && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '20px' }}>
          <span
            style={{
              color: '#4a9eff',
              fontSize: '12px',
              fontFamily: 'Monaco, Menlo, monospace',
              fontWeight: 'bold',
            }}
          >
            {currentActionTag}
          </span>
          {currentActionDetails && (
            <span
              style={{
                color: '#888',
                fontSize: '11px',
                fontFamily: 'Monaco, Menlo, monospace',
              }}
            >
              → {currentActionDetails}
            </span>
          )}
        </div>
      )}

      {/* Row 3: Timeline slider with event markers and labels */}
      <div style={{ position: 'relative', height: '44px', marginTop: '4px' }}>
        {/* Event markers with labels */}
        {timeline.map((event, i) => {
          const position = totalDuration > 0 ? (event.at / totalDuration) * 100 : 0
          const isFired = event.at <= currentTime
          const isCurrent = i === currentEventIndex
          const isHovered = hoveredEvent?.index === i

          // Calculate gap to next marker to decide if label fits
          const nextEvent = timeline[i + 1]
          const nextPosition = nextEvent && totalDuration > 0 ? (nextEvent.at / totalDuration) * 100 : 100
          const gapPercent = nextPosition - position
          const showLabel = gapPercent > 8 || i === timeline.length - 1 // Show if >8% gap or last event

          const actionTag = formatActionTag(event.action)

          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: `${position}%`,
                top: 0,
                transform: 'translateX(-50%)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                zIndex: 2,
              }}
            >
              {/* Marker dot */}
              <div
                onClick={() => onSeek(event.at)}
                onMouseEnter={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  setHoveredEvent({
                    index: i,
                    position: { x: rect.left + rect.width / 2, y: rect.top },
                  })
                }}
                onMouseLeave={() => setHoveredEvent(null)}
                style={{
                  width: isCurrent || isHovered ? '14px' : '10px',
                  height: isCurrent || isHovered ? '14px' : '10px',
                  borderRadius: '50%',
                  background: isCurrent ? '#4a9eff' : isFired ? '#666' : '#444',
                  border: isCurrent ? '2px solid #fff' : isHovered ? '2px solid #4a9eff' : '1px solid #555',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  marginTop: '5px',
                }}
              />

              {/* Label below marker */}
              {showLabel && (
                <span
                  onClick={() => onSeek(event.at)}
                  style={{
                    marginTop: '4px',
                    fontSize: '9px',
                    fontFamily: 'Monaco, Menlo, monospace',
                    color: isCurrent ? '#4a9eff' : isFired ? '#888' : '#555',
                    whiteSpace: 'nowrap',
                    cursor: 'pointer',
                    textAlign: 'center',
                  }}
                >
                  {actionTag}
                </span>
              )}
            </div>
          )
        })}

        {/* Tooltip */}
        {hoveredEvent && timeline[hoveredEvent.index] && (
          <EventTooltip
            event={timeline[hoveredEvent.index] as { at: number; action: unknown }}
            index={hoveredEvent.index}
            total={timeline.length}
            prevEventAt={hoveredEvent.index > 0 ? (timeline[hoveredEvent.index - 1]?.at ?? null) : null}
            position={hoveredEvent.position}
          />
        )}

        {/* Track background */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: '12px',
            transform: 'translateY(-50%)',
            height: '4px',
            background: '#444',
            borderRadius: '2px',
            zIndex: 0,
          }}
        />

        {/* Progress fill */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: '12px',
            transform: 'translateY(-50%)',
            width: totalDuration > 0 ? `${(currentTime / totalDuration) * 100}%` : '0%',
            height: '4px',
            background: '#4a9eff',
            borderRadius: '2px',
            zIndex: 1,
          }}
        />

        {/* Invisible range input for scrubbing (z-index below markers so hover works) */}
        <input
          type="range"
          min={0}
          max={totalDuration}
          value={currentTime}
          onChange={(e) => onSeek(Number(e.target.value))}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            width: '100%',
            height: '100%',
            opacity: 0,
            cursor: 'pointer',
            zIndex: 1,
          }}
        />
      </div>
    </div>
  )
}

// =============================================================================
// JSON Preview Component
// =============================================================================

const JsonPreviewPane: React.FC<{ json: string }> = ({ json }) => (
  <pre
    style={{
      margin: 0,
      padding: '12px',
      background: '#1e1e1e',
      color: '#d4d4d4',
      fontFamily: 'Monaco, Menlo, monospace',
      fontSize: '12px',
      overflow: 'auto',
      height: '100%',
    }}
  >
    {json}
  </pre>
)

// =============================================================================
// NDJSON Preview Component
// =============================================================================

const NdjsonPreviewPane: React.FC<{ lines: string[] }> = ({ lines }) => (
  <pre
    style={{
      margin: 0,
      padding: '12px',
      background: '#1e1e1e',
      color: '#d4d4d4',
      fontFamily: 'Monaco, Menlo, monospace',
      fontSize: '11px',
      overflow: 'auto',
      height: '100%',
    }}
  >
    {lines.map((line, i) => (
      <div
        key={i}
        style={{ borderBottom: '1px solid #333', paddingBottom: '4px', marginBottom: '4px' }}
      >
        {line}
      </div>
    ))}
  </pre>
)

// =============================================================================
// String Preview Component
// =============================================================================

const StringPreviewPane: React.FC<{
  View: React.ComponentType<{ state: unknown }>
  state: unknown
  height: number
}> = ({ View, state, height }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    if (!terminalRef.current) {
      const terminal = new Terminal({
        fontFamily: 'Monaco, Menlo, "DejaVu Sans Mono", Consolas, monospace',
        fontSize: 14,
        theme: xtermTheme,
        allowProposedApi: true,
        cursorBlink: false,
        cursorStyle: 'bar',
        disableStdin: true,
      })

      const fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)
      terminal.open(containerRef.current)
      fitAddon.fit()

      terminalRef.current = terminal
    }

    const terminal = terminalRef.current
    terminal.clear()
    terminal.reset()

    renderToString({ element: React.createElement(View, { state }) })
      .then((ansiOutput) => {
        const lines = ansiOutput.split('\n')
        lines.forEach((line, i) => {
          terminal.write(line)
          if (i < lines.length - 1) {
            terminal.write('\r\n')
          }
        })
      })
      .catch((err: Error) => {
        terminal.write(`Error: ${err.message}`)
      })

    return () => {}
  }, [state, View])

  useEffect(() => {
    return () => {
      terminalRef.current?.dispose()
      terminalRef.current = null
    }
  }, [])

  return <div ref={containerRef} style={{ ...containerStyles, height }} />
}

// =============================================================================
// Fullscreen Terminal Component
// =============================================================================

const FullscreenPreviewPane: React.FC<{
  View: React.ComponentType<{ state: unknown }>
  state: unknown
  height: number
}> = ({ View, state, height }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const rootRef = useRef<Root | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const [dimensions, setDimensions] = useState({ cols: 80, rows: 24 })
  const [lastKey, setLastKey] = useState<string | null>(null)

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return

    const terminal = new Terminal({
      fontFamily: 'Monaco, Menlo, "DejaVu Sans Mono", Consolas, monospace',
      fontSize: 14,
      theme: {
        ...xtermTheme,
        background: '#0a0a0f', // Slightly different background for fullscreen
      },
      allowProposedApi: true,
      cursorBlink: false,
      cursorStyle: 'block',
      disableStdin: true,
      scrollback: 0, // No scrollback - simulates alternate screen
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    fitAddon.fit()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const adapter = {
      write: (data: string) => terminal.write(data),
      get columns() {
        return terminal.cols
      },
      get rows() {
        return terminal.rows
      },
      isTTY: true as const,
    }
    rootRef.current = createRoot({ terminalOrStream: adapter })

    setDimensions({ cols: terminal.cols, rows: terminal.rows })
    setIsReady(true)

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      setDimensions({ cols: terminal.cols, rows: terminal.rows })
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      rootRef.current?.unmount()
      rootRef.current = null
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  // Render content (reuse existing root for differential updates)
  useEffect(() => {
    if (!isReady || !rootRef.current) return
    rootRef.current.render(React.createElement(View, { state }))
  }, [state, isReady, View])

  // Keyboard handling
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isFocused) return
      const parts: string[] = []
      if (e.ctrlKey) parts.push('Ctrl')
      if (e.altKey) parts.push('Alt')
      if (e.shiftKey) parts.push('Shift')
      parts.push(e.key === ' ' ? 'Space' : e.key)
      setLastKey(parts.join('+'))
      if (e.key !== 'F5' && e.key !== 'F12') {
        e.preventDefault()
      }
    },
    [isFocused],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const statusBarHeight = 28
  const terminalHeight = height - statusBarHeight

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height,
        backgroundColor: '#0a0a0f',
        overflow: 'hidden',
        border: isFocused ? '2px solid #4a9eff' : '2px solid #333',
        outline: 'none',
        boxSizing: 'border-box',
      }}
      tabIndex={0}
      onFocus={() => setIsFocused(true)}
      onBlur={() => setIsFocused(false)}
    >
      {/* Status Bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '4px 12px',
          backgroundColor: '#1a1a2e',
          borderBottom: '1px solid #333',
          fontSize: '12px',
          fontFamily: 'system-ui, sans-serif',
          color: '#888',
          height: statusBarHeight,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#4a9eff' }}
          >
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: '#4a9eff',
              }}
            />
            Fullscreen Mode (Simulated)
          </span>
          <span style={{ color: '#666' }}>
            {dimensions.cols}x{dimensions.rows}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {lastKey && (
            <span style={{ color: '#666' }}>
              Key: <code style={{ color: '#aaa' }}>{lastKey}</code>
            </span>
          )}
          <span style={{ color: isFocused ? '#4a9eff' : '#666' }}>
            {isFocused ? 'Focused' : 'Click to focus'}
          </span>
        </div>
      </div>

      {/* Terminal */}
      <div
        ref={containerRef}
        style={{ flex: 1, height: terminalHeight, padding: '8px', boxSizing: 'border-box' }}
      />
    </div>
  )
}

// =============================================================================
// Tab Labels
// =============================================================================

const TAB_LABELS: Record<OutputTab, string> = {
  visual: 'Visual',
  fullscreen: 'Fullscreen',
  string: 'String',
  json: 'JSON',
  ndjson: 'NDJSON',
}

const DEFAULT_TABS_STATEFUL: OutputTab[] = ['visual', 'fullscreen', 'string', 'json', 'ndjson']
const DEFAULT_TABS_SIMPLE: OutputTab[] = ['visual', 'fullscreen', 'string']

// =============================================================================
// Simple Mode Component (children-based)
// =============================================================================

const SimpleTuiStoryPreview: React.FC<SimpleProps> = ({
  children,
  height = 400,
  tabs = DEFAULT_TABS_SIMPLE,
  defaultTab = 'visual',
}) => {
  const [activeTab, setActiveTab] = useState<OutputTab>(defaultTab)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const rootRef = useRef<Root | null>(null)
  const [isTerminalReady, setIsTerminalReady] = useState(false)

  // Initialize terminal for visual tab
  useEffect(() => {
    if (activeTab !== 'visual' || !containerRef.current || terminalRef.current) return

    const terminal = new Terminal({
      fontFamily: 'Monaco, Menlo, "DejaVu Sans Mono", Consolas, monospace',
      fontSize: 14,
      theme: xtermTheme,
      allowProposedApi: true,
      cursorBlink: false,
      cursorStyle: 'bar',
      disableStdin: true,
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    fitAddon.fit()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const adapter = {
      write: (data: string) => terminal.write(data),
      get columns() {
        return terminal.cols
      },
      get rows() {
        return terminal.rows
      },
      isTTY: true as const,
    }
    rootRef.current = createRoot({ terminalOrStream: adapter })
    setIsTerminalReady(true)

    const resizeObserver = new ResizeObserver(() => fitAddon.fit())
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      rootRef.current?.unmount()
      rootRef.current = null
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      setIsTerminalReady(false)
    }
  }, [activeTab])

  // Render children to terminal (reuse existing root for differential updates)
  useEffect(() => {
    if (activeTab !== 'visual' || !isTerminalReady || !rootRef.current) return
    rootRef.current.render(children as React.ReactElement)
  }, [children, activeTab, isTerminalReady])

  // Wrapper component for string/fullscreen panes
  const ChildrenView: React.FC<{ state: unknown }> = () => <>{children}</>

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      {/* Tabs - only show if more than one */}
      {tabs.length > 1 && (
        <div
          style={{ display: 'flex', background: '#2d2d2d', borderBottom: '1px solid #3d3d3d' }}
          data-testid="tui-preview-tabs"
        >
          {tabs.map((tab) => (
            <TabButton
              key={tab}
              active={activeTab === tab}
              onClick={() => setActiveTab(tab)}
              testId={`tab-${tab}`}
            >
              {TAB_LABELS[tab]}
            </TabButton>
          ))}
        </div>
      )}

      {/* Content */}
      <div style={{ height, overflow: 'hidden' }}>
        {activeTab === 'visual' && (
          <div ref={containerRef} style={{ ...containerStyles, height: '100%' }} />
        )}
        {activeTab === 'fullscreen' && (
          <FullscreenPreviewPane View={ChildrenView} state={null} height={height} />
        )}
        {activeTab === 'string' && (
          <StringPreviewPane View={ChildrenView} state={null} height={height} />
        )}
        {activeTab === 'json' && <JsonPreviewPane json="// Simple mode - no state schema" />}
        {activeTab === 'ndjson' && <NdjsonPreviewPane lines={['// Simple mode - no state tracking']} />}
      </div>
    </div>
  )
}

// =============================================================================
// Stateful Mode Component (View + state management)
// =============================================================================

const StatefulTuiStoryPreview = <S, A>({
  View,
  stateSchema,
  reducer,
  initialState,
  timeline = [],
  height = 400,
  autoRun = true,
  playbackSpeed = 1,
  tabs = DEFAULT_TABS_STATEFUL,
  defaultTab = 'visual',
}: StatefulProps<S, A>): React.ReactElement => {
  // State
  const [activeTab, setActiveTab] = useState<OutputTab>(defaultTab)
  const [state, setState] = useState<S>(initialState)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [ndjsonLines, setNdjsonLines] = useState<string[]>([])

  // Refs for visual terminal only
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const rootRef = useRef<Root | null>(null)
  const [isTerminalReady, setIsTerminalReady] = useState(false)

  // Calculate total duration from timeline
  const totalDuration = useMemo(() => {
    if (timeline.length === 0) return 0
    return Math.max(...timeline.map((e) => e.at)) + 1000 // Add 1s buffer
  }, [timeline])

  // Dispatch action and update state
  const dispatch = useCallback(
    (action: A) => {
      setState((prev) => {
        const next = reducer({ state: prev, action })
        // Add to NDJSON log
        try {
          const encoded = Schema.encodeSync(stateSchema)(next)
          setNdjsonLines((lines) => [...lines, JSON.stringify(encoded)])
        } catch {
          // Ignore encoding errors
        }
        return next
      })
    },
    [reducer, stateSchema],
  )

  // Reset to initial state
  const reset = useCallback(() => {
    setState(initialState)
    setCurrentTime(0)
    setIsPlaying(false)
    setNdjsonLines([])
  }, [initialState])

  // Timeline playback effect
  useEffect(() => {
    if (!isPlaying || timeline.length === 0) return

    const startTime = Date.now() - currentTime / playbackSpeed
    let animationFrame: number

    const tick = () => {
      const elapsed = (Date.now() - startTime) * playbackSpeed
      setCurrentTime(elapsed)

      // Find and dispatch any actions that should have fired
      timeline.forEach((event) => {
        if (event.at <= elapsed && event.at > currentTime) {
          dispatch(event.action)
        }
      })

      if (elapsed < totalDuration) {
        animationFrame = requestAnimationFrame(tick)
      } else {
        setIsPlaying(false)
      }
    }

    animationFrame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animationFrame)
  }, [isPlaying, timeline, totalDuration, playbackSpeed, dispatch, currentTime])

  // Auto-run on mount
  useEffect(() => {
    if (autoRun && timeline.length > 0) {
      setIsPlaying(true)
    }
  }, [autoRun, timeline.length])

  // Initialize terminal for visual tab
  useEffect(() => {
    if (activeTab !== 'visual' || !containerRef.current || terminalRef.current) return

    const terminal = new Terminal({
      fontFamily: 'Monaco, Menlo, "DejaVu Sans Mono", Consolas, monospace',
      fontSize: 14,
      theme: xtermTheme,
      allowProposedApi: true,
      cursorBlink: false,
      cursorStyle: 'bar',
      disableStdin: true,
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    fitAddon.fit()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const adapter = {
      write: (data: string) => terminal.write(data),
      get columns() {
        return terminal.cols
      },
      get rows() {
        return terminal.rows
      },
      isTTY: true as const,
    }
    rootRef.current = createRoot({ terminalOrStream: adapter })
    setIsTerminalReady(true)

    const resizeObserver = new ResizeObserver(() => fitAddon.fit())
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      rootRef.current?.unmount()
      rootRef.current = null
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      setIsTerminalReady(false)
    }
  }, [activeTab])

  // Render view to terminal when state changes (reuse existing root for differential updates)
  useEffect(() => {
    if (activeTab !== 'visual' || !isTerminalReady || !rootRef.current) return
    rootRef.current.render(<View state={state} />)
  }, [state, activeTab, isTerminalReady, View])

  // Encode current state as JSON
  const jsonOutput = useMemo(() => {
    try {
      const encoded = Schema.encodeSync(stateSchema)(state)
      return JSON.stringify(encoded, null, 2)
    } catch {
      return '// Error encoding state'
    }
  }, [state, stateSchema])

  // Cast View for non-generic components
  const ViewCast = View as React.ComponentType<{ state: unknown }>

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      {/* Tabs */}
      <div
        style={{ display: 'flex', background: '#2d2d2d', borderBottom: '1px solid #3d3d3d' }}
        data-testid="tui-preview-tabs"
      >
        {tabs.map((tab) => (
          <TabButton
            key={tab}
            active={activeTab === tab}
            onClick={() => setActiveTab(tab)}
            testId={`tab-${tab}`}
          >
            {TAB_LABELS[tab]}
          </TabButton>
        ))}
      </div>

      {/* Content */}
      <div style={{ height, overflow: 'hidden' }}>
        {activeTab === 'visual' && (
          <div ref={containerRef} style={{ ...containerStyles, height: '100%' }} />
        )}
        {activeTab === 'fullscreen' && (
          <FullscreenPreviewPane View={ViewCast} state={state} height={height} />
        )}
        {activeTab === 'string' && (
          <StringPreviewPane View={ViewCast} state={state} height={height} />
        )}
        {activeTab === 'json' && <JsonPreviewPane json={jsonOutput} />}
        {activeTab === 'ndjson' && <NdjsonPreviewPane lines={ndjsonLines} />}
      </div>

      {/* Playback Controls */}
      {timeline.length > 0 && (
        <PlaybackControls
          isPlaying={isPlaying}
          currentTime={currentTime}
          totalDuration={totalDuration}
          timeline={timeline}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onReset={reset}
          onSeek={(time) => {
            // Seek to time - replay actions up to that point
            reset()
            timeline.filter((e) => e.at <= time).forEach((e) => dispatch(e.action))
            setCurrentTime(time)
          }}
        />
      )}
    </div>
  )
}

// =============================================================================
// Main Component (dispatches to Simple or Stateful)
// =============================================================================

export const TuiStoryPreview = <S, A>(
  props: TuiStoryPreviewProps<S, A>,
): React.ReactElement => {
  if (isStatefulProps(props)) {
    return <StatefulTuiStoryPreview {...props} />
  }
  return <SimpleTuiStoryPreview {...props} />
}
