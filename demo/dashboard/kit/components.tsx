/**
 * components.tsx — the React kit. PLAIN function components that emit the exact
 * className strings the kit CSS targets. NO Tailwind, NO bundler dependency —
 * so the same components render in the SSG explainers (build-time, zero client
 * runtime) AND, later, inside the control dashboard's React tree.
 *
 * The className strings ARE the contract with kit-components.css + engine.js.
 * Do not rename a class here without changing the CSS/engine in lockstep.
 */
import * as React from 'react'
import type { Actor } from './actors.ts'
import type { PriorityName, StatusName } from './fixtures.ts'
import { PRIORITY_PILL } from './fixtures.ts'
import type { Step } from './syncStory.ts'

/** non-breaking space — keeps "In Progress" on one line, matches the hand-authored markup. */
export const NB = ' '
export const nbsp = (s: string) => s.replace(/ /g, NB)

// ── window chrome ──────────────────────────────────────────────────────────
const Lights = () => (
  <div className="macw-lights">
    <i className="r" />
    <i className="y" />
    <i className="g" />
  </div>
)

/** Title-bar inner for the `.macw-title` slot: an icon glyph + a mono filename and/or plain label. */
export const WinTitle = ({ icon, file, label }: { icon?: React.ReactNode; file?: string; label?: string }) => (
  <>
    {icon != null && <span className="ic">{icon}</span>}
    {file != null && <span className="fn">{file}</span>}
    {label != null && <span>{label}</span>}
  </>
)

export type MacVariant = 'dbb' | 'ntn' | 'tmnl' | 'ide' | 'plain'

/** macOS window chrome. Children are the window body (the variant's `*-body` wrapper). */
export const MacWindow = ({
  variant = 'plain',
  title,
  tag,
  children,
}: {
  variant?: MacVariant
  title?: React.ReactNode
  tag?: string
  children?: React.ReactNode
}) => (
  <div className={variant === 'plain' ? 'macw' : `macw ${variant}`}>
    <div className="macw-bar">
      <Lights />
      <div className="macw-title">{title}</div>
      {tag != null && <span className="macw-tag">{tag}</span>}
    </div>
    {children}
  </div>
)

// ── SQLite DB browser ──────────────────────────────────────────────────────
export interface DbTable {
  readonly name: string
  readonly icon: string
  readonly selected?: boolean
}

export const DbBrowser = ({
  title,
  tag = 'sqlite',
  tables,
  children,
}: {
  title: React.ReactNode
  tag?: string
  tables: readonly DbTable[]
  children: React.ReactNode
}) => (
  <MacWindow variant="dbb" title={title} tag={tag}>
    <div className="dbb-body">
      <div className="dbb-side">
        <div className="grp">Tables</div>
        {tables.map((t) => (
          <div key={t.name} className={t.selected ? 'dbb-tbl sel' : 'dbb-tbl'}>
            <span className="ic">{t.icon}</span>
            {t.name}
          </div>
        ))}
      </div>
      <div className="dbb-main">{children}</div>
    </div>
  </MacWindow>
)

// ── Notion surface (table variant) ─────────────────────────────────────────
export interface NotionNav {
  readonly icon: string
  readonly label: string
  readonly on?: boolean
}

export const NotionSurface = ({
  title,
  tag = 'notion',
  workspace,
  workspaceInitial,
  nav,
  children,
}: {
  title?: React.ReactNode
  tag?: string
  workspace: string
  workspaceInitial: string
  nav: readonly NotionNav[]
  children: React.ReactNode
}) => (
  <MacWindow variant="ntn" title={title ?? <WinTitle icon="◼" label="Notion" />} tag={tag}>
    <div className="ntn-body">
      <div className="ntn-side">
        <div className="ws">
          <span className="av">{workspaceInitial}</span>
          {workspace}
        </div>
        {nav.map((n) => (
          <div key={n.label} className={n.on ? 'nav on' : 'nav'}>
            <span className="ic">{n.icon}</span>
            {n.label}
          </div>
        ))}
      </div>
      <div className="ntn-main">{children}</div>
    </div>
  </MacWindow>
)

// ── Terminal ───────────────────────────────────────────────────────────────
export const Terminal = ({ title, children }: { title?: React.ReactNode; children: React.ReactNode }) => (
  <MacWindow variant="tmnl" title={title ?? <WinTitle icon="❯_" file="zsh — notion-db" />}>
    <div className="tmnl-body">{children}</div>
  </MacWindow>
)

/** One terminal line. `extra` adds reveal/continuation classes (e.g. "step-hide r2 cont"). */
export const TerminalLine = ({
  extra,
  out,
  children,
}: {
  extra?: string
  out?: boolean
  children: React.ReactNode
}) => <div className={['ln', out ? 'out' : '', extra ?? ''].filter(Boolean).join(' ')}>{children}</div>

/** Terminal syntax spans (the `.kw/.str/.out/.p/.sq` highlighting). */
export const Prompt = () => <span className="p">❯</span>
export const SqlitePrompt = () => <span className="sq">sqlite&gt;</span>
export const KW = ({ children }: { children: React.ReactNode }) => <span className="kw">{children}</span>
export const STR = ({ children }: { children: React.ReactNode }) => <span className="str">{children}</span>
export const OK = ({ children }: { children: React.ReactNode }) => <span className="ok">{children}</span>
export const Cursor = () => <span className="cur" />

