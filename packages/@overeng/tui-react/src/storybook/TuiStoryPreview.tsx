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
// Playback Controls Component
// =============================================================================

const PlaybackControls: React.FC<{
  isPlaying: boolean
  currentTime: number
  totalDuration: number
  onPlay: () => void
  onPause: () => void
  onReset: () => void
  onSeek: (time: number) => void
}> = ({ isPlaying, currentTime, totalDuration, onPlay, onPause, onReset, onSeek }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '8px 12px',
      background: '#2d2d2d',
      borderTop: '1px solid #3d3d3d',
    }}
  >
    <button
      onClick={isPlaying ? onPause : onPlay}
      style={{
        padding: '4px 12px',
        border: '1px solid #555',
        borderRadius: '4px',
        background: '#3d3d3d',
        color: '#fff',
        cursor: 'pointer',
        fontSize: '12px',
      }}
    >
      {isPlaying ? '⏸ Pause' : '▶ Play'}
    </button>
    <button
      onClick={onReset}
      style={{
        padding: '4px 12px',
        border: '1px solid #555',
        borderRadius: '4px',
        background: '#3d3d3d',
        color: '#fff',
        cursor: 'pointer',
        fontSize: '12px',
      }}
    >
      ↺ Reset
    </button>
    <input
      type="range"
      min={0}
      max={totalDuration}
      value={currentTime}
      onChange={(e) => onSeek(Number(e.target.value))}
      style={{ flex: 1 }}
    />
    <span style={{ color: '#888', fontSize: '12px', minWidth: '80px' }}>
      {(currentTime / 1000).toFixed(1)}s / {(totalDuration / 1000).toFixed(1)}s
    </span>
  </div>
)

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

  // Render content
  useEffect(() => {
    if (!isReady || !rootRef.current || !terminalRef.current) return

    terminalRef.current.clear()
    terminalRef.current.reset()

    const adapter = {
      write: (data: string) => terminalRef.current?.write(data),
      get columns() {
        return terminalRef.current?.cols ?? 80
      },
      get rows() {
        return terminalRef.current?.rows ?? 24
      },
      isTTY: true as const,
    }
    rootRef.current = createRoot({ terminalOrStream: adapter })
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
const DEFAULT_TABS_SIMPLE: OutputTab[] = ['visual']

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

  // Render children to terminal
  useEffect(() => {
    if (activeTab !== 'visual' || !isTerminalReady || !rootRef.current || !terminalRef.current)
      return

    terminalRef.current.clear()
    terminalRef.current.reset()

    const adapter = {
      write: (data: string) => terminalRef.current?.write(data),
      get columns() {
        return terminalRef.current?.cols ?? 80
      },
      get rows() {
        return terminalRef.current?.rows ?? 24
      },
      isTTY: true as const,
    }
    rootRef.current = createRoot({ terminalOrStream: adapter })
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

  // Render view to terminal when state changes
  useEffect(() => {
    if (activeTab !== 'visual' || !isTerminalReady || !rootRef.current || !terminalRef.current)
      return

    terminalRef.current.clear()
    terminalRef.current.reset()

    const adapter = {
      write: (data: string) => terminalRef.current?.write(data),
      get columns() {
        return terminalRef.current?.cols ?? 80
      },
      get rows() {
        return terminalRef.current?.rows ?? 24
      },
      isTTY: true as const,
    }
    rootRef.current = createRoot({ terminalOrStream: adapter })
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
