/**
 * TuiStoryPreview - Storybook wrapper for TUI components
 *
 * Takes a TuiApp and a View component. Provides multi-tab output preview
 * with timeline playback, viewport controls, and state inspection.
 *
 * ```tsx
 * const MyApp = createTuiApp({ stateSchema, actionSchema, initial, reducer })
 *
 * <TuiStoryPreview
 *   app={MyApp}
 *   View={MyView}
 *   initialState={customState} // optional, defaults to app.config.initial
 *   timeline={events}
 * />
 * ```
 *
 * For static/stateless component demos, use `createStaticApp()`:
 *
 * ```tsx
 * const StaticApp = createStaticApp()
 * <TuiStoryPreview app={StaticApp} View={() => <MyComponent />} initialState={null} />
 * ```
 *
 * Output mode tabs align with CLI `--output` flag values:
 * - `tty` - Interactive terminal (live, animated, colored)
 * - `alt-screen` - Fullscreen TUI simulation
 * - `ci` - CI output with colors
 * - `ci-plain` - CI output without colors
 * - `pipe` - Final output with colors (for piping)
 * - `log` - Final output without colors (for log files)
 * - `json` - Final JSON output
 * - `ndjson` - Streaming NDJSON
 */

import { Atom, Registry } from '@effect-atom/atom'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { Schema } from 'effect'
// oxlint-disable-next-line eslint-plugin-import(no-unassigned-import) -- CSS side-effect import
import '@xterm/xterm/css/xterm.css'
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'

import {
  RenderConfigProvider,
  ciRenderConfig,
  ciPlainRenderConfig,
  pipeRenderConfig,
  logRenderConfig,
  stripAnsi,
} from '../effect/OutputMode.tsx'
import { TuiRegistryContext } from '../effect/TuiApp.tsx'
import { renderToString } from '../renderToString.ts'
import { createRoot, type Root } from '../root.tsx'
import { xtermTheme, containerStyles, previewTextStyles, previewPadding } from './theme.ts'

// =============================================================================
// Types
// =============================================================================

/** Identifier for a preview output mode tab (tty, ci, json, etc.). */
export type OutputTab =
  | 'tty'
  | 'alt-screen'
  | 'ci'
  | 'ci-plain'
  | 'pipe'
  | 'log'
  | 'json'
  | 'ndjson'

/** A timed action event for storybook timeline playback. */
export interface TimelineEvent<A> {
  /** Time offset in milliseconds from start */
  at: number
  /** Action to dispatch */
  action: A
}

