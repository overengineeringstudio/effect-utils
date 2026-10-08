/**
 * Devbar sticky footer — exploration V1 (design step, not the shipped API).
 *
 * Open question (q1): where do always-on meters and consumer segments live relative to the
 * existing panel tabs? Every value shown is a real browser measurement; unsupported sources
 * render "n/a" instead of a placeholder number.
 *
 * - F1 inline: one strip; consumer segments left, panel tabs middle, meter readouts right.
 * - F2 pill: collapsed corner pill with readouts; Ctrl+` or click expands to the F1 strip.
 * - F3 two rows: existing tab bar unchanged; a thin status row with segments and meters below.
 */
import type { Meta, StoryObj } from '@storybook/react'
import * as stylex from '@stylexjs/stylex'
import * as React from 'react'

import { FpsMeter } from '../Devbar.tsx'
import { observeFps } from '../fps-meter.ts'
import { darkDevbarTheme, lightDevbarTheme } from '../themes.ts'
import { devbarTokens } from '../tokens.stylex.ts'

type Layout = 'F1' | 'F2' | 'F3'

const layouts: readonly { id: Layout; description: string }[] = [
  { id: 'F1', description: 'Inline: segments left, tabs middle, meter readouts right' },
  { id: 'F2', description: 'Pill: collapsed corner readouts, expands to the full strip' },
  { id: 'F3', description: 'Two rows: tab bar unchanged, thin status row below' },
]

/** One external store per source; each starts its observer only while subscribed. */
const useSource = <A,>({
  start,
  initial,
}: {
  readonly start: (emit: (value: A) => void) => () => void
  readonly initial: A
}): A => {
  const value = React.useRef(initial)
  const subscribe = React.useCallback(
    (notify: () => void) =>
      start((next) => {
        value.current = next
        notify()
      }),
    [start],
  )
  return React.useSyncExternalStore(
    subscribe,
    () => value.current,
    () => initial,
  )
}

const startFps = (emit: (fps: number) => void) =>
  observeFps({
    clock: {
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (id) => window.cancelAnimationFrame(id),
      visibility: document,
    },
    onSample: emit,
  })

type LongFrames = { _tag: 'unsupported' } | { _tag: 'observed'; count: number; maxMs: number }

const startLongFrames = (emit: (value: LongFrames) => void) => {
  const supported = PerformanceObserver.supportedEntryTypes
  const type =
    supported.includes('long-animation-frame') === true
      ? 'long-animation-frame'
      : supported.includes('longtask') === true
        ? 'longtask'
        : undefined
  if (type === undefined) {
    emit({ _tag: 'unsupported' })
    return () => {}
  }
  let count = 0
  let maxMs = 0
  emit({ _tag: 'observed', count, maxMs })
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      count += 1
      maxMs = Math.max(maxMs, Math.round(entry.duration))
    }
    emit({ _tag: 'observed', count, maxMs })
  })
  observer.observe({ type, buffered: false })
  return () => observer.disconnect()
}

type Memory = { _tag: 'unsupported' } | { _tag: 'observed'; usedMb: number }

/** `performance.memory` is Chromium-only and non-standard; other engines report unsupported. */
const startMemory = (emit: (value: Memory) => void) => {
  const memory = 'memory' in performance ? performance.memory : undefined
  if (
    typeof memory !== 'object' ||
    memory === null ||
    !('usedJSHeapSize' in memory) ||
    typeof memory.usedJSHeapSize !== 'number'
  ) {
    emit({ _tag: 'unsupported' })
    return () => {}
  }
  const heap = memory
  const sample = () =>
    emit({ _tag: 'observed', usedMb: Math.round(Number(heap.usedJSHeapSize) / 1e6) })
  sample()
  const id = window.setInterval(sample, 1000)
  return () => window.clearInterval(id)
}

/** Consumer-owned segment example: real connectivity from the browser, not a sync engine. */
const startOnline = (emit: (online: boolean) => void) => {
  const update = () => emit(navigator.onLine)
  update()
  window.addEventListener('online', update)
  window.addEventListener('offline', update)
  return () => {
    window.removeEventListener('online', update)
    window.removeEventListener('offline', update)
  }
}

