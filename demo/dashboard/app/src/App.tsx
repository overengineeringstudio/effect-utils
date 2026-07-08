import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { RawSegment } from '../../screenplay.ts'
import { DEMOS, type DemoModel, type ModelBeat, type Shot } from './model.gen.ts'
import { InlineMd } from './inline-md.tsx'
import {
  At,
  CodeLine,
  Cm,
  DbBrowser,
  KW,
  MacWindow,
  MiniIDE as KitIDE,
  NotionBlock,
  NotionPage,
  NotionSurface,
  Prompt,
  STR,
  Terminal,
  TerminalLine,
  WinTitle,
} from '../../kit/index.ts'

// ---------------------------------------------------------------------------
// pure helpers — ported byte-for-byte from build.ts
// ---------------------------------------------------------------------------

// Intro is the first tab (id "intro", key "0", default on load); demos follow.
const TAB_IDS = ['intro', ...DEMOS.map((d) => d.id)]

// Nav layout: consecutive demos sharing a groupId render clustered (e.g. the
// schema group's 3.1/3.2); everything else is a solo tab. Order follows DEMOS.
type NavItem = { kind: 'solo'; demo: DemoModel } | { kind: 'group'; groupId: string; label: string; members: DemoModel[] }
const NAV_ITEMS: NavItem[] = (() => {
  const out: NavItem[] = []
  for (const d of DEMOS) {
    if (d.groupId) {
      const last = out[out.length - 1]
      if (last && last.kind === 'group' && last.groupId === d.groupId) {
        last.members.push(d)
        continue
      }
      out.push({ kind: 'group', groupId: d.groupId, label: d.groupLabel ?? d.groupId, members: [d] })
    } else {
      out.push({ kind: 'solo', demo: d })
    }
  }
  return out
})()

// Number-key routing keyed on the integer part of displayNum ("3.1" → "3").
// A key that maps to one demo selects it; a key that maps to a group (multiple
// members, e.g. "3" → [3.1, 3.2]) selects the first member, then CYCLES through
// the group on repeated presses while already inside it.
const KEY_MAP: Record<string, DemoModel[]> = (() => {
  const m: Record<string, DemoModel[]> = {}
  for (const d of DEMOS) {
    const key = d.displayNum.split('.')[0]!
    ;(m[key] ??= []).push(d)
  }
  return m
})()
// Largest single-digit key present, for the header hint ("keys 1–N").
const MAX_KEY = Math.max(...Object.keys(KEY_MAP).map(Number))

// A code segment is expected program OUTPUT (not a runnable command), so it gets
// NO copy affordance, when the model marked it `noCopy` — set in the parser from
// the fence info-string (```output/```console/```keys/```text) OR the legacy
// `^Error:`-only fallback. The `isOutputBlock` fallback below re-applies that
// legacy rule at render time so any un-flagged pre-info-string block still works.
const isOutputBlock = (raw: string): boolean => {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.length > 0 && lines.every((l) => /^Error:/.test(l))
}

// Resolve the no-copy decision for a code segment: trust the model flag, but
// fall back to the legacy heuristic so nothing regresses if a block predates it.
const isNoCopy = (seg: Extract<RawSegment, { kind: 'code' }>): boolean => seg.noCopy ?? isOutputBlock(seg.raw)