/** Props for a tab button */
/** Props for TuiStoryPreview - uses a TuiApp for state management */
export interface TuiStoryPreviewProps<S, A> {
  /** A TuiApp instance (or any object with a compatible config) */
  app: {
    config: {
      stateSchema: Schema.Schema<S>
      actionSchema: Schema.Schema<A>
      initial: S
      reducer: (args: { state: S; action: A }) => S
    }
  }
  /** The view component to render (receives stateAtom, subscribes internally) */
  View: React.ComponentType<{ stateAtom: Atom.Atom<S> }>
  /** Initial state (defaults to app.config.initial) */
  initialState?: S
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

// =============================================================================
// Main Component
// =============================================================================

/** Storybook preview component that renders a TuiApp with multi-tab output modes and timeline playback. */
export const TuiStoryPreview = <S, A>({
  app,
  View,
  initialState: initialStateProp,
  timeline = [],
  height = 400,
  autoRun = true,
  playbackSpeed = 1,
  tabs = DEFAULT_TABS,
  defaultTab = 'tty',
}: TuiStoryPreviewProps<S, A>): React.ReactElement => {
  const { stateSchema, reducer } = app.config
  const initialState = initialStateProp ?? app.config.initial
  // UI State
  const [activeTab, setActiveTab] = useState<OutputTab>(defaultTab)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [ndjsonLines, setNdjsonLines] = useState<NdjsonLine[]>([])
  // Force re-render when atom changes (for panes that need current state value)
  const [, forceUpdate] = useState(0)

  // Atom-based state management (replaces React useState for state)
  const registryRef = useRef<Registry.Registry | null>(null)
  const stateAtomRef = useRef<Atom.Writable<S> | null>(null)
  if (!registryRef.current) {
    registryRef.current = Registry.make()
  }
  if (!stateAtomRef.current) {
    stateAtomRef.current = Atom.make(initialState)
  }
  const registry = registryRef.current
  const stateAtom = stateAtomRef.current

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

  // Compute final state by applying all timeline actions (for final modes)
  const finalState = useMemo(() => {
    let result = initialState
    for (const event of timeline) {
      result = reducer({ state: result, action: event.action })
    }
    return result
  }, [initialState, timeline, reducer])

  // Get current state from atom (for panes and JSON output)
  const currentState = registry.get(stateAtom)

  // Use final state for final modes, current state for live modes
  const effectiveState = isFinalMode(activeTab) === true ? finalState : currentState

  // Dispatch action and update state via atom
  const dispatch = useCallback(
    (action: A) => {
      const prev = registry.get(stateAtom)
      const next = reducer({ state: prev, action })
      registry.set(stateAtom, next)
      // Add to NDJSON log with timestamp
      try {
        const encoded = Schema.encodeSync(stateSchema)(next)
        setNdjsonLines((lines) => [
          ...lines,
          {
            timestamp: Date.now(),
            json: JSON.stringify(encoded),
          },
        ])
      } catch {
        // Ignore encoding errors
      }
      // Force re-render for panes that read effectiveState
      forceUpdate((n) => n + 1)
    },
    [reducer, stateSchema, registry, stateAtom],
  )

  // Reset to initial state
  const reset = useCallback(() => {
    registry.set(stateAtom, initialState)
    setCurrentTime(0)
    setIsPlaying(false)
    setNdjsonLines([])
    forceUpdate((n) => n + 1)
  }, [initialState, registry, stateAtom])

  // Timeline playback effect
  useEffect(() => {
    if (!isPlaying || timeline.length === 0) return

    const startTime = Date.now() - currentTime / playbackSpeed
    let animationFrame: number

    const tick = () => {
      const elapsed = (Date.now() - startTime) * playbackSpeed
      setCurrentTime(elapsed)

      // Find and dispatch any actions that should have fired
      // Use >= for lower bound so events at time 0 can fire when currentTime is also 0
      timeline.forEach((event) => {
        if (event.at <= elapsed && event.at >= currentTime) {
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

  // Initialize terminal for tty tab
  useEffect(() => {
    if (activeTab !== 'tty' || !containerRef.current || terminalRef.current) return

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

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      rootRef.current?.resize()
    })
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
    if (activeTab !== 'tty' || !isTerminalReady || !rootRef.current) return
    // Wrap in registry context so useTuiAtomValue works
    rootRef.current.render(
      <TuiRegistryContext.Provider value={registry}>
        <View stateAtom={stateAtom} />
      </TuiRegistryContext.Provider>,
    )
  }, [effectiveState, activeTab, isTerminalReady, registry, stateAtom])

  // Encode state as JSON (uses finalState for json mode since it's a final mode)
  const jsonOutput = useMemo(() => {
    try {
      const encoded = Schema.encodeSync(stateSchema)(finalState)
      return JSON.stringify(encoded, null, 2)
    } catch {
      return '// Error encoding state'
    }
  }, [finalState, stateSchema])

  // Cast View for non-generic components
  const ViewCast = View as React.ComponentType<{ stateAtom: Atom.Atom<unknown> }>

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          background: '#2d2d2d',
          borderBottom: '1px solid #3d3d3d',
        }}
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
        {/* Mode description */}
        <div
          style={{
            marginLeft: 'auto',
            paddingRight: '12px',
            fontSize: '12px',
            color: '#888',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          {TAB_DESCRIPTIONS[activeTab]}
        </div>
      </div>

      {/* Content */}
      <div style={{ height, overflow: 'hidden' }}>
        {activeTab === 'tty' && (
          <div
            ref={containerRef}
            style={{ ...containerStyles, padding: previewPadding, height: '100%' }}
          />
        )}
        {activeTab === 'alt-screen' && (
          <FullscreenPreviewPane
            View={ViewCast}
            stateAtom={stateAtom as Atom.Atom<unknown>}
            registry={registry}
            height={height}
          />
        )}
        {activeTab === 'ci' && (
          <CIPreviewPane
            View={ViewCast}
            stateAtom={stateAtom as Atom.Atom<unknown>}
            registry={registry}
            height={height}
          />
        )}
        {activeTab === 'ci-plain' && (
          <CIPlainPreviewPane
            View={ViewCast}
            stateAtom={stateAtom as Atom.Atom<unknown>}
            registry={registry}
            height={height}
          />
        )}
        {activeTab === 'pipe' && (
          <PipePreviewPane
            View={ViewCast}
            stateAtom={stateAtom as Atom.Atom<unknown>}
            registry={registry}
            height={height}
          />
        )}
        {activeTab === 'log' && (
          <LogPreviewPane
            View={ViewCast}
            stateAtom={stateAtom as Atom.Atom<unknown>}
            registry={registry}
            height={height}
          />
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
          disabled={isFinalMode(activeTab)}
          disabledMessage="Final output mode — showing end state"
        />
      )}
    </div>
  )
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
        if (key !== '_tag' && Array.isArray(value) === true) {
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
    if (Array.isArray(value) === true) {
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
        <span
          style={{ color: '#4a9eff', fontSize: '11px', fontFamily: 'Monaco, Menlo, monospace' }}
        >
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
  disabled = false,
  disabledMessage,
}: {
  isPlaying: boolean
  currentTime: number
  totalDuration: number
  timeline: Array<{ at: number; action: A }>
  onPlay: () => void
  onPause: () => void
  onReset: () => void
  onSeek: (time: number) => void
  disabled?: boolean
  disabledMessage?: string
}): React.ReactElement => {
  // Hover state for tooltip
  const [hoveredEvent, setHoveredEvent] = useState<{
    index: number
    position: { x: number; y: number }
  } | null>(null)

  // For disabled state, show timeline at 100%
  const effectiveTime = disabled ? totalDuration : currentTime
  const effectiveEventIndex = disabled ? timeline.length - 1 : -1

  // Calculate current event index (last event that has fired)
  const currentEventIndex = disabled
    ? effectiveEventIndex
    : timeline.findIndex((e, i) => {
        const nextEvent = timeline[i + 1]
        return e.at <= currentTime && (!nextEvent || nextEvent.at > currentTime)
      })

  // Get current event info
  const currentEvent = currentEventIndex >= 0 ? timeline[currentEventIndex] : null
  const currentActionTag = currentEvent ? formatActionTag(currentEvent.action) : 'Ready'
  const currentActionDetails = currentEvent ? getActionDetails(currentEvent.action) : null

  // Step to previous event
  const handlePrev = () => {
    if (disabled) return
    if (currentEventIndex <= 0) {
      onSeek(0)
    } else {
      const prevEvent = timeline[currentEventIndex - 1]
      if (prevEvent) onSeek(prevEvent.at)
    }
  }

  // Step to next event
  const handleNext = () => {
    if (disabled) return
    const nextIndex = currentEventIndex + 1
    if (nextIndex < timeline.length) {
      const nextEvent = timeline[nextIndex]
      if (nextEvent) onSeek(nextEvent.at)
    }
  }

  const hasEvents = timeline.length > 0

  // Disabled button style
  const disabledButtonStyle: React.CSSProperties = {
    ...smallButtonStyle,
    opacity: 0.4,
    cursor: 'not-allowed',
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '8px 12px',
        background: '#2d2d2d',
        borderTop: '1px solid #3d3d3d',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {/* Row 1: Step controls + Event index + Time (or disabled message) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {/* Step controls */}
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            onClick={handlePrev}
            style={disabled ? disabledButtonStyle : smallButtonStyle}
            disabled={disabled || (currentEventIndex <= 0 && currentTime === 0)}
            title={disabled ? 'Timeline disabled' : 'Previous event'}
            aria-label="Previous event"
          >
            ◀
          </button>
          <button
            onClick={disabled ? undefined : isPlaying ? onPause : onPlay}
            style={
              disabled
                ? { ...disabledButtonStyle, minWidth: '40px' }
                : { ...smallButtonStyle, minWidth: '40px' }
            }
            disabled={disabled}
            title={disabled ? 'Timeline disabled' : isPlaying ? 'Pause' : 'Play'}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button
            onClick={handleNext}
            style={disabled ? disabledButtonStyle : smallButtonStyle}
            disabled={disabled || currentEventIndex >= timeline.length - 1}
            title={disabled ? 'Timeline disabled' : 'Next event'}
            aria-label="Next event"
          >
            ▶
          </button>
          <button
            onClick={disabled ? undefined : onReset}
            style={disabled ? disabledButtonStyle : smallButtonStyle}
            disabled={disabled}
            title={disabled ? 'Timeline disabled' : 'Reset to beginning'}
            aria-label="Reset"
          >
            ↺
          </button>
        </div>

        {/* Disabled message or Event index + timestamp */}
        {disabled && disabledMessage ? (
          <span style={{ color: '#666', fontSize: '11px', fontStyle: 'italic' }}>
            {disabledMessage}
          </span>
        ) : hasEvents ? (
          <span style={{ color: '#888', fontSize: '11px' }}>
            Event {Math.max(0, currentEventIndex + 1)} of {timeline.length}
            {currentEvent && (
              <span style={{ color: '#666' }}> @ {(currentEvent.at / 1000).toFixed(1)}s</span>
            )}
          </span>
        ) : null}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Time display */}
        <span style={{ color: '#888', fontSize: '12px', fontFamily: 'Monaco, Menlo, monospace' }}>
          {(effectiveTime / 1000).toFixed(1)}s / {(totalDuration / 1000).toFixed(1)}s
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
          const isFired = disabled || event.at <= effectiveTime
          const isCurrent = disabled ? i === timeline.length - 1 : i === currentEventIndex
          const isHovered = !disabled && hoveredEvent?.index === i

          // Calculate gap to next marker to decide if label fits
          const nextEvent = timeline[i + 1]
          const nextPosition =
            nextEvent && totalDuration > 0 ? (nextEvent.at / totalDuration) * 100 : 100
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
                onClick={disabled ? undefined : () => onSeek(event.at)}
                onMouseEnter={
                  disabled
                    ? undefined
                    : (e) => {
                        const rect = e.currentTarget.getBoundingClientRect()
                        setHoveredEvent({
                          index: i,
                          position: { x: rect.left + rect.width / 2, y: rect.top },
                        })
                      }
                }
                onMouseLeave={disabled ? undefined : () => setHoveredEvent(null)}
                style={{
                  width: isCurrent || isHovered ? '14px' : '10px',
                  height: isCurrent || isHovered ? '14px' : '10px',
                  borderRadius: '50%',
                  background: isCurrent ? '#4a9eff' : isFired ? '#666' : '#444',
                  border: isCurrent
                    ? '2px solid #fff'
                    : isHovered
                      ? '2px solid #4a9eff'
                      : '1px solid #555',
                  cursor: disabled ? 'default' : 'pointer',
                  transition: 'all 0.15s ease',
                  marginTop: '5px',
                }}
              />

              {/* Label below marker */}
              {showLabel && (
                <span
                  onClick={disabled ? undefined : () => onSeek(event.at)}
                  style={{
                    marginTop: '4px',
                    fontSize: '9px',
                    fontFamily: 'Monaco, Menlo, monospace',
                    color: isCurrent ? '#4a9eff' : isFired ? '#888' : '#555',
                    whiteSpace: 'nowrap',
                    cursor: disabled ? 'default' : 'pointer',
                    textAlign: 'center',
                  }}
                >
                  {actionTag}
                </span>
              )}
            </div>
          )
        })}

        {/* Tooltip - only show when not disabled */}
        {!disabled && hoveredEvent && timeline[hoveredEvent.index] && (
          <EventTooltip
            event={timeline[hoveredEvent.index] as { at: number; action: unknown }}
            index={hoveredEvent.index}
            total={timeline.length}
            prevEventAt={
              hoveredEvent.index > 0 ? (timeline[hoveredEvent.index - 1]?.at ?? null) : null
            }
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
            width: totalDuration > 0 ? `${(effectiveTime / totalDuration) * 100}%` : '0%',
            height: '4px',
            background: disabled ? '#666' : '#4a9eff',
            borderRadius: '2px',
            zIndex: 1,
          }}
        />

        {/* Invisible range input for scrubbing (z-index below markers so hover works) */}
        <input
          type="range"
          min={0}
          max={totalDuration}
          value={effectiveTime}
          onChange={disabled ? undefined : (e) => onSeek(Number(e.target.value))}
          disabled={disabled}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            width: '100%',
            height: '100%',
            opacity: 0,
            cursor: disabled ? 'default' : 'pointer',
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
      ...containerStyles,
      ...previewTextStyles,
      fontSize: '12px', // Slightly smaller for JSON
      lineHeight: '15px',
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

interface NdjsonLine {
  timestamp: number
  json: string
}

const formatTimestamp = (ms: number): string => {
  const date = new Date(ms)
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  })
}

