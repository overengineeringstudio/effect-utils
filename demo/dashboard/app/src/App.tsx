import { Fragment, type FC, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { RawSegment } from '../../screenplay.ts'
import { DEMOS, type DemoModel, type ModelBeat, type Shot } from './model.gen.ts'
import { InlineMd } from './inline-md.tsx'
import { Agentation } from 'agentation'
import {
  At,
  CodeLine,
  Cm,
  DbBrowser,
  KW,
  MacWindow,
  MiniIDE as KitIDE,
  NotionPage,
  NotionSurface,
  Prompt,
  STR,
  Terminal,
  TerminalLine,
  WinTitle,
} from '../../kit/index.ts'
import { EXPLAINERS } from '../../explainers/src/registry.tsx'

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

// Inline explainer components, keyed by demo id (registry id === demo id for the
// ported explainers). A demo is "explainable" iff a React explainer is registered
// here — NOT whether a legacy .html exists — so unported demos (schema/react)
// still fall through to the graceful "no explainer" affordance.
const EXPLAINER_BY_ID: Record<string, FC> = Object.fromEntries(EXPLAINERS.map((e) => [e.id, e.Component]))
const canExplain = (d: DemoModel): boolean => d.id in EXPLAINER_BY_ID

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
    <article className="border-t border-border py-4">
      <div className="mb-2 flex items-center gap-2.5">
        <span className="whitespace-nowrap text-[11px] text-fg-faint">
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
// (The former ExplainerFrame iframe + scrollHeight auto-height machinery was
// removed: explainers now render INLINE as React components — see EXPLAINER_BY_ID
// and the `.explainer-root` embed in DemoSection below. No iframe, no .next.html.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// demo section — one per demo, ALL kept mounted (build.ts renders every
// `<section class="demo">` and toggles display, so explainer iframes load once
// and never re-fetch on reopen/switch). Only the active section is visible.
// ---------------------------------------------------------------------------

const DemoSection = ({
  d,
  active,
  explainOpen,
  openBeats,
  onToggleExplain,
  onCloseExplain,
  onToggleBeat,
  onShot,
}: {
  d: DemoModel
  active: boolean
  explainOpen: boolean
  openBeats: Record<string, boolean>
  onToggleExplain: () => void
  onCloseExplain: () => void
  onToggleBeat: (key: string) => void
  onShot: (src: string) => void
}) => {
  const canExp = canExplain(d)
  const Explainer = EXPLAINER_BY_ID[d.id]
  return (
    <section hidden={!active}>
      {/* Planned/mock demos (e.g. 3.2) stay labelled per-beat via StatusBadge
          'mock' + narrated mock output (R8); the former heavy amber banner was
          removed per design feedback. */}
      {/* view switcher — Instructions ⇄ Explanation, Notion-native underline tabs */}
      {canExp && (
        <div className="mb-4 flex items-center gap-1 border-b border-border text-[13px]">
          <button
            type="button"
            onClick={() => {
              if (explainOpen) onCloseExplain()
            }}
            className={
              explainOpen
                ? '-mb-px cursor-pointer border-b-2 border-transparent px-3 py-2 text-fg-muted hover:text-fg'
                : '-mb-px border-b-2 border-accent px-3 py-2 font-medium text-fg'
            }
          >
            Instructions
          </button>
          <button
            type="button"
            onClick={() => {
              if (!explainOpen) onToggleExplain()
            }}
            className={
              explainOpen
                ? '-mb-px border-b-2 border-accent px-3 py-2 font-medium text-fg'
                : '-mb-px cursor-pointer border-b-2 border-transparent px-3 py-2 text-fg-muted hover:text-fg'
            }
          >
            Explanation
          </button>
        </div>
      )}

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
          className={explainOpen ? 'flex w-full flex-col' : 'hidden'}
        >
          {/* Explainer header bar removed per design feedback — close is still
              reachable via the Instructions/Explanation tabs above + the `e` key. */}
          {/* Inline React explainer — the SAME component the standalone page
              renders, scoped under `.explainer-root x-<id>` so the kit CSS +
              explainer tokens resolve without leaking into the dashboard chrome.
              Mounted only while open so the step players' timers stay idle when
              the explanation view is closed. */}
          {explainOpen && Explainer && (
            <div className={`explainer-root x-${d.id} overflow-x-auto`}>
              <Explainer />
            </div>
          )}
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
  // default to the explanation (explainer) view; normalize() keeps intro / no-explainer demos on instructions
  const s: UiState = { demo: TAB_IDS[0]!, view: 'explanation', backups: 'hidden' }
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

// Notion-native tab: plain text, no pill/box. Active reads via ink weight + a
// single accent underline; the keyboard index is a hair-thin mono glyph, not a
// boxed kbd. `-mb-px` drops the underline onto the nav's own bottom hairline.
const TabButton = ({ d, on, onClick }: { d: DemoModel; on: boolean; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className={
      on
        ? '-mb-px inline-flex items-center gap-1.5 border-b-2 border-accent px-3 py-2.5 text-[13px] font-medium text-fg'
        : '-mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2.5 text-[13px] text-fg-muted hover:text-fg'
    }
  >
    <kbd className={`border-0 bg-transparent p-0 font-mono text-[11px] ${on ? 'text-accent' : 'text-fg-faint'}`}>
      {d.displayNum}
    </kbd>
    {d.tab}
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
// A Notion to-do block (bespoke, app-side — NOT a kit restyle so it can't leak
// into other kit surfaces). `done` = checked + strikethrough; `k` keys hover anims.
const Todo = ({ done = false, k, children }: { done?: boolean; k?: string; children: ReactNode }) => (
  <div className={done === true ? 'blk todo done' : 'blk todo'} data-k={k}>
    <span className="cbx" aria-hidden="true" />
    <span className="lbl">{children}</span>
  </div>
)

// mini Notion page — a rendered Notion doc. Shares its to-do list 1:1 with the
// .md pane (block 01) so the sync animation shows the SAME item flip on both ends.
const MiniNotionPage = () => (
  <NotionSurface
    title={notionTitle}
    workspace="Acme"
    workspaceInitial="A"
    nav={[
      { icon: '◆', label: 'Roadmap', on: true },
      { icon: '▦', label: 'Specs' },
    ]}
  >
    <NotionPage emoji="🚀" heading="Launch roadmap">
      <Todo done k="fin">Finalize the API spec</Todo>
      <Todo k="ship">Ship v1</Todo>
    </NotionPage>
  </NotionSurface>
)

// mini .md file (kit editor, markdown syntax) — same to-do list as MiniNotionPage.
const MiniMdFile = () => (
  <KitIDE
    title={<WinTitle icon={mdLogo} file="roadmap.md" />}
    tag=""
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
      <span className="mdcheck" data-k="ship">
        <Cm>- [ ]</Cm> Ship v1
      </span>
    </CodeLine>
    <CodeLine> </CodeLine>
  </KitIDE>
)

// mini Notion desktop app (sidebar + page) — users. A real to-do list, one done.
const MiniNotionApp = () => (
  <NotionSurface
    title={notionTitle}
    workspace="Acme"
    workspaceInitial="A"
    nav={[
      { icon: '◆', label: 'Launch roadmap', on: true },
      { icon: '▦', label: 'API spec' },
      { icon: '✓', label: 'Tasks' },
    ]}
  >
    <NotionPage emoji="🚀" heading="Launch roadmap">
      <Todo done>Finalize the API spec</Todo>
      <Todo k="user">Ship v1</Todo>
      <Todo>Draft Q3 plan</Todo>
    </NotionPage>
  </NotionSurface>
)

// source-chip glyphs for the agent's "118 results" row (monochrome silhouettes)
const chipSlack = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="10.5" y="2" width="3" height="9" rx="1.5" />
    <rect x="10.5" y="13" width="3" height="9" rx="1.5" />
    <rect x="2" y="10.5" width="9" height="3" rx="1.5" />
    <rect x="13" y="10.5" width="9" height="3" rx="1.5" />
  </svg>
)
const chipMail = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
    <path d="M3 6l9 6 9-6" />
  </svg>
)

// mini Notion agent chat panel — productivity agents. The climax is a real Notion
// database materializing (the "built IN Notion" payoff), keyed for the hover anim.
const MiniChat = () => (
  <div className="iu iu-chat">
    <div className="hd">
      <span className="t">
        <NotionChip size={11} /> Bug tracker {gChevD}
      </span>
      <span className="hdi">
        {gPencil}
        {gSearch}
        {gChevR}
      </span>
    </div>
    <div className="bd">
      <div className="bub">Create a bug tracker with the latest feedback</div>
      <div className="stp">
        <span className="g">{gBulb}</span>
        <span>Thought</span>
        <span className="cv">{gChevR}</span>
      </div>
      <div className="stp">
        <span className="g">{gPencil}</span>
        <span>
          Creating database <b>Bug Tracker</b>
        </span>
        <span className="cv">{gChevR}</span>
      </div>
      <div className="stp">
        <span className="g">{gSearch}</span>
        <span>118 results</span>
        <span className="chips">
          <i className="ntn">
            <NotionMark size={9} />
          </i>
          <i>{chipSlack}</i>
          <i>{chipMail}</i>
        </span>
        <span className="cv">{gChevR}</span>
      </div>
      {/* the built artifact — an actual Notion database (this is the payoff) */}
      <div className="art">
        <div className="art-hd">
          <NotionChip size={9} /> Bug Tracker
        </div>
        <table className="art-tbl">
          <tbody>
            <tr>
              <td>Login crash</td>
              <td>
                <span className="st st-prog">P1</span>
              </td>
            </tr>
            <tr>
              <td>Slow search</td>
              <td>
                <span className="st st-done">P2</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="resp">All set — your bug tracker is live in Notion, pulling from Slack, Notion &amp; email; duplicates grouped.</div>
      <div className="inp">
        <span className="ph">Now, let's assign owners and draft a doc per task</span>
        <span className="tools">
          <span className="g">{gGlobe}</span>
          <span className="src">All sources</span>
          <span className="snd">↑</span>
        </span>
      </div>
    </div>
  </div>
)

// mini IDE (file tree + code) — developers (kit editor)
const MiniIDE = () => (
  <KitIDE
    title={<WinTitle icon="{ }" file="sync.ts" />}
    tag=""
    tree={[
      { kind: 'fold', label: 'src' },
      { kind: 'file', label: 'notion.ts' },
      { kind: 'file', label: 'sync.ts', selected: true },
    ]}
    tab={<>sync.ts</>}
  >
    <CodeLine>
      <KW>import</KW> {'{ '}
      <At>Roadmap</At>
      {' } '}
      <KW>from</KW> <STR>'@acme/notion'</STR>
    </CodeLine>
    <CodeLine>
      <KW>const</KW> db = <At>Roadmap</At>.<At>open</At>()
    </CodeLine>
    <CodeLine>
      <span className="edit" data-k="dev">
        <KW>await</KW> db.tasks.<At>set</At>(<STR>'Ship v1'</STR>, <STR>'Done'</STR>)
      </span>
    </CodeLine>
    <CodeLine role="recv">
      <Cm>{'✓ synced to Notion · 12 rows guarded'}</Cm>
    </CodeLine>
  </KitIDE>
)

// mini Claude Code terminal — agent edits a LOCAL file, Notion reflects downstream.
// Banner is open-right (the ✻ line is ambiguous-width; a tight right border would
// mis-align). Banner lines kept ≤26 chars so nothing wraps at the card width.
const MiniTerminal = () => (
  <Terminal title={<WinTitle icon="❯_" file="claude code" />}>
    <div className="cc-banner">
      <div>╭────────────────────────</div>
      <div>
        │ <span className="cc-star">✻</span> Welcome to Claude Code
      </div>
      <div>│</div>
      <div>│ /help · cwd: ~/acme</div>
      <div>╰────────────────────────</div>
    </div>
    <TerminalLine>
      <Prompt /> mark Ship v1 done on the roadmap
    </TerminalLine>
    <TerminalLine out>
      <span className="cc-tool">⏺ Update(</span>
      <span className="cc-file" data-k="cc">roadmap.md</span>
      <span className="cc-tool">)</span>
    </TerminalLine>
    <TerminalLine out>
      <span className="cc-ln">⎿ </span> <span className="del">- [ ] Ship v1</span>
    </TerminalLine>
    <TerminalLine out>
      {'   '}
      <span className="add" data-k="cc2">+ [x] Ship v1</span>
    </TerminalLine>
    <TerminalLine out>
      <span className="recvln" data-k="cc3">→ reflected to Notion ✓</span>
    </TerminalLine>
  </Terminal>
)

// mini workflow graph (Notion ⇄ external systems) — automations. No kit
// equivalent, so bespoke SVG inside kit window chrome; styled app-side (.pflow).
const MiniFlow = () => (
  <MacWindow title={<WinTitle icon="⚙" label="automations" />}>
    <div className="pflow">
      <svg viewBox="0 0 120 62" preserveAspectRatio="xMidYMid meet">
        {/* edges (Notion hub ⇄ systems) + outbound/return dash-flow overlays */}
        <path className="ed" d="M38 31 H84" />
        <path className="ed" d="M38 28 C58 22 64 14 86 13" />
        <path className="ed" d="M38 34 C58 40 64 48 86 49" />
        <path className="flow out e1" d="M38 31 H84" />
        <path className="flow back e1" d="M38 31 H84" />
        <path className="flow out e2" d="M38 28 C58 22 64 14 86 13" />
        <path className="flow back e2" d="M38 28 C58 22 64 14 86 13" />
        <path className="flow out e3" d="M38 34 C58 40 64 48 86 49" />
        <path className="flow back e3" d="M38 34 C58 40 64 48 86 49" />
        {/* database cylinder */}
        <g transform="translate(86,6)">
          <rect className="nd" x="0" y="0" width="22" height="14" rx="3" />
          <ellipse className="gl" cx="11" cy="4.5" rx="5" ry="1.6" />
          <path className="gl" d="M6 4.5v5c0 .9 2.2 1.6 5 1.6s5-.7 5-1.6v-5" />
        </g>
        {/* message / webhook bubble */}
        <g transform="translate(86,24)">
          <rect className="nd" x="0" y="0" width="22" height="14" rx="3" />
          <path className="gl" d="M4 3.6h14v5H9l-2.5 2v-2H4z" />
        </g>
        {/* email envelope */}
        <g transform="translate(86,42)">
          <rect className="nd" x="0" y="0" width="22" height="14" rx="3" />
          <path className="gl" d="M4 4h14v6H4zM4 4l7 4.5L18 4" />
        </g>
      </svg>
      <span className="pflow-hub">
        <NotionChip size={13} />
      </span>
    </div>
  </MacWindow>
)

// mini Notion DATABASE (a Notion surface, NOT SQLite chrome) — the shared left
// side of the sqlite + schema blocks. `flip`/`react` animate a Status pill when
// the arriving edit/IaC token lands here. This is what makes Notion visible.
// a status-pill crossfade (was→now) keyed for the two-way sqlite sync animation.
const SqSwap = ({ k, was, wasCls, now }: { k: string; was: string; wasCls: string; now: string }) => (
  <span className={'swap ' + k}>
    <span className="s-was">
      <span className={'st ' + wasCls}>{was}</span>
    </span>
    <span className="s-now">
      <span className="st st-done">{now}</span>
    </span>
  </span>
)

// mini Notion DATABASE (a Notion surface). `flip` (sqlite block) makes Ship v1 +
// Fix deploy animate as the two-way replica syncs; schema uses the static form.
const MiniNotionDb = ({ flip = false }: { flip?: boolean }) => (
  <NotionSurface
    title={notionTitle}
    workspace="Acme"
    workspaceInitial="A"
    nav={[
      { icon: '▦', label: 'Tasks', on: true },
      { icon: '◆', label: 'Roadmap' },
    ]}
  >
    <table className="ntn-tbl">
      <thead>
        <tr>
          <th>Name</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td className="nmc">
            <span className="pg">▤</span>Ship v1
          </td>
          <td>
            {flip === true ? (
              <SqSwap k="sq-n1" was="Todo" wasCls="st-prog" now="Done" />
            ) : (
              <span className="st st-done">Done</span>
            )}
          </td>
        </tr>
        <tr>
          <td className="nmc">
            <span className="pg">▤</span>Fix deploy
          </td>
          <td>
            {flip === true ? (
              <SqSwap k="sq-n2" was={'In Progress'} wasCls="st-prog" now="Done" />
            ) : (
              <span className="st st-prog">In&nbsp;Progress</span>
            )}
          </td>
        </tr>
        <tr>
          <td className="nmc">
            <span className="pg">▤</span>Draft plan
          </td>
          <td>
            <span className="st st-prog">Todo</span>
          </td>
        </tr>
      </tbody>
    </table>
  </NotionSurface>
)

// Notion property TYPE icons (monochrome, consistent with Notion's panel).
const tSelect = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5.5 8l4.5 4.5L14.5 8" />
  </svg>
)
const tMulti = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="4" cy="5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="4" cy="10" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="4" cy="15" r="1.2" fill="currentColor" stroke="none" />
    <path d="M8 5h9M8 10h9M8 15h6" />
  </svg>
)
const tDate = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="10" cy="10" r="7.3" />
    <path d="M10 5.6V10l3 1.8" />
  </svg>
)