// ── collaborator typing caret ──────────────────────────────────────────────
export const TypingCaret = ({ actor, children }: { actor: Actor; children: React.ReactNode }) => (
  <span className="type" data-actor={actor.name} style={{ ['--actor-color' as string]: actor.color } as React.CSSProperties}>
    <span className="type-text">{children}</span>
    <span className="type-caret" aria-hidden="true">
      <span className="type-flag">{actor.name}</span>
    </span>
  </span>
)

// ── status / priority pills ────────────────────────────────────────────────
export const StatusPill = ({ status }: { status: StatusName }) => (
  <span className={status === 'Done' ? 'st st-done' : 'st st-prog'}>{nbsp(status)}</span>
)

export const PriorityPill = ({ priority }: { priority: PriorityName }) => {
  const p = PRIORITY_PILL[priority]
  return <span className={`pill ${p.cls}`}>{p.label}</span>
}

// ── was→now swap ───────────────────────────────────────────────────────────
/** The crossfade morph. Kit CSS gates WHICH step it flips by the surrounding
 *  pane selector (`.dbb-grid .swap` flips at step 2, `.ntn-tbl .swap` at step 3). */
export const Swap = ({ was, now }: { was: React.ReactNode; now: React.ReactNode }) => (
  <span className="swap">
    <span className="s-was">{was}</span>
    <span className="s-now">{now}</span>
  </span>
)

// ── flow connector ─────────────────────────────────────────────────────────
export const Flow = ({
  done,
  idle,
  syncing,
  check = '✓ verified',
}: {
  done: string
  idle: string
  syncing: string
  check?: string
}) => (
  <div className="flow">
    <div className="flow-badge">
      <span className="dot" />
      <span className="lbl">
        <span className="l-done">{done}</span>
        <span className="l-idle">{idle}</span>
        <span className="l-sync">{syncing}</span>
      </span>
    </div>
    <div className="flow-rail">
      <span className="track" />
      <span className="head" />
      <span className="pkt" />
    </div>
    <div className="flow-check">{check}</div>
  </div>
)

// ── sequence player (segmented bar controls) ───────────────────────────────
/** The `.seq-live` control block the engine drives (play/pause, prev/next,
 *  segmented progress bar, count). Hidden until the engine sets data-mode="anim". */
export const StepPlayer = ({ steps }: { steps: readonly Step[] }) => (
  <div className="seq-live">
    <p className="seq-cap" data-cap="">
      {steps[0]?.caption}
    </p>
    <div className="seq-ctrl">
      <button className="seq-btn" type="button" data-act="toggle" aria-label="Play or pause">
        <svg className="ic-play" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 5v14l11-7z" />
        </svg>
        <svg className="ic-pause" viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'none' }}>
          <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
        </svg>
      </button>
      <button className="seq-btn" type="button" data-act="prev" aria-label="Previous step">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15 5v14l-9-7z" />
          <rect x="4" y="5" width="2.4" height="14" />
        </svg>
      </button>
      <div className="seq-segs" data-segs="" />
      <button className="seq-btn" type="button" data-act="next" aria-label="Next step">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 5v14l9-7z" />
          <rect x="17.6" y="5" width="2.4" height="14" />
        </svg>
      </button>
      <span className="seq-count" data-count="">
        1 / {steps.length}
      </span>
    </div>
  </div>
)

/** The static numbered legend — the caption SOURCE OF TRUTH the engine reads. */
export const SeqLegend = ({ legendCap, steps }: { legendCap: string; steps: readonly Step[] }) => (
  <div>
    <p className="seq-legend-cap">{legendCap}</p>
    <ol className="seq-legend">
      {steps.map((s) => (
        <li key={s.n} data-cap={s.caption}>
          <span className="n">{s.n}</span>
          {s.caption}
        </li>
      ))}
    </ol>
  </div>
)

/**
 * A `[data-seq]` sequence — one independent engine instance (N per page is fine;
 * the engine's forEach handles it). `stage` is the animated panes; the player +
 * legend are derived from `steps`.
 */
export const Sequence = ({
  steps,
  legendCap,
  stage,
}: {
  steps: readonly Step[]
  legendCap: string
  stage: React.ReactNode
}) => (
  <div className="seq" data-seq="">
    <div className="seq-stage">{stage}</div>
    <StepPlayer steps={steps} />
    <SeqLegend legendCap={legendCap} steps={steps} />
  </div>
)

// ── page scaffolding ───────────────────────────────────────────────────────
export const Beat = ({
  num,
  tag,
  coda,
  children,
}: {
  num: string
  tag: string
  coda?: boolean
  children: React.ReactNode
}) => (
  <section className={coda ? 'beat coda' : 'beat'}>
    <div className="beat-inner">
      <div className="beat-head">
        <span className="beat-num">{num}</span>
        <span className="beat-tag">{tag}</span>
      </div>
      {children}
    </div>
  </section>
)