const NdjsonPreviewPane: React.FC<{ lines: NdjsonLine[] }> = ({ lines }) => (
  <pre
    style={{
      ...containerStyles,
      ...previewTextStyles,
      fontSize: '11px', // Slightly smaller for NDJSON
      lineHeight: '16px',
      overflow: 'auto',
      height: '100%',
    }}
  >
    {lines.map((line, i) => (
      <div
        key={i}
        style={{
          borderBottom: '1px solid #333',
          paddingBottom: '4px',
          marginBottom: '4px',
          display: 'flex',
          gap: '12px',
        }}
      >
        <span style={{ color: '#666', flexShrink: 0 }}>{formatTimestamp(line.timestamp)}</span>
        <span style={{ color: '#eee' }}>{line.json}</span>
      </div>
    ))}
  </pre>
)

// =============================================================================
// CI Preview Component (static output with colors)
// =============================================================================

const CIPreviewPane: React.FC<{
  View: React.ComponentType<{ stateAtom: Atom.Atom<unknown> }>
  stateAtom: Atom.Atom<unknown>
  registry: Registry.Registry
  height: number
}> = ({ View, stateAtom, registry, height }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  // Get current state for dependency tracking
  const state = registry.get(stateAtom)

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

    // Render with CI mode (static, with colors)
    // Wrap in registry context so useTuiAtomValue works
    const element = (
      <TuiRegistryContext.Provider value={registry}>
        <RenderConfigProvider config={ciRenderConfig}>
          <View stateAtom={stateAtom} />
        </RenderConfigProvider>
      </TuiRegistryContext.Provider>
    )

    renderToString({ element })
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
  }, [state, stateAtom, registry])

  useEffect(() => {
    return () => {
      terminalRef.current?.dispose()
      terminalRef.current = null
    }
  }, [])

  return <div ref={containerRef} style={{ ...containerStyles, padding: previewPadding, height }} />
}