// a Notion property row: [type icon] name · (optional select options) · chevron
const PropRow = ({ icon, name, opts, k }: { icon: ReactNode; name: string; opts?: string; k?: string }) => (
  <div className="np-row" data-k={k}>
    <span className="np-ic">{icon}</span>
    <span className="np-nm">{name}</span>
    {opts !== undefined && <span className="np-opts">{opts}</span>}
    <span className="np-cv">›</span>
  </div>
)

// The Notion side of the SCHEMA block: a PROPERTIES view (property name + type),
// 1:1 with schema.gen.ts. Status is a select whose options generate the literal.
const MiniNotionProps = () => (
  <NotionSurface
    title={notionTitle}
    workspace="Acme"
    workspaceInitial="A"
    nav={[
      { icon: '▦', label: 'Tasks', on: true },
      { icon: '◆', label: 'Roadmap' },
    ]}
  >
    <div className="ntn-props">
      <div className="np-hd">Properties</div>
      <PropRow icon={<span className="tt">Aa</span>} name="Name" />
      <PropRow icon={tSelect} name="Status" opts="Todo · Doing · Done" k="prop-status" />
      <PropRow icon={tSelect} name="Priority" opts="High · Med · Low" />
      <PropRow icon={<span className="num">#</span>} name="Effort (h)" />
      <PropRow icon={tMulti} name="Team" />
      <PropRow icon={tDate} name="Due" k="prop-iac" />
    </div>
  </NotionSurface>
)

// mini SQL terminal (plain SQL edit on the local file → syncs to Notion) — sqlite
const MiniSqlTerm = () => (
  <Terminal title={<WinTitle icon={sqliteLogo} file="sqlite3 tasks.db" />}>
    <TerminalLine>
      <span className="sq">sqlite&gt;</span> <span className="kw">UPDATE</span> pages
    </TerminalLine>
    <TerminalLine>
      {'   '}
      <span className="kw">SET</span> status = <span className="str">'Done'</span>;
    </TerminalLine>
    <TerminalLine out>
      <span className="recvln" data-k="sql">1 row updated · synced to Notion ✓</span>
    </TerminalLine>
  </Terminal>
)

// the actual local SQLite database file (a .db grid; SQLite/feather identity,
// dark local-file chrome — deliberately distinct from the light Notion DB).
// a raw SQLite value that crossfades on sync (mono text, NOT a Notion pill).
const RawSwap = ({ k, was, now }: { k: string; was: string; now: string }) => (
  <span className={'swap ' + k}>
    <span className="s-was">'{was}'</span>
    <span className="s-now">'{now}'</span>
  </span>
)

// the actual local SQLite database — a RAW DB-tool view (monospace grid, raw cell
// values, SQL-typed headers, teal selection). Deliberately the visual OPPOSITE of
// the polished Notion surface on the right; the contrast is the point.
const MiniSqliteDb = () => (
  <DbBrowser
    title={<WinTitle icon={sqliteLogo} file="tasks.db" />}
    tables={[
      { name: 'pages', icon: '▦', selected: true },
      { name: 'changes', icon: '≡' },
    ]}
  >
    <table className="dbb-grid sqraw">
      <thead>
        <tr>
          <th className="gut"> </th>
          <th>
            name <span className="ty">TEXT</span>
          </th>
          <th>
            status <span className="ty">TEXT</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td className="gut">1</td>
          <td>Ship v1</td>
          <td>
            <RawSwap k="sq-l1" was="Todo" now="Done" />
          </td>
        </tr>
        <tr>
          <td className="gut">2</td>
          <td>Fix deploy</td>
          <td>
            <RawSwap k="sq-l2" was="In Progress" now="Done" />
          </td>
        </tr>
      </tbody>
    </table>
  </DbBrowser>
)

// local side of the sqlite block: the SQLite .db file + the terminal you edit it
// with, overlapping (db behind, terminal floating in front) — "a real local DB".
const MiniLocalSqlite = () => (
  <div className="loc-sqlite">
    <div className="loc-db">
      <MiniSqliteDb />
    </div>
    <div className="loc-term">
      <MiniSqlTerm />
    </div>
  </div>
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
      <span className="litline" data-k="lit">
        {'    '}
        <STR>'Todo'</STR>, <STR>'Doing'</STR>, <STR>'Done'</STR>)
      </span>
    </CodeLine>
  </KitIDE>
)