// build.ts fmtWhen — UTC "Mon D HH:MMZ"
const fmtWhen = (iso?: string): string => {
  if (!iso) return ''
  const d = new Date(iso)
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  const day = d.getUTCDate()
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${mon} ${day} ${hh}:${mm}Z`
}

const canExplain = (d: DemoModel): boolean => !!d.explainerSrc
const hasBackups = (d: DemoModel): boolean => d.beats.some((b) => b.images.length > 0)

type View = 'instructions' | 'explanation'
type Backups = 'shown' | 'hidden'

// ---------------------------------------------------------------------------
// click-to-copy (byte-exact from the raw model string — never DOM text)
// ---------------------------------------------------------------------------

const fallbackCopy = (text: string, done: () => void): void => {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
    done()
  } catch {
    /* ignore */
  }
  document.body.removeChild(ta)
}

// `overlay` = absolutely-positioned button pinned inside a code block (default,
// used by every command <pre>). `inline` = a small in-flow button for tight
// chips (e.g. the compact backstage reset). Copy behavior is identical — always
// byte-exact from the raw model string.
const CopyButton = ({ raw, variant = 'overlay' }: { raw: string; variant?: 'overlay' | 'inline' }) => {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onClick = () => {
    const done = () => {
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 900)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(raw).then(done).catch(() => fallbackCopy(raw, done))
    } else fallbackCopy(raw, done)
  }
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  const shape =
    variant === 'overlay'
      ? 'absolute right-1.5 top-1.5 h-7 w-[30px] text-[15px]'
      : 'h-6 w-6 flex-none text-[13px]'
  return (
    <button
      type="button"
      onClick={onClick}
      title="Copy to clipboard"
      aria-label="Copy command"
      className={
        `inline-flex cursor-pointer items-center justify-center rounded-md border leading-none ${shape} ` +
        (copied
          ? 'border-ok bg-ok text-white'
          : 'border-white/15 bg-white/5 text-[#cfd6e0] hover:bg-white/15 hover:text-white')
      }
    >
      {copied ? '✓' : '⧉'}
    </button>
  )
}

// ---------------------------------------------------------------------------
// segment renderer (raw model → JSX; escaping + inline-md done in JSX)
// ---------------------------------------------------------------------------

const CodeSegment = ({ seg }: { seg: Extract<RawSegment, { kind: 'code' }> }) => {
  const raw = seg.raw
  if (isNoCopy(seg)) {
    return (
      <div className="rounded-lg border border-dashed border-fail bg-[color-mix(in_srgb,var(--color-fail)_8%,var(--color-bg-code))]">
        <span className="block px-3 pt-1.5 text-[10px] font-bold uppercase tracking-wide text-fail">
          expected output · not a command
        </span>
        <pre className="m-0 overflow-x-auto whitespace-pre px-3 pb-2.5 font-mono text-[13px] leading-normal text-[#ffb4b4]">
          {raw}
        </pre>
      </div>
    )
  }
  return (
    <div className="relative rounded-lg border border-border-strong bg-bg-code">
      <pre className="m-0 overflow-x-auto whitespace-pre py-2.5 pl-3 pr-11 font-mono text-[13px] leading-normal text-code-fg">
        {raw}
      </pre>
      <CopyButton raw={raw} />
    </div>
  )
}

const Segment = ({ seg }: { seg: RawSegment }) => {
  if (seg.kind === 'code') return <CodeSegment seg={seg} />
  if (seg.kind === 'say') {
    return (
      <p className="py-1 text-[13px] italic text-fg-muted">
        <span className="mr-2 rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] font-bold not-italic tracking-wider text-fg-faint">
          SAY
        </span>
        {seg.text}
      </p>
    )
  }
  const isExpect = seg.isExpectation
  return (
    <p className={isExpect ? 'text-[13px] font-medium text-fg' : 'text-[13px] text-fg-muted'}>
      {isExpect && <span className="mr-0.5 font-bold text-accent">→ </span>}
      {seg.lines.map((line, i) => (
        <span key={i}>
          {i > 0 && <br />}
          <InlineMd line={line} />
        </span>
      ))}
    </p>
  )
}

// ---------------------------------------------------------------------------
// status badge + summary pill
// ---------------------------------------------------------------------------

const StatusBadge = ({ status }: { status: ModelBeat['status'] }) => {
  const base = 'inline-flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full text-[13px] font-bold'
  if (status === 'pass')
    return (
      <span title="passed in latest harness run" className={`${base} bg-ok/15 text-ok`}>
        ✓
      </span>
    )
  if (status === 'fail')
    return (
      <span title="failed in latest harness run" className={`${base} bg-fail/15 text-fail`}>
        ✗
      </span>
    )
  if (status === 'mock')
    return (
      <span title="illustrative / mock — not harnessed" className={`${base} bg-amber/15 text-amber`}>
        ◆
      </span>
    )
  return (
    <span title="not yet harnessed" className={`${base} bg-bg-subtle text-neutral`}>
      ○
    </span>
  )
}

const SummaryPill = ({ d }: { d: DemoModel }) => {
  const pill = 'whitespace-nowrap rounded-full border border-border px-2.5 py-1 text-[12.5px] font-semibold tracking-tight'
  if (d.summary.mock) {
    return (
      <span title="illustrative preview — no harness run" className={`${pill} border-amber/40 text-amber`}>
        ◆ illustrative · not harnessed
      </span>
    )
  }
  if (d.summary.harnessed) {
    const ok = d.summary.pass === d.summary.total
    return (
      <span className={`${pill} ${ok ? 'text-ok' : 'text-fail'}`}>
        ● {d.summary.pass}/{d.summary.total} passed · {Math.round(d.summary.durationSec ?? 0)}s ·{' '}
        {fmtWhen(d.summary.finishedAt)}
      </span>
    )
  }
  return <span className={`${pill} text-neutral`}>○ not yet harnessed</span>
}

// ---------------------------------------------------------------------------
// beat card
// ---------------------------------------------------------------------------

const BeatCard = ({
  beat,
  open,
  onToggle,
  onShot,
}: {
  beat: ModelBeat
  open: boolean
  onToggle: () => void
  onShot: (src: string) => void
}) => {
  const hasImages = beat.images.length > 0
  return (
    <article className="rounded-lg border border-border bg-bg-panel px-3.5 py-3">
      <div className="mb-2 flex items-center gap-2.5">
        <span className="whitespace-nowrap text-[11px] font-bold uppercase tracking-wider text-fg-faint">
          {beat.label}
        </span>
        <span className="min-w-0 flex-1 text-[14.5px] font-semibold">{beat.title}</span>
        <StatusBadge status={beat.status} />
      </div>
      {beat.narration && (
        <p className="mb-2 rounded-md bg-say-bg px-2.5 py-1.5 text-[13.5px] text-say-fg">
          <span className="mr-2 rounded bg-say-fg/15 px-1.5 py-0.5 text-[10px] font-bold tracking-wider">SAY</span>
          {beat.narration}
        </p>
      )}
      <div className="flex flex-col gap-2">
        {beat.segments.map((seg, j) => (
          <Segment key={j} seg={seg} />
        ))}
      </div>
      <div className="mt-2.5">
        {hasImages ? (
          <button
            type="button"
            onClick={onToggle}
            className="cursor-pointer border-none bg-transparent p-0 text-[12.5px] font-medium text-accent hover:underline"
          >
            {open ? '▾ hide backup' : '▸ show backup'}
          </button>
        ) : (
          <span title="no harness screenshots yet" className="text-[12.5px] font-medium text-fg-faint">
            ▹ evidence pending
          </span>
        )}
      </div>
      {hasImages && open && (
        <div className="mt-2.5 border-t border-dashed border-border pt-2.5">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
            {beat.images.map((im: Shot, k) => (
              <figure key={k} className="m-0 overflow-hidden rounded-lg border border-border bg-bg-subtle">
                <figcaption className="border-b border-border bg-bg-panel px-2.5 py-1.5 text-[11px] font-semibold text-fg-muted">
                  {im.label}
                </figcaption>
                <img
                  loading="lazy"
                  src={im.file}
                  alt={im.label}
                  title="Click to enlarge"
                  onClick={() => onShot(im.file)}
                  className="block h-auto w-full cursor-zoom-in"
                />
              </figure>
            ))}
          </div>
        </div>
      )}
    </article>
  )
}

// ---------------------------------------------------------------------------
// explainer iframe — auto-height so the PAGE scrolls, never the iframe.
//
// The explainer pages are SAME-ORIGIN siblings (served from demo/explainers/),
// so we read the loaded document's scrollHeight and pin the iframe to exactly
// that — no inner scrollbar, single document scroll. Measurement is made
// height-independent by first collapsing to 0 (scrollHeight can never report a
// value smaller than the frame's own height), forcing a sync reflow, then
// reading. Re-measures on load (fires after images) and on window resize
// (rAF-debounced) since a width change reflows the content to a new height.
// The explainers are normal-flow docs (no html/body 100vh sizing — verified),
// so onLoad + resize is sufficient; no inner ResizeObserver needed.
// ---------------------------------------------------------------------------

const ExplainerFrame = ({ src, title }: { src?: string; title: string }) => {
  const ref = useRef<HTMLIFrameElement>(null)
  const measure = useCallback(() => {
    const frame = ref.current
    const doc = frame?.contentDocument
    if (!frame || !doc) return
    frame.style.height = '0px' // baseline: make the read independent of current height
    const h = doc.documentElement.scrollHeight // forces sync reflow
    if (h > 0) frame.style.height = `${h}px`
  }, [])
  useEffect(() => {
    let raf = 0
    const onResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [measure])
  return (
    <iframe
      ref={ref}
      title={title}
      loading="lazy"
      src={src}
      onLoad={measure}
      className="block w-full border-none bg-white"
    />
  )
}

// ---------------------------------------------------------------------------
// demo section — one per demo, ALL kept mounted (build.ts renders every
// `<section class="demo">` and toggles display, so explainer iframes load once
// and never re-fetch on reopen/switch). Only the active section is visible.
// ---------------------------------------------------------------------------

const DemoSection = ({
  d,
  active,
  explainOpen,
  allShown,
  openBeats,
  explainerLoaded,
  onToggleExplain,
  onCloseExplain,
  onToggleAllBackups,
  onToggleBeat,
  onShot,
}: {
  d: DemoModel
  active: boolean
  explainOpen: boolean
  allShown: boolean
  openBeats: Record<string, boolean>
  explainerLoaded: Record<string, boolean>
  onToggleExplain: () => void
  onCloseExplain: () => void
  onToggleAllBackups: () => void
  onToggleBeat: (key: string) => void
  onShot: (src: string) => void
}) => {
  const canExp = canExplain(d)
  const hasBk = hasBackups(d)
  return (
    <section hidden={!active}>
      {/* PLANNED banner — aspirational demo; must be impossible to mistake for shipping */}
      {d.planned && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border-2 border-amber bg-amber/15 px-4 py-3">
          <span className="rounded bg-amber px-2 py-1 text-[11px] font-extrabold uppercase tracking-widest text-black">
            Planned
          </span>
          <span className="text-[13.5px] font-semibold text-amber">
            Not yet implemented — roadmap preview. The commands below are narrated and shown, NOT run; the
            terminal output is illustrative mock, not a live harness.
          </span>
        </div>
      )}
      {/* compact demo head — one cohesive band: title + status + controls on
          the top line, the gap/wow summary + backstage reset chip beneath it.
          Consolidates the former title row, dashed backstage banner, and
          toolbar row into a single space-efficient group so beats start higher. */}
      <div className="mb-3 flex flex-col gap-1.5">
        {/* line 1: title + status pill (left) · explanation/backups controls (right) */}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <h2 className="m-0 text-lg font-semibold leading-tight">{d.tab}</h2>
          <SummaryPill d={d} />
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {canExp ? (
              <button
                type="button"
                onClick={onToggleExplain}
                className={
                  'cursor-pointer rounded-md border px-2.5 py-1 text-[12px] font-medium ' +
                  (explainOpen
                    ? 'border-accent bg-accent text-accent-fg'
                    : 'border-border bg-bg-panel text-fg-muted hover:border-accent hover:text-fg')
                }
              >
                {explainOpen ? '▾ hide explanation' : '▸ show explanation'}
              </button>
            ) : (
              <span
                title="no explainer page for this demo"
                className="cursor-default rounded-md border border-dashed border-border px-2.5 py-1 text-[12px] font-medium text-fg-faint"
              >
                ▹ no explainer
              </span>
            )}
            {hasBk ? (
              <button
                type="button"
                onClick={onToggleAllBackups}
                className={
                  'cursor-pointer rounded-md border px-2.5 py-1 text-[12px] font-medium ' +
                  (allShown
                    ? 'border-accent bg-accent text-accent-fg'
                    : 'border-border bg-bg-panel text-fg-muted hover:border-accent hover:text-fg')
                }
              >
                {allShown ? '▾ hide all backups' : '▸ show all backups'}
              </button>
            ) : (
              <span
                title="no harness screenshots yet"
                className="cursor-default rounded-md border border-dashed border-border px-2.5 py-1 text-[12px] font-medium text-fg-faint"
              >
                ▹ backups pending
              </span>
            )}
          </div>
        </div>

        {/* line 2: gap/wow summary (muted, secondary) + inline backstage reset chip */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className="m-0 min-w-0 flex-1 text-[12px] leading-snug text-fg-muted">
            <InlineMd line={d.gapwow} />
          </p>
          {d.resetCmd ? (
            <span
              title="backstage — reset between takes, not on camera"
              className="flex flex-none items-center gap-1.5 rounded-md border border-dashed border-border-strong bg-bg-subtle py-0.5 pl-2 pr-1"
            >
              <span className="text-[10px] font-bold uppercase tracking-wider text-amber">Backstage · reset</span>
              <code className="max-w-[240px] overflow-x-auto whitespace-pre rounded bg-bg-code px-1.5 py-0.5 font-mono text-[11.5px] leading-normal text-code-fg">
                {d.resetCmd}
              </code>
              <CopyButton raw={d.resetCmd} variant="inline" />
            </span>
          ) : (
            <span
              title="backstage — not on camera"
              className="flex-none text-[11px] text-fg-faint"
            >
              <span className="font-bold uppercase tracking-wider text-amber">Backstage</span> · no reset script
            </span>
          )}
        </div>
      </div>

      {/* body: instructions ⇄ explanation (both mounted; CSS-toggled full bleed) */}
      <div className={explainOpen ? 'hidden' : 'flex flex-col gap-3'}>
        {d.beats.map((b, i) => {
          const key = `${d.id}::${i}`
          return (
            <BeatCard
              key={key}
              beat={b}
              open={!!openBeats[key]}
              onToggle={() => onToggleBeat(key)}
              onShot={onShot}
            />
          )
        })}
      </div>
      {canExp && (
        <aside
          className={
            explainOpen
              ? 'flex w-full flex-col overflow-hidden rounded-[10px] border border-border bg-bg-panel shadow-[0_8px_30px_rgba(0,0,0,.5)]'
              : 'hidden'
          }
        >
          <div className="flex flex-none items-center justify-between border-b border-border px-3 py-2 text-[12.5px] font-semibold text-fg-muted">
            <span>Explainer · {d.tab}</span>
            <button
              type="button"
              onClick={onCloseExplain}
              className="cursor-pointer rounded-md border border-border bg-bg-subtle px-2.5 py-1 text-[13px] text-fg-muted hover:bg-bg-panel hover:text-fg"
            >
              ✕
            </button>
          </div>
          {/* lazy: src set on first open, then persists (section never unmounts).
              Auto-heights to its content so the page scrolls, never the iframe. */}
          <ExplainerFrame
            title={`${d.tab} explainer`}
            src={explainerLoaded[d.id] ? d.explainerSrc ?? undefined : undefined}
          />
        </aside>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// URL state (reload-safe, shareable). scheme:
//   control.next.html#demo=<id>&view=instructions|explanation&backups=shown|hidden
// ---------------------------------------------------------------------------

interface UiState {
  demo: string
  view: View
  backups: Backups
}

const readUrl = (): UiState => {
  const s: UiState = { demo: TAB_IDS[0]!, view: 'instructions', backups: 'hidden' }
  const p = new URLSearchParams(location.hash.replace(/^#/, ''))
  const demo = p.get('demo')
  if (demo && TAB_IDS.includes(demo)) s.demo = demo
  const view = p.get('view')
  if (view === 'explanation' || view === 'instructions') s.view = view
  const backups = p.get('backups')
  if (backups === 'shown' || backups === 'hidden') s.backups = backups
  return s
}

const normalize = (s: UiState): UiState => {
  // intro is not a demo — it has no explainer, so it is always instructions view
  if (s.demo === INTRO_ID) return { ...s, view: 'instructions' }
  const d = DEMOS.find((x) => x.id === s.demo) ?? DEMOS[0]!
  // can't be in explanation view if the active demo has no explainer
  const view: View = s.view === 'explanation' && !canExplain(d) ? 'instructions' : s.view
  return { ...s, view }
}

const writeUrl = (s: UiState): void => {
  const p = new URLSearchParams()
  p.set('demo', s.demo)
  p.set('view', s.view)
  p.set('backups', s.backups)
  try {
    history.replaceState(null, '', '#' + p.toString())
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// nav tab (shared by solo tabs and grouped members). Shows the explicit
// displayNum (never an array index) and a PLANNED badge for aspirational demos.
// ---------------------------------------------------------------------------

const TabButton = ({ d, on, onClick }: { d: DemoModel; on: boolean; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className={
      on
        ? 'inline-flex items-center rounded-lg border border-accent bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-fg'
        : 'inline-flex items-center rounded-lg border border-border bg-bg-panel px-3 py-1.5 text-[13px] font-medium text-fg-muted hover:border-border-strong hover:text-fg'
    }
  >
    <kbd
      className={
        on
          ? 'mr-1.5 rounded border-transparent bg-white/20 px-1.5 py-0.5 text-[11px]'
          : 'mr-1.5 rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-[11px] text-fg-muted'
      }
    >
      {d.displayNum}
    </kbd>
    {d.tab}
    {d.planned && (
      <span
        title="planned — not yet implemented"
        className="ml-1.5 rounded bg-amber px-1 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-black"
      >
        planned
      </span>
    )}
  </button>
)

// ---------------------------------------------------------------------------
// intro slides (first tab, id "intro") — static presenter-facing "why + how"
// deck for screen sharing. Not a DemoModel: no beats/explainer/backups, so it
// is handled as a special tab alongside DEMOS rather than through the model.
// ---------------------------------------------------------------------------

const INTRO_ID = 'intro'

// Inline actor/motif icons (currentColor → theme-aware). Kept tiny and line-art
// to match the dashboard's restrained visual language.
// Tiny monochrome glyphs for the chat mockup (currentColor → theme-aware).
const g = (d: string): ReactNode => (
  <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)
const gBulb = g('M6 11h4M6.5 13h3M8 2a4 4 0 0 1 2.5 7.2V11h-5V9.2A4 4 0 0 1 8 2z')
const gPencil = g('M11 2.5l2.5 2.5L6 12.5 3 13.5l1-3z')
const gSearch = g('M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM11 11l3 3')
const gChevD = g('M4 6l4 4 4-4')
const gChevR = g('M6 4l4 4-4 4')
const gGlobe = g('M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM1.5 8h13M8 1.5c2 2 2 11 0 13M8 1.5c-2 2-2 11 0 13')

// ---------------------------------------------------------------------------
// Miniature "native UI" mockups — theme-aware; all styling lives in index.css
// under the `.intro` scope. Each is a small faux screenshot of the real thing.
// ---------------------------------------------------------------------------
// mini Notion page — a rendered Notion doc (kit NotionSurface + NotionPage).
const MiniNotionPage = () => (
  <NotionSurface
    workspace="Acme"
    workspaceInitial="A"
    nav={[
      { icon: '◆', label: 'Roadmap', on: true },
      { icon: '▦', label: 'Specs' },
    ]}
  >
    <NotionPage emoji="🚀" heading="Launch roadmap">
      <NotionBlock>Finalize the API spec</NotionBlock>
      <NotionBlock>Ship v1</NotionBlock>
      <NotionBlock>Draft Q3 plan</NotionBlock>
    </NotionPage>
  </NotionSurface>
)

// mini .md file (kit editor, markdown syntax)
const MiniMdFile = () => (
  <KitIDE
    title={<WinTitle icon="≡" file="roadmap.md" />}
    tag="markdown"
    tree={[
      { kind: 'file', label: 'roadmap.md', selected: true },
      { kind: 'file', label: 'spec.md' },
    ]}
    tab={<>roadmap.md</>}
  >
    <CodeLine>
      <KW># </KW>Launch roadmap
    </CodeLine>
    <CodeLine>
      <STR>- [x]</STR> Finalize the API spec
    </CodeLine>
    <CodeLine>
      <Cm>- [ ]</Cm> Ship v1
    </CodeLine>
    <CodeLine> </CodeLine>
  </KitIDE>
)

// mini Notion desktop app (sidebar + page) — users. Built from the shared kit.
const MiniNotionApp = () => (
  <NotionSurface
    workspace="Acme"
    workspaceInitial="A"
    nav={[
      { icon: '◆', label: 'Launch roadmap', on: true },
      { icon: '▦', label: 'API spec' },
      { icon: '✓', label: 'Tasks' },
    ]}
  >
    <NotionPage emoji="🚀" heading="Launch roadmap">
      <NotionBlock>Finalize the API spec</NotionBlock>
      <NotionBlock>Ship v1</NotionBlock>
      <NotionBlock role="recv">Draft Q3 plan</NotionBlock>
    </NotionPage>
  </NotionSurface>
)

// mini Notion agent chat panel (from the reference screenshot) — productivity agents
const MiniChat = () => (
  <div className="iu iu-chat">
    <div className="hd">
      <span className="t">Bug tracker {gChevD}</span>
      <span className="ic">{gChevR}</span>
    </div>
    <div className="bd intro-reveal">
      <div className="bub">Create a bug tracker with the latest feedback</div>
      <div className="stp">
        <span className="g">{gBulb}</span>
        <span>Thought</span>
      </div>
      <div className="stp">
        <span className="g">{gPencil}</span>
        <span>
          Creating <b>Bug Tracker</b>
        </span>
      </div>
      <div className="stp">
        <span className="g">{gSearch}</span>
        <span>118 results</span>
        <span className="chips">
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="resp">All set — pulling issues from Slack, Notion &amp; email; duplicates grouped.</div>
      <div className="inp">
        <span className="g">{gGlobe}</span>
        <span className="src">All sources</span>
        <span className="snd">↑</span>
      </div>
    </div>
  </div>
)

// mini IDE (file tree + code) — developers (kit editor)
const MiniIDE = () => (
  <KitIDE
    title={<WinTitle icon="{ }" file="sync.ts" />}
    tag="editor"
    tree={[
      { kind: 'fold', label: 'src' },
      { kind: 'file', label: 'notion.ts' },
      { kind: 'file', label: 'sync.ts', selected: true },
    ]}
    tab={<>sync.ts</>}
  >
    <CodeLine>
      <KW>import</KW>
      {' { db } '}
      <KW>from</KW> <STR>'./notion'</STR>
    </CodeLine>
    <CodeLine>
      <KW>await</KW> db.<At>sync</At>()
    </CodeLine>
    <CodeLine>
      <Cm>{'// typed · guarded'}</Cm>
    </CodeLine>
    <CodeLine role="recv">
      <Cm>{'✓ 12 rows in sync'}</Cm>
    </CodeLine>
  </KitIDE>
)

// mini Claude Code terminal (agent edits a LOCAL file → reflects to Notion) — coding agents
const MiniTerminal = () => (
  <Terminal title={<WinTitle icon="❯_" file="claude code" />}>
    <TerminalLine>
      <Prompt /> edit roadmap.md
    </TerminalLine>
    <TerminalLine out>reading local files…</TerminalLine>
    <TerminalLine out>
      <span className="ok">+ - [x] Ship v1</span>
    </TerminalLine>
    <TerminalLine out>→ reflected to Notion</TerminalLine>
  </Terminal>
)

// mini workflow graph (Notion ⇄ external systems) — automations. No kit
// equivalent, so bespoke SVG inside kit window chrome; styled app-side (.pflow).
const MiniFlow = () => (
  <MacWindow title={<WinTitle icon="⚙" label="automations" />}>
    <div className="pflow">
      <svg viewBox="0 0 120 62" preserveAspectRatio="xMidYMid meet">
        <path className="ed" d="M40 31 H82" />
        <path className="ed" d="M40 27 C60 20 64 14 84 13" />
        <path className="ed" d="M40 35 C60 42 64 48 84 49" />
        <rect className="nd hub" x="14" y="19" width="26" height="24" rx="4" />
        <path className="gl hub" d="M20 26h14M20 31h14M20 36h9" />
        <g transform="translate(84,6)">
          <rect className="nd" x="0" y="0" width="22" height="14" rx="3" />
          <path className="gl" d="M5 5h12M5 8h12M5 11h7" />
        </g>
        <g transform="translate(84,24)">
          <rect className="nd" x="0" y="0" width="22" height="14" rx="3" />
          <circle className="gl" cx="11" cy="7" r="3.4" />
          <path className="gl" d="M11 2.4v1.6M11 10v1.6M15.6 7h-1.6M8 7H6.4" />
        </g>
        <g transform="translate(84,42)">
          <rect className="nd" x="0" y="0" width="22" height="14" rx="3" />
          <path className="gl" d="M3.5 4h15v6h-15zM3.5 4l7.5 4.5L18.5 4" />
        </g>
        <circle className="pulse" cx="60" cy="31" r="2.4" />
        <circle className="pulse p2" cx="62" cy="20" r="2.4" />
        <circle className="pulse p3" cx="62" cy="42" r="2.4" />
      </svg>
    </div>
  </MacWindow>
)

// mini Notion database grid. `flip` renders a Status cell that animates
// Todo→Done while the parent sqlite pair is hovered.
const MiniDbGrid = ({ flip = false }: { flip?: boolean }) => (
  <DbBrowser
    title={<WinTitle icon="▦" file="tasks.db" />}
    tables={[
      { name: 'pages', icon: '▦', selected: true },
      { name: 'changes', icon: '≡' },
    ]}
  >
    <table className="dbb-grid">
      <thead>
        <tr>
          <th className="gut"> </th>
          <th>Name</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td className="gut">1</td>
          <td>Ship v1</td>
          <td>
            {flip === true ? (
              <span className="swap">
                <span className="s-was">
                  <span className="st st-prog">Todo</span>
                </span>
                <span className="s-now">
                  <span className="st st-done">Done</span>
                </span>
              </span>
            ) : (
              <span className="st st-done">Done</span>
            )}
          </td>
        </tr>
        <tr>
          <td className="gut">2</td>
          <td>Fix deploy</td>
          <td>
            <span className="st st-prog">In&nbsp;Progress</span>
          </td>
        </tr>
        <tr>
          <td className="gut">3</td>
          <td>Draft plan</td>
          <td>
            <span className="st st-prog">Todo</span>
          </td>
        </tr>
      </tbody>
    </table>
  </DbBrowser>
)

// mini SQL terminal (plain SQL edit → lands in Notion) — sqlite
const MiniSqlTerm = () => (
  <Terminal title={<WinTitle icon="❯_" file="sqlite3 tasks.db" />}>
    <TerminalLine>
      <span className="sq">sqlite&gt;</span> <span className="kw">UPDATE</span> pages
    </TerminalLine>
    <TerminalLine>
      {'   '}
      <span className="kw">SET</span> status = <span className="str">'Done'</span>;
    </TerminalLine>
    <TerminalLine out>1 row updated · pushed to Notion</TerminalLine>
  </Terminal>
)

// mini generated schema.ts (kit editor) — schema codegen
const MiniSchemaCode = () => (
  <KitIDE
    title={<WinTitle icon="{ }" file="schema.gen.ts" />}
    tag="generated"
    tree={[
      { kind: 'file', label: 'schema.gen.ts', selected: true },
      { kind: 'file', label: 'people.gen.ts' },
    ]}
    tab={<>schema.gen.ts</>}
  >
    <CodeLine>
      <Cm>{'// generated from Tasks'}</Cm>
    </CodeLine>
    <CodeLine>
      <KW>export const</KW> <At>Status</At> =
    </CodeLine>
    <CodeLine>
      {'  '}
      <At>Schema</At>.<At>Literal</At>(
    </CodeLine>
    <CodeLine>
      {'    '}
      <STR>'Todo'</STR>, <STR>'Doing'</STR>, <STR>'Done'</STR>)
    </CodeLine>
  </KitIDE>
)

// mini JSX page component (kit editor) — notion-react
const MiniJsx = () => (
  <KitIDE
    title={<WinTitle icon="{ }" file="page.tsx" />}
    tag="react"
    tree={[{ kind: 'file', label: 'page.tsx', selected: true }]}
    tab={<>page.tsx</>}
  >
    <CodeLine>
      <KW>const</KW> <At>Page</At> = () =&gt;
    </CodeLine>
    <CodeLine>
      {'  '}&lt;<At>Toggle</At> <KW>title</KW>=<STR>"Q3"</STR>&gt;
    </CodeLine>
    <CodeLine>
      {'    '}&lt;<At>Text</At>&gt;budget…&lt;/&gt;
    </CodeLine>
    <CodeLine>
      {'  '}&lt;/<At>Toggle</At>&gt;
    </CodeLine>
  </KitIDE>
)
const iconNotion = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="3.5" width="14" height="17" rx="2" />
    <path d="M9 8h6M9 12h6M9 16h4" />
  </svg>
)
const iconLego = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3.5" y="9" width="17" height="10.5" rx="1.5" />
    <path d="M7.5 9V7.2a1.5 1.5 0 0 1 3 0V9M13.5 9V7.2a1.5 1.5 0 0 1 3 0V9" />
  </svg>
)

// Hand-drawn (whiteboard-sketch) two-way arrow linking one actor to the Notion
// hub. Inline SVG; stroke follows the accent token (theme-aware). `vertical`
// rotates it (used for the automations node below the hub).
const HandArrow = ({ vertical = false }: { vertical?: boolean }) => (
  <svg
    className={vertical === true ? 'intro-hand v' : 'intro-hand'}
    width="44"
    height="24"
    viewBox="0 0 44 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.9}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 11 C16 8, 28 15, 38 12" />
    <path d="M33.5 8 L38.5 12 L33 15.5" />
    <path d="M10.5 8 L5.5 12 L11 15.5" />
  </svg>
)

// Slide-1 actor card: a miniature native-UI mockup + name + one-line role. `re`
// right-aligns the caption for the Engineering column.
const ActorCard = ({ mock, name, role, re = false }: { mock: ReactNode; name: string; role: string; re?: boolean }) => (
  <div className={re === true ? 'intro-actor re' : 'intro-actor'}>
    {mock}
    <span className="cap">
      <span className="nm">{name}</span>
      <span className="rl">{role}</span>
    </span>
  </div>
)

// Slide-2 single connector: a direction glyph + action label + a hover token
// that travels between the two mockups (animation keyed off the pair class).
const Conn = ({ dir, action }: { dir: string; action: string }) => (
  <div className="intro-arrow">
    <span className="tok" />
    <span className="gl">{dir}</span>
    <span className="ac">{action}</span>
  </div>
)

// Slide-2 block card: lego header (num + name) + a paired mockup + description.
const BlockCard = ({ num, name, desc, children }: { num: string; name: string; desc: string; children: ReactNode }) => (
  <div className="flex flex-col gap-3 rounded-xl border border-border bg-bg-subtle p-5">
    <div className="flex items-center gap-2.5">
      <span className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-md bg-accent/10 text-accent">
        {iconLego}
      </span>
      <span className="font-mono text-[11px] font-bold text-fg-faint">{num}</span>
      <span className="font-mono text-[15.5px] font-semibold">{name}</span>
    </div>
    {children}
    <p className="m-0 text-[13px] leading-snug text-fg-muted">{desc}</p>
  </div>
)

const IntroPanel = ({ hidden }: { hidden: boolean }) => (
  <section hidden={hidden} className="intro flex max-w-[1120px] flex-col gap-4">
    {/* Slide 1 — Why: the ecosystem around Notion (hub = source of truth) */}
    <section className="rounded-2xl border border-border bg-bg-panel px-8 py-7 shadow-[0_6px_24px_rgba(10,14,20,.10)]">
      <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[1.2px] text-accent">Why</div>
      <h2 className="m-0 mb-6 text-[25px] font-bold tracking-tight">Notion, for users, developers, and agents</h2>
      <div className="flex flex-wrap items-stretch justify-center gap-2">
        {/* Knowledge work — each actor has its own hand-drawn arrow to the hub */}
        <div className="flex min-w-[290px] flex-1 flex-col gap-2.5">
          <div className="text-[10.5px] font-bold uppercase tracking-wider text-fg-faint">Knowledge work</div>
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <ActorCard mock={<MiniNotionApp />} name="users" role="author · plan, in Notion" />
            </div>
            <HandArrow />
          </div>
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <ActorCard mock={<MiniChat />} name="productivity agents" role="assist in-place" />
            </div>
            <HandArrow />
          </div>
        </div>
        {/* Notion hub */}
        <div className="flex min-w-[144px] flex-col items-center justify-center rounded-2xl border-2 border-accent/50 bg-accent/5 px-6 py-5 text-center">
          <span className="mb-1.5 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-fg text-bg-panel">
            {iconNotion}
          </span>
          <span className="text-[16px] font-bold leading-tight">Notion</span>
          <span className="text-[11px] leading-tight text-fg-muted">source of truth</span>
        </div>
        {/* Engineering */}
        <div className="flex min-w-[290px] flex-1 flex-col gap-2.5">
          <div className="text-right text-[10.5px] font-bold uppercase tracking-wider text-fg-faint">Engineering</div>
          <div className="flex items-center gap-1.5">
            <HandArrow />
            <div className="min-w-0 flex-1">
              <ActorCard re mock={<MiniIDE />} name="developers" role="integrate code — reliable & ergonomic" />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <HandArrow />
            <div className="min-w-0 flex-1">
              <ActorCard re mock={<MiniTerminal />} name="coding agents" role="local files (md · sqlite), not APIs" />
            </div>
          </div>
        </div>
      </div>
      {/* automations & integrations — its own arrow up to the hub */}
      <div className="mt-2 flex flex-col items-center gap-1">
        <HandArrow vertical />
        <div className="flex w-full max-w-[440px] items-center gap-3.5 rounded-2xl border border-dashed border-border-strong bg-bg-subtle p-3">
          <div className="w-[200px] flex-none">
            <MiniFlow />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">automations &amp; integrations</div>
            <div className="text-[11.5px] leading-snug text-fg-muted">read &amp; write the same Notion source of truth</div>
          </div>
        </div>
      </div>
    </section>
    {/* Slide 2 — How: building blocks that snap together */}
    <section className="rounded-2xl border border-border bg-bg-panel px-8 py-7 shadow-[0_6px_24px_rgba(10,14,20,.10)]">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[1.2px] text-accent">
        <span className="text-accent">{iconLego}</span> How
      </div>
      <h2 className="m-0 mb-5 text-[25px] font-bold tracking-tight">Building blocks that snap together</h2>
      <div className="flex flex-col gap-4">
        <BlockCard num="01" name="notion md" desc="Edit Notion pages as local Markdown — two-way, conflict-guarded sync from your editor.">
          <div className="intro-pair md">
            <div className="side">
              <MiniNotionPage />
            </div>
            <Conn dir="⇄" action="two-way sync" />
            <div className="side">
              <MiniMdFile />
            </div>
          </div>
        </BlockCard>
        <BlockCard num="02" name="notion sqlite" desc="A Notion database bound to a live local SQLite file — query and edit it with plain SQL.">
          <div className="intro-pair sqlite">
            <div className="side">
              <MiniDbGrid flip />
            </div>
            <Conn dir="⇄" action="SQL query + edit" />
            <div className="side">
              <MiniSqlTerm />
            </div>
          </div>
        </BlockCard>
        <BlockCard
          num="03"
          name="notion schema"
          desc="A round-trip: generate typed Effect schemas from the live DB (codegen), and provision the DB from code (IaC)."
        >
          <div className="intro-pair schema">
            <div className="side">
              <MiniDbGrid />
            </div>
            <div className="intro-arrows2">
              <div className="ar cg">
                <span className="lab">codegen</span>
                <span className="line">
                  <span className="tok" />
                </span>
              </div>
              <div className="ar iac">
                <span className="line">
                  <span className="tok" />
                </span>
                <span className="lab">IaC apply</span>
              </div>
            </div>
            <div className="side">
              <MiniSchemaCode />
            </div>
          </div>
        </BlockCard>
        <BlockCard num="04" name="notion-react" desc="Author a Notion page as a React component; rerun renders a precise block-level diff.">
          <div className="intro-pair react">
            <div className="side">
              <MiniJsx />
            </div>
            <Conn dir="→" action="render" />
            <div className="side">
              <MiniNotionPage />
            </div>
          </div>
        </BlockCard>
      </div>
    </section>
  </section>
)

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

export const App = () => {
  const [state, setState] = useState<UiState>(() => normalize(readUrl()))
  const active = DEMOS.find((d) => d.id === state.demo) ?? DEMOS[0]!

  // per-beat backup disclosure (local; keyed by demoId::index). The master
  // "show all backups" toggle (URL-backed) sets every active-demo beat at once;
  // per-beat toggles flip a single beat without touching the URL master state.
  const seedOpen = (demoId: string, shown: boolean): Record<string, boolean> => {
    const out: Record<string, boolean> = {}
    const d = DEMOS.find((x) => x.id === demoId)
    d?.beats.forEach((_, i) => {
      out[`${demoId}::${i}`] = shown
    })
    return out
  }
  const [openBeats, setOpenBeats] = useState<Record<string, boolean>>(() =>
    seedOpen(state.demo, state.backups === 'shown'),
  )

  // explainer iframes are lazy: only mount src once the demo has been explained.
  const [explainerLoaded, setExplainerLoaded] = useState<Record<string, boolean>>({})

  // lightbox
  const [lightbox, setLightbox] = useState<string | null>(null)

  // commit: normalize, persist to URL, and re-apply master backups to the
  // (possibly new) active demo — mirrors build.ts applyState().
  const commit = useCallback((next: UiState) => {
    const norm = normalize(next)
    setState(norm)
    if (norm.view === 'explanation') setExplainerLoaded((m) => ({ ...m, [norm.demo]: true }))
    setOpenBeats(seedOpen(norm.demo, norm.backups === 'shown'))
    writeUrl(norm)
  }, [])

  // init: write normalized URL, seed explainer if starting in explanation view.
  useEffect(() => {
    writeUrl(state)
    if (state.view === 'explanation') setExplainerLoaded((m) => ({ ...m, [state.demo]: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // respond to external hash changes (shared/reloaded links, back/forward)
  useEffect(() => {
    const onHash = () => commit(readUrl())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [commit])

  const onIntro = state.demo === INTRO_ID
  const setDemo = (id: string) => commit({ ...state, demo: id })
  const toggleExplain = useCallback(() => {
    if (state.demo === INTRO_ID || !canExplain(active)) return
    commit({ ...state, view: state.view === 'explanation' ? 'instructions' : 'explanation' })
  }, [active, state, commit])
  const closeExplain = () => commit({ ...state, view: 'instructions' })
  const toggleAllBackups = () => {
    if (onIntro || !hasBackups(active)) return
    commit({ ...state, backups: state.backups === 'shown' ? 'hidden' : 'shown' })
  }
  const toggleBeat = (key: string) => setOpenBeats((m) => ({ ...m, [key]: !m[key] }))

  // keyboard: 1..N tabs, e explainer, Esc closes lightbox
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && lightbox !== null) {
        setLightbox(null)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      if (e.key === '0') {
        commit({ ...state, demo: INTRO_ID })
        return
      }
      const members = KEY_MAP[e.key]
      if (members && members.length > 0) {
        if (members.length === 1) {
          commit({ ...state, demo: members[0]!.id })
        } else {
          // group key: first press → first member; repeat → cycle to next member
          const idx = members.findIndex((m) => m.id === state.demo)
          const next = idx === -1 ? members[0]! : members[(idx + 1) % members.length]!
          commit({ ...state, demo: next.id })
        }
        return
      }
      if (e.key === 'e') toggleExplain()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox, state, commit, toggleExplain])

  // theme toggle: data-theme on <html> wins over prefers-color-scheme.
  // Matches control.html — NOT persisted across reloads.
  const toggleTheme = () => {
    const el = document.documentElement
    const cur = el.getAttribute('data-theme')
    const sysDark = matchMedia('(prefers-color-scheme:dark)').matches
    const next = cur ? (cur === 'dark' ? 'light' : 'dark') : sysDark ? 'light' : 'dark'
    el.setAttribute('data-theme', next)
  }

  const explainOpen = state.view === 'explanation'
  const allShown = state.backups === 'shown'

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-border bg-bg-panel px-5 py-2.5">
        <h1 className="m-0 text-[15px] font-semibold tracking-tight">
          <span className="text-accent">●</span> Live Control{' '}
          <span className="font-normal text-fg-faint">· Notion tooling demos (next)</span>
        </h1>
        <div className="flex-1" />
        <span className="text-xs text-fg-faint">
          keys <kbd className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-fg-muted">0</kbd> intro ·{' '}
          <kbd className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-fg-muted">1</kbd>–
          <kbd className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-fg-muted">{MAX_KEY}</kbd>{' '}
          demos (<kbd className="rounded border border-border bg-bg-subtle px-1 py-0.5 text-fg-muted">3</kbd>{' '}
          cycles 3.1/3.2) ·{' '}
          <kbd className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-fg-muted">e</kbd> explainer
        </span>
        <button
          type="button"
          onClick={toggleTheme}
          className="cursor-pointer rounded-md border border-border bg-bg-subtle px-2.5 py-1 text-xs text-fg-muted hover:text-fg"
        >
          ◐ theme
        </button>
      </header>

      <nav className="sticky top-[41px] z-10 flex flex-wrap items-center gap-1.5 border-b border-border bg-bg px-5 py-2">
        <button
          type="button"
          onClick={() => setDemo(INTRO_ID)}
          className={
            onIntro
              ? 'inline-flex items-center rounded-lg border border-accent bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-fg'
              : 'inline-flex items-center rounded-lg border border-border bg-bg-panel px-3 py-1.5 text-[13px] font-medium text-fg-muted hover:border-border-strong hover:text-fg'
          }
        >
          <kbd
            className={
              onIntro
                ? 'mr-1.5 rounded border-transparent bg-white/20 px-1.5 py-0.5 text-[11px]'
                : 'mr-1.5 rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-[11px] text-fg-muted'
            }
          >
            0
          </kbd>
          Intro
        </button>
        {NAV_ITEMS.map((item) => {
          if (item.kind === 'solo') {
            const d = item.demo
            return <TabButton key={d.id} d={d} on={d.id === state.demo} onClick={() => setDemo(d.id)} />
          }
          return (
            <div
              key={item.groupId}
              className="inline-flex items-center gap-1 rounded-xl border border-dashed border-border-strong bg-bg-subtle px-1.5 py-1"
            >
              <span className="px-1 text-[10px] font-bold uppercase tracking-wider text-fg-faint">{item.label}</span>
              {item.members.map((d) => (
                <TabButton key={d.id} d={d} on={d.id === state.demo} onClick={() => setDemo(d.id)} />
              ))}
            </div>
          )
        })}
      </nav>

      <main className="px-5 pb-16 pt-4">
        <IntroPanel hidden={!onIntro} />
        {DEMOS.map((d) => (
          <DemoSection
            key={d.id}
            d={d}
            active={d.id === state.demo}
            explainOpen={d.id === state.demo && explainOpen && canExplain(d)}
            allShown={allShown}
            openBeats={openBeats}
            explainerLoaded={explainerLoaded}
            onToggleExplain={toggleExplain}
            onCloseExplain={closeExplain}
            onToggleAllBackups={toggleAllBackups}
            onToggleBeat={toggleBeat}
            onShot={setLightbox}
          />
        ))}
      </main>

      {/* lightbox */}
      {lightbox !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(4,6,10,.86)] p-7"
          onClick={(e) => {
            if (e.target === e.currentTarget) setLightbox(null)
          }}
        >
          <button
            type="button"
            aria-label="Close (Esc)"
            onClick={() => setLightbox(null)}
            className="fixed right-5 top-4 flex h-[38px] w-[38px] cursor-pointer items-center justify-center rounded-[9px] border border-white/25 bg-white/10 text-[17px] text-white hover:bg-white/25"
          >
            ✕
          </button>
          <img
            src={lightbox}
            alt=""
            className="max-h-[92vh] max-w-[96vw] rounded-lg bg-white shadow-[0_24px_70px_rgba(0,0,0,.6)]"
          />
        </div>
      )}
    </div>
  )
}