// =============================================================================
// Hook: Measure container width and convert to columns
// =============================================================================

const CHAR_WIDTH_PX = 8.4 // Approximate char width for 14px Monaco

const useContainerColumns = (containerRef: React.RefObject<HTMLElement | null>): number => {
  const [columns, setColumns] = useState(80)

  useEffect(() => {
    if (!containerRef.current) return

    const calculateColumns = () => {
      const width = containerRef.current?.clientWidth ?? 0
      // Account for padding (8px on each side)
      const contentWidth = Math.max(0, width - 16)
      const cols = Math.floor(contentWidth / CHAR_WIDTH_PX)
      setColumns(Math.max(40, cols)) // Minimum 40 columns
    }

    // Initial calculation
    calculateColumns()

    // Observe resize
    const resizeObserver = new ResizeObserver(() => {
      calculateColumns()
    })
    resizeObserver.observe(containerRef.current)

    return () => resizeObserver.disconnect()
  }, [containerRef])

  return columns
}

// =============================================================================
// Log Preview Component (static output, plain text - no colors)
// =============================================================================

const LogPreviewPane: React.FC<{
  View: React.ComponentType<{ stateAtom: Atom.Atom<unknown> }>
  stateAtom: Atom.Atom<unknown>
  registry: Registry.Registry
  height: number
}> = ({ View, stateAtom, registry, height }) => {
  const [output, setOutput] = useState<string>('')
  const containerRef = useRef<HTMLPreElement>(null)
  const columns = useContainerColumns(containerRef)
  // Get current state for dependency tracking
  const state = registry.get(stateAtom)

  useEffect(() => {
    // Render with log mode (static, no colors)
    // Wrap in registry context so useTuiAtomValue works
    const element = (
      <TuiRegistryContext.Provider value={registry}>
        <RenderConfigProvider config={logRenderConfig}>
          <View stateAtom={stateAtom} />
        </RenderConfigProvider>
      </TuiRegistryContext.Provider>
    )

    renderToString({ element, options: { width: columns } })
      .then((ansiOutput) => {
        // Strip ANSI codes for plain text output
        setOutput(stripAnsi(ansiOutput))
      })
      .catch((err: Error) => {
        setOutput(`Error: ${err.message}`)
      })
  }, [state, stateAtom, registry, columns])

  return (
    <pre
      ref={containerRef}
      style={{
        ...containerStyles,
        ...previewTextStyles,
        overflow: 'auto',
        height,
      }}
    >
      {output}
    </pre>
  )
}