// mini JSX page component (kit editor) — notion-react
const MiniJsx = () => (
  <KitIDE
    title={<WinTitle icon={reactLogo} file="page.tsx" />}
    tag=""
    tree={[{ kind: 'file', label: 'page.tsx', selected: true }]}
    tab={<>page.tsx</>}
  >
    <CodeLine>
      <KW>const</KW> <At>Page</At> = () =&gt;
    </CodeLine>
    <CodeLine>
      {'  '}&lt;<At>Toggle</At> <KW>title</KW>=<STR>"Q3 plan"</STR>&gt;
    </CodeLine>
    <CodeLine>
      {'    '}&lt;<At>Text</At>&gt;
      <span className="swap" data-k="rbudget">
        <span className="s-was">budget…</span>
        <span className="s-now">budget $42k</span>
      </span>
      &lt;/&gt;
    </CodeLine>
    <CodeLine>
      {'  '}&lt;/<At>Toggle</At>&gt;
    </CodeLine>
  </KitIDE>
)

// Dedicated Notion render target for the notion-react block (NOT the shared
// MiniNotionPage — its blocks map 1:1 to the JSX, incl. a real toggle block, so
// changing one JSX line updates exactly one block).
const MiniReactPage = () => (
  <NotionSurface
    title={notionTitle}
    workspace="Acme"
    workspaceInitial="A"
    nav={[{ icon: '◆', label: 'Roadmap', on: true }]}
  >
    <NotionPage emoji="🚀" heading="Launch roadmap">
      <div className="blk toggle">
        <span className="tgl">▸</span> Q3 plan
      </div>
      <div className="blk nested" data-k="rbudget">
        <span className="swap">
          <span className="s-was">↳ budget…</span>
          <span className="s-now">↳ budget $42k</span>
        </span>
      </div>
    </NotionPage>
  </NotionSurface>
)
// Official Notion "N" logo — single path, currentColor (theme-aware, CSP-safe).
const NotionMark = ({ size = 20, className }: { size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} role="img" aria-label="Notion">
    <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952l1.448.328s0 .84-1.168.84l-3.222.186c-.093-.187 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.746l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.216-1.632z" />
  </svg>
)
// Notion mark on a fixed white tile (near-black mark) — same in both themes, like
// the real app icon. Used wherever Notion is the branded chip (hub, title bars).
const NotionChip = ({ size = 16 }: { size?: number }) => (
  <span className="intro-nchip">
    <NotionMark size={size} />
  </span>
)
// A Notion window title: white N chip + "Notion" label (for NotionSurface bars).
const notionTitle = <WinTitle icon={<NotionChip size={12} />} label="Notion" />