const styles = stylex.create({
  page: { display: 'grid', gap: '1rem', padding: '1rem', fontFamily: devbarTokens.fontUi },
  picker: { display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' },
  pick: {
    paddingBlock: '0.25rem',
    paddingInline: '0.6rem',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: devbarTokens.border,
    backgroundColor: devbarTokens.canvas,
    color: devbarTokens.text,
    cursor: 'pointer',
  },
  picked: { backgroundColor: devbarTokens.text, color: devbarTokens.canvas },
  muted: { color: devbarTokens.mutedText, fontSize: '0.8rem' },
  frames: {
    display: 'grid',
    gap: '1rem',
    gridTemplateColumns: 'repeat(auto-fit, minmax(28rem, 1fr))',
  },
  frame: {
    position: 'relative',
    height: '16rem',
    overflow: 'hidden',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: devbarTokens.border,
    backgroundColor: devbarTokens.panel,
    color: devbarTokens.text,
  },
  frameLabel: { margin: '0.75rem', color: devbarTokens.mutedText, fontSize: '0.8rem' },
  dock: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: devbarTokens.canvas,
    color: devbarTokens.text,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: devbarTokens.border,
    fontSize: '0.75rem',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.25rem',
    minHeight: '2rem',
    paddingInline: '0.5rem',
  },
  thinRow: {
    minHeight: '1.4rem',
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: devbarTokens.border,
    color: devbarTokens.mutedText,
  },
  spacer: { flexGrow: 1 },
  tab: {
    paddingBlock: '0.3rem',
    paddingInline: '0.5rem',
    borderWidth: 0,
    backgroundColor: { default: 'transparent', ':hover': devbarTokens.panel },
    color: devbarTokens.text,
    cursor: 'pointer',
  },
  tabActive: { backgroundColor: devbarTokens.panelActive },
  readout: {
    fontFamily: devbarTokens.fontData,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    paddingInline: '0.4rem',
  },
  panel: {
    height: '8rem',
    overflow: 'auto',
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: devbarTokens.border,
  },
  pill: {
    position: 'absolute',
    right: '0.5rem',
    bottom: '0.5rem',
    display: 'flex',
    alignItems: 'center',
    gap: '0.25rem',
    paddingBlock: '0.25rem',
    paddingInline: '0.5rem',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: devbarTokens.border,
    borderRadius: '999px',
    backgroundColor: devbarTokens.canvas,
    color: devbarTokens.text,
    fontSize: '0.75rem',
    cursor: 'pointer',
  },
})

const Readouts = (): React.ReactNode => {
  const fps = useSource({ start: startFps, initial: undefined as number | undefined })
  const longFrames = useSource({
    start: startLongFrames,
    initial: { _tag: 'unsupported' } as LongFrames,
  })
  const memory = useSource({ start: startMemory, initial: { _tag: 'unsupported' } as Memory })
  return (
    <>
      <span aria-label="Frames per second" {...stylex.props(styles.readout)}>
        {fps ?? '—'} fps
      </span>
      <span aria-label="Long frames" {...stylex.props(styles.readout)}>
        {longFrames._tag === 'observed'
          ? `${longFrames.count} long · max ${longFrames.maxMs}ms`
          : 'long frames n/a'}
      </span>
      <span aria-label="JS heap" {...stylex.props(styles.readout)}>
        {memory._tag === 'observed' ? `${memory.usedMb} MB heap` : 'heap n/a'}
      </span>
    </>
  )
}

const Segments = (): React.ReactNode => {
  const online = useSource({ start: startOnline, initial: true })
  return (
    <span {...stylex.props(styles.readout)}>sync: {online === true ? 'online' : 'offline'}</span>
  )
}

const tabs = ['Performance', 'Requests', 'Logs'] as const