// =============================================================================
// CI Plain Preview Component (live output, no colors)
// =============================================================================

const CIPlainPreviewPane: React.FC<{
  View: React.ComponentType<{ stateAtom: Atom.Atom<unknown> }>
  stateAtom: Atom.Atom<unknown>
  registry: Registry.Registry
  height: number
}> = ({ View, stateAtom, registry, height }) => {
  const [output, setOutput] = useState<string>('')
  const containerRef = useRef<HTMLPreElement>(null)
  const columns = useContainerColumns(containerRef)
  // Get current state for dependency tracking
  const state = registry.get(stateAtom)

  useEffect(() => {
    // Render with ci-plain mode (no animation, no colors)
    // Wrap in registry context so useTuiAtomValue works
    const element = (
      <TuiRegistryContext.Provider value={registry}>
        <RenderConfigProvider config={ciPlainRenderConfig}>
          <View stateAtom={stateAtom} />
        </RenderConfigProvider>
      </TuiRegistryContext.Provider>
    )

    renderToString({ element, options: { width: columns } })
      .then((ansiOutput) => {
        // Strip ANSI codes for plain text output
        setOutput(stripAnsi(ansiOutput))
      })
      .catch((err: Error) => {
        setOutput(`Error: ${err.message}`)
      })
  }, [state, stateAtom, registry, columns])

  return (
    <pre
      ref={containerRef}
      style={{
        ...containerStyles,
        ...previewTextStyles,
        overflow: 'auto',
        height,
      }}
    >
      {output}
    </pre>
  )
}