// ── per-block iconic technology logos (self-contained inline SVG, theme-aware) ──
// Markdown mark (rounded rect border + "M▼").
const mdLogo = (
  <svg width="20" height="14" viewBox="0 0 208 128" aria-label="Markdown">
    <rect x="5" y="5" width="198" height="118" rx="12" fill="none" stroke="currentColor" strokeWidth="10" />
    <path fill="currentColor" d="M30 98V30h19l20 25 20-25h19v68H108V59l-19 24-20-24v39zm128 0-30-33h19V30h20v35h20z" />
  </svg>
)
// SQLite feather.
const sqliteLogo = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-label="SQLite">
    <path d="M21 3.5C13.4 4 7.3 8.9 5.6 16.3c-.35 1.5-.5 3-.5 4.2" />
    <path d="M19.2 5.4C13.6 6.3 9.4 10.2 7.7 15.6" />
    <path d="M17.4 7.6c-3.9 1.1-6.7 3.9-8.2 7.7" />
    <path d="M5.1 20.5 8 17.4" />
  </svg>
)
// React atom (iconic cyan; legible on both themes).
const reactLogo = (
  <svg width="20" height="18" viewBox="0 0 24 24" fill="none" aria-label="React">
    <g stroke="#3fb8d6" strokeWidth="1.1">
      <ellipse cx="12" cy="12" rx="10.5" ry="4.2" />
      <ellipse cx="12" cy="12" rx="10.5" ry="4.2" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="10.5" ry="4.2" transform="rotate(120 12 12)" />
    </g>
    <circle cx="12" cy="12" r="1.9" fill="#3fb8d6" />
  </svg>
)
// Schema round-trip mark — DB ⇄ {} with codegen→ / ←IaC arrows (its identity).
const schemaMark = (
  <svg width="22" height="16" viewBox="0 0 30 20" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-label="schema round-trip">
    <ellipse cx="5" cy="4.5" rx="4" ry="1.7" />
    <path d="M1 4.5v6.5c0 .95 1.8 1.7 4 1.7s4-.75 4-1.7V4.5" />
    <path d="M24 3.5c-1.1 0-1.6.6-1.6 1.6S22.9 7 21.8 8c1.1 1 1.6 1.4 1.6 2.4s-.5 1.6.6 1.6" />
    <path d="M25.5 3.5c1.1 0 1.6.6 1.6 1.6S27.6 7 28.7 8c-1.1 1-1.6 1.4-1.6 2.4s.5 1.6-.6 1.6" />
    <path d="M10 6.5h8.5M16.5 5 18.5 6.5l-2 1.5" />
    <path d="M18.5 11h-8.5M12 9.5 10 11l2 1.5" />
  </svg>
)