const Tabs = ({
  open,
  onOpen,
}: {
  open: string | undefined
  onOpen: (tab: string | undefined) => void
}): React.ReactNode =>
  tabs.map((tab) => (
    <button
      key={tab}
      type="button"
      aria-expanded={open === tab}
      onClick={() => onOpen(open === tab ? undefined : tab)}
      {...stylex.props(styles.tab, open === tab && styles.tabActive)}
    >
      {tab}
    </button>
  ))

const Panel = ({ open }: { open: string | undefined }): React.ReactNode =>
  open === undefined ? null : (
    <section aria-label={open} {...stylex.props(styles.panel)}>
      {open === 'Performance' ? (
        <FpsMeter />
      ) : (
        <p {...stylex.props(styles.frameLabel)}>{open} panel</p>
      )}
    </section>
  )

const Footer = ({ layout }: { layout: Layout }): React.ReactNode => {
  const [open, setOpen] = React.useState<string | undefined>(undefined)
  const [expanded, setExpanded] = React.useState(false)

  if (layout === 'F2' && expanded === false) {
    return (
      <button
        type="button"
        aria-label="Expand developer tools"
        onClick={() => setExpanded(true)}
        {...stylex.props(styles.pill)}
      >
        <Readouts />
      </button>
    )
  }

  if (layout === 'F3') {
    return (
      <div {...stylex.props(styles.dock)}>
        <Panel open={open} />
        <div {...stylex.props(styles.row)}>
          <Tabs open={open} onOpen={setOpen} />
        </div>
        <div {...stylex.props(styles.row, styles.thinRow)}>
          <Segments />
          <span {...stylex.props(styles.spacer)} />
          <Readouts />
        </div>
      </div>
    )
  }

  return (
    <div {...stylex.props(styles.dock)}>
      <Panel open={open} />
      <div {...stylex.props(styles.row)}>
        <Segments />
        <Tabs open={open} onOpen={setOpen} />
        <span {...stylex.props(styles.spacer)} />
        <Readouts />
        {layout === 'F2' && (
          <button type="button" onClick={() => setExpanded(false)} {...stylex.props(styles.tab)}>
            Collapse
          </button>
        )}
      </div>
    </div>
  )
}

/** Blocks the main thread so the long-frame readout shows a real entry. */
const blockMainThread = (ms: number) => {
  const until = performance.now() + ms
  while (performance.now() < until) {
    /* busy wait on purpose */
  }
}

const Exploration = (): React.ReactNode => {
  const [layout, setLayout] = React.useState<Layout>('F1')
  return (
    <div {...stylex.props(styles.page, lightDevbarTheme)}>
      <div {...stylex.props(styles.picker)}>
        <strong>Footer layout</strong>
        {layouts.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={layout === option.id}
            onClick={() => setLayout(option.id)}
            {...stylex.props(styles.pick, layout === option.id && styles.picked)}
          >
            {option.id}
          </button>
        ))}
        <span {...stylex.props(styles.muted)}>
          ← {layouts.find((option) => option.id === layout)?.description}
        </span>
      </div>
      <div {...stylex.props(styles.picker)}>
        <button type="button" onClick={() => blockMainThread(150)} {...stylex.props(styles.pick)}>
          Block main thread 150ms
        </button>
        <span {...stylex.props(styles.muted)}>
          Real measurements only. Long frames need Chromium (LoAF/longtask); heap needs Chromium
          performance.memory. Sync segment is a consumer-owned example backed by navigator.onLine.
        </span>
      </div>
      <div {...stylex.props(styles.frames)}>
        <div {...stylex.props(styles.frame, lightDevbarTheme)}>
          <p {...stylex.props(styles.frameLabel)}>{layout} · light</p>
          <Footer layout={layout} />
        </div>
        <div {...stylex.props(styles.frame, darkDevbarTheme)}>
          <p {...stylex.props(styles.frameLabel)}>{layout} · dark</p>
          <Footer layout={layout} />
        </div>
      </div>
    </div>
  )
}

const meta = {
  title: 'Developer Bar/Exploration/Footer V1',
  component: Exploration,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Exploration>

export default meta

export const FooterLayout: StoryObj<typeof meta> = {}