// =============================================================================
// Pipe Preview Component (final output with colors)
// =============================================================================

const PipePreviewPane: React.FC<{
  View: React.ComponentType<{ stateAtom: Atom.Atom<unknown> }>
  stateAtom: Atom.Atom<unknown>
  registry: Registry.Registry
  height: number
}> = ({ View, stateAtom, registry, height }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  // Get current state for dependency tracking
  const state = registry.get(stateAtom)

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

    // Render with pipe mode (final, with colors)
    // Wrap in registry context so useTuiAtomValue works
    const element = (
      <TuiRegistryContext.Provider value={registry}>
        <RenderConfigProvider config={pipeRenderConfig}>
          <View stateAtom={stateAtom} />
        </RenderConfigProvider>
      </TuiRegistryContext.Provider>
    )

    renderToString({ element })
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
  }, [state, stateAtom, registry])

  useEffect(() => {
    return () => {
      terminalRef.current?.dispose()
      terminalRef.current = null
    }
  }, [])

  return <div ref={containerRef} style={{ ...containerStyles, padding: previewPadding, height }} />
}

// =============================================================================
// Fullscreen Terminal Component
// =============================================================================

const FullscreenPreviewPane: React.FC<{
  View: React.ComponentType<{ stateAtom: Atom.Atom<unknown> }>
  stateAtom: Atom.Atom<unknown>
  registry: Registry.Registry
  height: number
}> = ({ View, stateAtom, registry, height }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const rootRef = useRef<Root | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const [dimensions, setDimensions] = useState({ cols: 80, rows: 24 })
  const [lastKey, setLastKey] = useState<string | null>(null)
  // Get current state for dependency tracking
  const state = registry.get(stateAtom)

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return

    const terminal = new Terminal({
      fontFamily: 'Monaco, Menlo, "DejaVu Sans Mono", Consolas, monospace',
      fontSize: 14,
      theme: xtermTheme,
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
      rootRef.current?.resize()
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
  // Wrap in registry context so useTuiAtomValue works
  useEffect(() => {
    if (!isReady || !rootRef.current) return
    rootRef.current.render(
      <TuiRegistryContext.Provider value={registry}>
        <View stateAtom={stateAtom} />
      </TuiRegistryContext.Provider>,
    )
  }, [state, isReady, stateAtom, registry])

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

  const statusBarHeight = 24
  const terminalHeight = height - statusBarHeight

  return (
    <div
      style={{
        ...containerStyles,
        display: 'flex',
        flexDirection: 'column',
        height,
        outline: 'none',
      }}
      tabIndex={0}
      onFocus={() => setIsFocused(true)}
      onBlur={() => setIsFocused(false)}
    >
      {/* Terminal */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          height: terminalHeight,
          padding: previewPadding,
          boxSizing: 'border-box',
        }}
      />

      {/* Status Bar (at bottom) */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '4px 12px',
          backgroundColor: '#252538',
          borderTop: '1px solid #333',
          fontSize: '11px',
          fontFamily: 'system-ui, sans-serif',
          color: '#666',
          height: statusBarHeight,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ color: '#888' }}>Alt Screen (Simulated)</span>
          <span>
            {dimensions.cols}x{dimensions.rows}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {lastKey && (
            <span>
              Key: <code style={{ color: '#aaa' }}>{lastKey}</code>
            </span>
          )}
          <span style={{ color: isFocused ? '#4a9eff' : '#666' }}>
            {isFocused ? 'Focused' : 'Click to focus'}
          </span>
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// Tab Labels
// =============================================================================

const TAB_LABELS: Record<OutputTab, string> = {
  tty: 'TTY',
  'alt-screen': 'Alt Screen',
  ci: 'CI',
  'ci-plain': 'CI Plain',
  pipe: 'Pipe',
  log: 'Log',
  json: 'JSON',
  ndjson: 'NDJSON',
}

const TAB_DESCRIPTIONS: Record<OutputTab, string> = {
  tty: 'Live • Animated • Colored',
  'alt-screen': 'Live • Animated • Colored • Fullscreen',
  ci: 'Live • Static • Colored',
  'ci-plain': 'Live • Static • Plain',
  pipe: 'Final • Static • Colored',
  log: 'Final • Static • Plain',
  json: 'Final JSON output',
  ndjson: 'Streaming NDJSON',
}

/** Modes that only show final output (no timeline) */
const FINAL_MODES: Set<OutputTab> = new Set(['pipe', 'log', 'json'])

const isFinalMode = (tab: OutputTab): boolean => FINAL_MODES.has(tab)

const DEFAULT_TABS: OutputTab[] = ['tty', 'ci', 'log', 'json', 'ndjson']