// slide-1 actor name icons (small, consistent line weight, accent, theme-aware)
const svgIcon = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    {d.split('|').map((p) => (
      <path key={p} d={p} />
    ))}
  </svg>
)
const icUsers = svgIcon('M12 11.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4|M5.5 19.5a6.5 6.5 0 0 1 13 0')
const icSparkle = svgIcon('M11 3l1.5 4.2L16.7 9 12.5 10.5 11 15 9.5 10.5 5.3 9l4.2-1.8z|M18 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z')
const icBraces = svgIcon('M9.5 6.5 5 12l4.5 5.5|M14.5 6.5 19 12l-4.5 5.5')
const icTerminal = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M7 10l3 2.5-3 2.5M13 15.5h4" />
  </svg>
)
const icGear = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3.1" />
    <path d="M12 2.2v3M12 18.8v3M4.4 4.4l2.1 2.1M17.5 17.5l2.1 2.1M2.2 12h3M18.8 12h3M4.4 19.6l2.1-2.1M17.5 6.5l2.1-2.1" />
  </svg>
)

// lego brick — the "snap together" motif (How-slide kicker only).
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
// Slide-1 actor card: a miniature native-UI mockup + name. The mockup carries
// the meaning, so there's no descriptive sub-line. `re` right-aligns the name
// for the Engineering column.
const ActorCard = ({ mock, name, icon, re = false }: { mock: ReactNode; name: string; icon: ReactNode; re?: boolean }) => (
  <div className={re === true ? 'intro-actor re' : 'intro-actor'}>
    {mock}
    <span className="cap">
      <span className="nm">
        <span className="ni">{icon}</span>
        {name}
      </span>
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

// Slide-2 "How" gallery — Notion view-tab pattern: top tabs (one per building
// block) show ONE block at a time, so the slide isn't a wall of four mockups.
// `icon` is each block's ICONIC technology logo (its primary identity).
const HowGallery = () => {
  const [active, setActive] = useState(0)
  const blocks: { key: string; num: string; name: string; icon: ReactNode; desc: string; body: ReactNode }[] = [
    {
      key: 'md',
      num: '01',
      name: 'notion md',
      icon: mdLogo,
      desc: 'Edit a Notion page as local Markdown — two-way, conflict-guarded sync from your editor.',
      body: (
        <div className="intro-pair md">
          <div className="side">
            <MiniMdFile />
          </div>
          <Conn dir="⇄" action="two-way sync" />
          <div className="side">
            <MiniNotionPage />
          </div>
        </div>
      ),
    },
    {
      key: 'sqlite',
      num: '02',
      name: 'notion sqlite',
      icon: sqliteLogo,
      desc: 'Edit a Notion database locally with plain SQL — every change syncs straight back to Notion.',
      body: (
        <div className="intro-pair sqlite">
          <div className="side">
            <MiniLocalSqlite />
          </div>
          <Conn dir="⇄" action="live sync" />
          <div className="side">
            <MiniNotionDb flip />
          </div>
        </div>
      ),
    },
    {
      key: 'schema',
      num: '03',
      name: 'notion schema',
      icon: schemaMark,
      desc: 'A round-trip: generate typed Effect schemas from the Notion database (codegen), and provision the Notion database from code (IaC).',
      body: (
        <div className="intro-pair schema">
          <div className="side">
            <MiniSchemaCode />
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
            <MiniNotionProps />
          </div>
        </div>
      ),
    },
    {
      key: 'react',
      num: '04',
      name: 'notion-react',
      icon: reactLogo,
      desc: 'Author a Notion page as a React component; rerun renders a precise block-level diff.',
      body: (
        <div className="intro-pair react">
          <div className="side">
            <MiniJsx />
          </div>
          <Conn dir="→" action="render" />
          <div className="side">
            <MiniReactPage />
          </div>
        </div>
      ),
    },
  ]
  const b = blocks[active]!
  return (
    <div className="flex flex-col gap-5">
      {/* view tabs — Notion gallery/view-switcher pattern (underline active) */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border">
        {blocks.map((blk, i) => (
          <button
            key={blk.key}
            type="button"
            onClick={() => setActive(i)}
            className={
              i === active
                ? '-mb-px inline-flex items-center gap-2 border-b-2 border-accent px-2.5 py-2 text-[13px] font-medium text-fg'
                : '-mb-px inline-flex items-center gap-2 border-b-2 border-transparent px-2.5 py-2 text-[13px] text-fg-muted hover:text-fg'
            }
          >
            <span className="intro-blogo inline-flex h-5 w-5 flex-none items-center justify-center rounded border border-border bg-bg-panel text-fg">
              {blk.icon}
            </span>
            <span className="font-mono">{blk.name}</span>
          </button>
        ))}
      </div>
      {/* active block */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-[11px] font-bold text-fg-faint">{b.num}</span>
          <span className="font-mono text-[15.5px] font-semibold">{b.name}</span>
        </div>
        {b.body}
        <p className="m-0 text-[13px] leading-snug text-fg-muted">{b.desc}</p>
      </div>
    </div>
  )
}

// Slide-3 "Disclaimer" poster — an ORIGINAL flat Notion-style illustration (a
// tinkerer's workbench) rendered as self-contained inline SVG. Full-color on its
// own warm cream inset (fixed in both themes, like Notion's marketing blocks), so
// the internals use fixed colors, NOT theme tokens. The four gadgets on the bench
// carry the SAME tool logos as Slide 2 (md / sqlite / schema / react) — the "these
// are my bespoke daily-drivers" payoff. Figure is deliberately geometric/near-
// faceless (Notion's character register) to stay legible at poster scale.
const WorkbenchPoster = () => {
  // Fixed illustration palette — reads on the cream poster in light AND dark.
  const ink = '#37352f'
  const skin = '#f2cfa8'
  const hair = '#5b4636'
  const shirt = '#2383e2'
  const bulb = '#ffd34e'
  const ray = '#e2952f'
  const wood = '#e7d3ae'
  const woodDark = '#d2b98d'
  // gadget bodies (soft pastels) + their darker emblem inks
  const G = [
    { fill: '#cdbdf2', logo: mdLogo, lc: '#4b3f7a', lx: 186, ly: 217 },
    { fill: '#a9d8bb', logo: sqliteLogo, lc: '#2f6b48', lx: 249, ly: 215 },
    { fill: '#f4b3a2', logo: schemaMark, lc: '#a24a37', lx: 309, ly: 216 },
    { fill: '#aeddec', logo: reactLogo, lc: undefined, lx: 372, ly: 215 },
  ]
  return (
    <svg viewBox="0 0 460 300" className="w-full" role="img" aria-label="A tinkerer assembling bespoke Notion tools at a workbench, under a lightbulb">
      {/* pendant cord + lamp glow */}
      <line x1="228" y1="0" x2="228" y2="44" stroke={ink} strokeWidth="2" />
      <circle cx="228" cy="70" r="52" fill={bulb} opacity="0.16" />
      {/* inspiration rays */}
      <g stroke={ray} strokeWidth="2.6" strokeLinecap="round">
        <line x1="228" y1="30" x2="228" y2="18" />
        <line x1="266" y1="42" x2="276" y2="34" />
        <line x1="190" y1="42" x2="180" y2="34" />
        <line x1="280" y1="72" x2="292" y2="72" />
        <line x1="176" y1="72" x2="164" y2="72" />
      </g>
      {/* lightbulb */}
      <g stroke={ink} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round">
        <circle cx="228" cy="70" r="26" fill={bulb} />
        <path d="M228 58v9M221 63l7 4 7-4" fill="none" stroke={ink} strokeWidth="1.8" />
        <path d="M218 92h20M220 98h16" fill="none" stroke={ink} strokeWidth="2" />
      </g>
      {/* character — geometric, near-faceless (Notion register); bench hides legs */}
      <g strokeLinejoin="round" strokeLinecap="round">
        {/* torso / shirt */}
        <path d="M78 208c0-20 15-30 34-30s34 10 34 30v46H78z" fill={shirt} stroke={ink} strokeWidth="2.4" />
        {/* left arm resting on bench */}
        <path d="M82 214q-12 12-6 30" fill="none" stroke={shirt} strokeWidth="14" />
        <circle cx="76" cy="243" r="8" fill={skin} stroke={ink} strokeWidth="2.2" />
        {/* right arm reaching to gadget A */}
        <path d="M142 206q26 0 40 8" fill="none" stroke={shirt} strokeWidth="14" />
        <circle cx="190" cy="216" r="8" fill={skin} stroke={ink} strokeWidth="2.2" />
        {/* screwdriver working the first gadget */}
        <line x1="192" y1="212" x2="200" y2="200" stroke={ink} strokeWidth="3" />
        <line x1="199" y1="201" x2="203" y2="196" stroke={ray} strokeWidth="4" />
        {/* neck + head */}
        <rect x="103" y="176" width="18" height="14" rx="4" fill={skin} stroke={ink} strokeWidth="2.2" />
        <circle cx="112" cy="150" r="30" fill={skin} stroke={ink} strokeWidth="2.4" />
        {/* hair cap */}
        <path d="M83 152c0-27 58-27 58 0 0-11-13-18-29-18s-29 7-29 18z" fill={hair} stroke={ink} strokeWidth="2.2" />
        {/* face */}
        <circle cx="104" cy="151" r="2.6" fill={ink} />
        <circle cx="121" cy="151" r="2.6" fill={ink} />
        <path d="M104 161q8 6 15 0" fill="none" stroke={ink} strokeWidth="2" />
      </g>
      {/* workbench */}
      <g stroke={ink} strokeWidth="2.4" strokeLinejoin="round">
        <rect x="40" y="246" width="384" height="16" rx="6" fill={wood} />
        <rect x="66" y="262" width="13" height="34" fill={woodDark} />
        <rect x="386" y="262" width="13" height="34" fill={woodDark} />
      </g>
      {/* four bespoke gadgets — same logos as Slide 2's building blocks */}
      {G.map((g, i) => {
        const gx = 174 + i * 62
        const cx = gx + 22
        return (
          <g key={i}>
            {/* antenna */}
            <line x1={cx} y1="202" x2={cx} y2="192" stroke={ink} strokeWidth="2.2" strokeLinecap="round" />
            <circle cx={cx} cy="189" r="4" fill={g.fill} stroke={ink} strokeWidth="2.2" />
            {/* body */}
            <rect x={gx} y="202" width="44" height="44" rx="10" fill={g.fill} stroke={ink} strokeWidth="2.4" />
            {/* label plate */}
            <rect x={gx + 8} y="234" width="28" height="6" rx="3" fill="#ffffff" opacity="0.55" />
            {/* emblem = the tool's own logo */}
            <g transform={`translate(${g.lx} ${g.ly})`} color={g.lc}>
              {g.logo}
            </g>
          </g>
        )
      })}
      {/* being-assembled spark over gadget A + floating accents */}
      <g stroke={ray} strokeWidth="2.4" strokeLinecap="round">
        <path d="M168 190l0-9M163.5 185.5l9 0M165 183l6 6M171 183l-6 6" />
        <path d="M330 150l0-7M326.5 146.5l7 0" opacity="0.8" />
        <path d="M150 120l0-7M146.5 116.5l7 0" opacity="0.7" />
      </g>
    </svg>
  )
}

const IntroPanel = ({ hidden }: { hidden: boolean }) => (
  <section hidden={hidden} className="intro flex max-w-[1120px] flex-col gap-20">
    {/* Slide 1 — Why: the ecosystem around Notion (hub = source of truth) */}
    <section className="py-2">
      <div className="mb-1.5 text-[13px] text-fg-muted">Why</div>
      <h2 className="m-0 mb-6 text-[25px] font-bold tracking-tight">Notion, for users, developers, and agents</h2>
      <div className="flex flex-wrap items-stretch justify-center gap-2">
        {/* Knowledge work — each actor has its own hand-drawn arrow to the hub */}
        <div className="flex min-w-[290px] flex-1 flex-col gap-2.5">
          <div className="text-[11px] text-fg-faint">Knowledge work</div>
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <ActorCard icon={icUsers} mock={<MiniNotionApp />} name="users" />
            </div>
            <HandArrow />
          </div>
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <ActorCard icon={icSparkle} mock={<MiniChat />} name="productivity agents" />
            </div>
            <HandArrow />
          </div>
        </div>
        {/* Notion hub */}
        <div className="flex min-w-[144px] flex-col items-center justify-center rounded-2xl border-2 border-accent/50 bg-accent/5 px-6 py-5 text-center">
          <span className="mb-1.5 inline-flex">
            <NotionChip size={26} />
          </span>
          <span className="text-[16px] font-bold leading-tight">Notion</span>
        </div>
        {/* Engineering */}
        <div className="flex min-w-[290px] flex-1 flex-col gap-2.5">
          <div className="text-right text-[11px] text-fg-faint">Engineering</div>
          <div className="flex items-center gap-1.5">
            <HandArrow />
            <div className="min-w-0 flex-1">
              <ActorCard re icon={icBraces} mock={<MiniIDE />} name="developers" />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <HandArrow />
            <div className="min-w-0 flex-1">
              <ActorCard re icon={icTerminal} mock={<MiniTerminal />} name="coding agents" />
            </div>
          </div>
        </div>
      </div>
      {/* automations & integrations — its own arrow up to the hub */}
      <div className="mt-2 flex flex-col items-center gap-1">
        <HandArrow vertical />
        <div className="flex w-full max-w-[440px] items-center gap-3.5 p-1">
          <div className="w-[200px] flex-none">
            <MiniFlow />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold">
              <span className="ni">{icGear}</span>automations &amp; integrations
            </div>
          </div>
        </div>
      </div>
    </section>
    {/* Slide 2 — How: building blocks that snap together */}
    <section className="py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[13px] text-fg-muted">
        <span className="text-fg-muted">{iconLego}</span> How
      </div>
      <h2 className="m-0 mb-5 text-[25px] font-bold tracking-tight">principled Notion building blocks for agents and developers</h2>
      <HowGallery />
    </section>
    {/* Slide 3 — Disclaimer: these are inspiration, not a product. Copy left,
        full-color Notion-style "tinkerer's workbench" poster right. */}
    <section className="py-2">
      <div className="mb-1.5 text-[13px] text-fg-muted">Disclaimer</div>
      <h2 className="m-0 mb-6 text-[25px] font-bold tracking-tight">Inspiration, not a product.</h2>
      <div className="flex flex-wrap items-center gap-x-12 gap-y-8">
        {/* the three points — each maps to one beat of the message */}
        <ol className="m-0 flex min-w-[300px] max-w-[460px] flex-1 list-none flex-col gap-5 p-0">
          {[
            {
              num: '01',
              title: 'My daily drivers, not a supported library',
              desc: 'I use these every day — personal tools, not packages to install and depend on.',
            },
            {
              num: '02',
              title: 'Take the ideas, build your own',
              desc: 'The patterns are the point. Adapt them to your stack rather than adopting my code.',
            },
            {
              num: '03',
              title: 'Ideally, absorbed into Notion',
              desc: 'The real endgame: these become first-class Notion tools & APIs, so nobody has to build them.',
            },
          ].map((p) => (
            <li key={p.num} className="flex items-start gap-3.5">
              <span className="mt-0.5 flex-none text-[13px] font-bold tabular-nums text-accent">{p.num}</span>
              <div className="min-w-0">
                <div className="text-[14.5px] font-semibold leading-snug">{p.title}</div>
                <p className="m-0 mt-1 text-[13px] leading-snug text-fg-muted">{p.desc}</p>
              </div>
            </li>
          ))}
        </ol>
        {/* full-color poster on its own warm cream inset (fixed in both themes) */}
        <div className="intro-poster min-w-[320px] flex-1">
          <WorkbenchPoster />
        </div>
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

  // lightbox
  const [lightbox, setLightbox] = useState<string | null>(null)

  // commit: normalize, persist to URL, and re-apply master backups to the
  // (possibly new) active demo — mirrors build.ts applyState().
  const commit = useCallback((next: UiState) => {
    const norm = normalize(next)
    setState(norm)
    setOpenBeats(seedOpen(norm.demo, norm.backups === 'shown'))
    writeUrl(norm)
  }, [])

  // init: write the normalized URL on first mount.
  useEffect(() => {
    writeUrl(state)
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

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-10 flex flex-wrap items-center gap-1 border-b border-border bg-bg-panel px-4">
        <button
          type="button"
          onClick={() => setDemo(INTRO_ID)}
          className={
            onIntro
              ? '-mb-px inline-flex items-center gap-1.5 border-b-2 border-accent px-3 py-2.5 text-[13px] font-medium text-fg'
              : '-mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2.5 text-[13px] text-fg-muted hover:text-fg'
          }
        >
          <kbd className={`border-0 bg-transparent p-0 font-mono text-[11px] ${onIntro ? 'text-accent' : 'text-fg-faint'}`}>
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
            <Fragment key={item.groupId}>
              {item.members.map((d) => (
                <TabButton key={d.id} d={d} on={d.id === state.demo} onClick={() => setDemo(d.id)} />
              ))}
            </Fragment>
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
            openBeats={openBeats}
            onToggleExplain={toggleExplain}
            onCloseExplain={closeExplain}
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

      {/* Minimal floating theme toggle — relocated from the removed top bar so theme switching still works. */}
      <button
        type="button"
        onClick={toggleTheme}
        title="Toggle theme"
        aria-label="Toggle theme"
        className="fixed bottom-4 left-4 z-40 rounded-md border border-border bg-bg-subtle px-2.5 py-1 text-xs text-fg-muted opacity-40 transition hover:text-fg hover:opacity-100"
      >
        ◐
      </button>
      {/* Dev-only visual feedback tool: turns UI annotations into structured context for coding agents via MCP. Dev server only — excluded from the built control.next.html. */}
      {import.meta.env.DEV && <Agentation />}
    </div>
  )
}
