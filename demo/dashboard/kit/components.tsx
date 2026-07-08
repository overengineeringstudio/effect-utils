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
import { TechLogo, type LogoName } from './logos.tsx'
import type { FlowDirection, Step } from './syncStory.ts'
import { useStepPlayer } from './useStepPlayer.ts'

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

/**
 * The marks that read clearly better in their OFFICIAL brand color at title-bar
 * size (TypeScript blue, React cyan). Everything else stays `currentColor` so it
 * inherits the title-bar text color and re-themes with the dashboard toggle —
 * Notion/SQLite/GitHub/Markdown deliberately stay monochrome so they never clash
 * on dark, and terminal/file have no brand color at all.
 */
const TITLE_LOGO_BRAND: ReadonlySet<LogoName> = new Set<LogoName>(['typescript', 'react'])

/** Infer the title-bar logo from a filename/extension (mini-IDE default). */
export const logoForFile = (name: string): LogoName => {
  const n = name.toLowerCase()
  if (n.endsWith('.tsx')) return 'react'
  if (n.endsWith('.ts')) return 'typescript'
  if (n.endsWith('.nmd') || n.endsWith('.md')) return 'markdown'
  return 'file'
}

/**
 * Title-bar inner for the `.macw-title` slot: an icon + a mono filename and/or
 * plain label. `logo` renders the official inline-SVG brand mark (sized for the
 * bar, `currentColor` so it re-themes, brand color only for react/typescript);
 * `icon` is the raw-glyph / custom-node escape hatch (both are optional — pass
 * whichever the frame supplies). The surrounding tag/label text names the tech,
 * so the mark is `decorative` (aria-hidden) to avoid double-announcing.
 */
export const WinTitle = ({
  icon,
  logo,
  file,
  label,
}: {
  icon?: React.ReactNode
  logo?: LogoName
  file?: string
  label?: string
}) => (
  <>
    {logo != null ? (
      <span className="ic">
        <TechLogo name={logo} size={14} brand={TITLE_LOGO_BRAND.has(logo)} decorative style={{ display: 'block' }} />
      </span>
    ) : (
      icon != null && <span className="ic">{icon}</span>
    )}
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
  logo = 'sqlite',
  file,
  label,
  tag = 'sqlite',
  tables,
  children,
}: {
  /** Explicit title node — overrides the default logo + file/label title. */
  title?: React.ReactNode
  /** Default title-bar mark (SQLite). */
  logo?: LogoName
  file?: string
  label?: string
  tag?: string
  tables: readonly DbTable[]
  children: React.ReactNode
}) => (
  <MacWindow variant="dbb" title={title ?? <WinTitle logo={logo} file={file} label={label} />} tag={tag}>
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

// ── mini-IDE (editor card) ─────────────────────────────────────────────────
/** A file-tree row: a `fold` (folder header, twist glyph) or a `file`
 *  (selectable, icon). Mirrors the DB-browser sidebar selection idiom. */
export interface IdeTreeItem {
  readonly kind: 'fold' | 'file'
  readonly label: string
  /** file icon (default ▸) or fold twist (default ▾) */
  readonly icon?: string
  readonly selected?: boolean
}

export const FileTree = ({ items }: { items: readonly IdeTreeItem[] }) => (
  <div className="ide-tree">
    {items.map((it) =>
      it.kind === 'fold' ? (
        <div key={it.label} className="ide-fold">
          <span className="tw">{it.icon ?? '▾'}</span> {it.label}
        </div>
      ) : (
        <div key={it.label} className={it.selected ? 'ide-file sel' : 'ide-file'}>
          <span className="ic">{it.icon ?? '▸'}</span> {it.label}
        </div>
      ),
    )}
  </div>
)

/** IDE code syntax spans (`.tg` heading/frontmatter-key, `.cm` comment, `.at`
 *  attr; `.str` frontmatter value is the shared `STR` above). */
export const Tg = ({ children }: { children: React.ReactNode }) => <span className="tg">{children}</span>
export const Cm = ({ children }: { children: React.ReactNode }) => <span className="cm">{children}</span>
export const At = ({ children }: { children: React.ReactNode }) => <span className="at">{children}</span>

/** One code line in the `.ide-code` gutter. `role` paints the causal band
 *  (`orig` = edited-first/blue, `recv` = received/green); omit for a static line. */
export const CodeLine = ({ role, children }: { role?: 'orig' | 'recv'; children: React.ReactNode }) => (
  <div className={role}>{children}</div>
)

/** macOS-window mini-IDE: file-tree sidebar + a single tabbed editor with a
 *  line-number gutter. `children` are the `.ide-code` lines (use <CodeLine/>). */
export const MiniIDE = ({
  title,
  logo,
  file,
  label,
  tag = 'editor',
  tree,
  tab,
  children,
}: {
  /** Explicit title node — overrides the inferred logo + file title. */
  title?: React.ReactNode
  /** Force a title-bar mark; otherwise inferred from `file`'s extension. */
  logo?: LogoName
  /** Filename shown in the bar; also drives the inferred logo (.tsx→react,
   *  .ts→typescript, .nmd/.md→markdown, else the generic file mark). */
  file?: string
  label?: string
  tag?: string
  tree: readonly IdeTreeItem[]
  tab: React.ReactNode
  children: React.ReactNode
}) => (
  <MacWindow
    variant="ide"
    title={title ?? <WinTitle logo={logo ?? logoForFile(file ?? '')} file={file} label={label} />}
    tag={tag}
  >
    <div className="ide-body">
      <FileTree items={tree} />
      <div className="ide-main">
        <div className="ide-tabs">
          <span className="ide-tab">
            <span className="tdot" />
            {tab}
          </span>
        </div>
        <div className="ide-code">{children}</div>
      </div>
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
  logo = 'notion',
  label = 'Notion',
  file,
  tag = 'notion',
  workspace,
  workspaceInitial,
  nav,
  children,
}: {
  /** Explicit title node — overrides the default Notion mark + label title. */
  title?: React.ReactNode
  /** Default title-bar mark (Notion). */
  logo?: LogoName
  /** Bar label beside the mark (default "Notion"). */
  label?: string
  file?: string
  tag?: string
  workspace: string
  workspaceInitial: string
  nav: readonly NotionNav[]
  children: React.ReactNode
}) => (
  <MacWindow variant="ntn" title={title ?? <WinTitle logo={logo} file={file} label={label} />} tag={tag}>
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

/** NotionSurface PAGE variant: a rendered page (real heading + text blocks, NOT
 *  markdown syntax). Pass as NotionSurface children instead of an `.ntn-tbl`. */
export const NotionPage = ({
  emoji,
  heading,
  children,
}: {
  emoji: string
  heading: React.ReactNode
  children: React.ReactNode
}) => (
  <div className="ntn-page">
    <div className="nh">
      <span className="emoji">{emoji}</span>
      {heading}
    </div>
    {children}
  </div>
)

/** One rendered Notion block. `role` paints the causal band (`orig`/`recv`). */
export const NotionBlock = ({ role, children }: { role?: 'orig' | 'recv'; children: React.ReactNode }) => (
  <div className={role ? `blk ${role}` : 'blk'}>{children}</div>
)

// ── Terminal ───────────────────────────────────────────────────────────────
export const Terminal = ({
  title,
  logo = 'terminal',
  file = 'zsh — notion-db',
  children,
}: {
  /** Explicit title node — overrides the default terminal mark + file title. */
  title?: React.ReactNode
  /** Default title-bar mark (terminal). */
  logo?: LogoName
  /** Bar label (the shell/session name). */
  file?: string
  children: React.ReactNode
}) => (
  <MacWindow variant="tmnl" title={title ?? <WinTitle logo={logo} file={file} />}>
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
/** A collaborator's typewriter + name-flag caret. `ch` sets the typewriter's
 *  target width (default 33ch — a full terminal line); pass the text's own
 *  length for short inline edits (e.g. `$30`) so the caret lands right after it. */
export const TypingCaret = ({ actor, ch, children }: { actor: Actor; ch?: number; children: React.ReactNode }) => (
  <span
    className="type"
    data-actor={actor.name}
    style={
      {
        ['--actor-color' as string]: actor.color,
        ...(ch != null ? { ['--type-ch' as string]: `${ch}ch` } : {}),
      } as React.CSSProperties
    }
  >
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

// ── directional connector (push → · ← pull · ⇄ two) ────────────────────────
/** The multi-way / reversed connector. `direction` drives the arrows and rails
 *  independently of pane position (the .nmd stays LEFT, Notion stays RIGHT).
 *  Distinct `.dflow*` classnames from <Flow> so the two never cross-style. */
export const DirFlow = ({
  direction,
  badge,
  note,
}: {
  direction: FlowDirection
  badge: string
  note: string
}) => (
  <div className={`dflow ${direction}`}>
    <div className="dflow-badge">
      <span className="dot" />
      {nbsp(badge)}
    </div>
    <div className="dflow-rail">
      {direction === 'two' ? (
        <>
          <span className="dtrack top" />
          <span className="dtrack bot" />
          <span className="dhead rr" />
          <span className="dhead ll" />
          <span className="dpkt fwd" />
          <span className="dpkt rev" />
        </>
      ) : (
        <>
          <span className="dtrack" />
          <span className={direction === 'push' ? 'dhead r' : 'dhead l'} />
          <span className={direction === 'push' ? 'dpkt fwd' : 'dpkt rev'} />
        </>
      )}
    </div>
    <div className="dflow-note">{note}</div>
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

/** The static numbered legend — the caption SOURCE OF TRUTH the engine reads.
 *  Wrapped in `.seq-legend-wrap` so BOTH the cap and the list hide in anim mode
 *  and reappear together under reduced-motion / JS-off. */
export const SeqLegend = ({ legendCap, steps }: { legendCap: string; steps: readonly Step[] }) => (
  <div className="seq-legend-wrap">
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
  after,
}: {
  steps: readonly Step[]
  legendCap: string
  stage: React.ReactNode
  /** optional `.seq-after` slot: terminal chips / warnings / conflict cards
   *  revealed at late steps (via `.step-hide r3/.r3only/.r4`), below the stage. */
  after?: React.ReactNode
}) => {
  // Per-sequence driver (engine.js ported). On the server this is a no-op (effects
  // don't run), so the legacy SSG markup is unchanged; in the app it arms the
  // segmented bar + data-step state machine and tears down cleanly on unmount/HMR.
  const ref = React.useRef<HTMLDivElement>(null)
  useStepPlayer(ref)
  return (
    <div className="seq" data-seq="" ref={ref}>
      <div className="seq-stage">{stage}</div>
      {after != null && <div className="seq-after">{after}</div>}
      <StepPlayer steps={steps} />
      <SeqLegend legendCap={legendCap} steps={steps} />
    </div>
  )
}

/**
 * SubTabbedSequences — a pure-CSS (zero-JS) sub-tab switcher over N panels in
 * ONE beat. Emits the radios + dual-line labels + `.mpanels` the kit's
 * nth-of-type CSS switches; each panel is typically its own <Sequence> (an
 * independent `[data-seq]` the engine's forEach auto-plays). Reusable by any
 * port that needs source-of-truth / mode sub-tabs.
 *
 * The three fragment groups (inputs → `.tabbar` → `.mpanels`) MUST stay direct
 * siblings in this order for the `~` combinator; rendering the fragment directly
 * inside a beat satisfies that.
 */
export interface SubTab {
  /** stable id fragment; the radio becomes `${group}-${id}` */
  readonly id: string
  /** direction glyph shown before the name (→ / ← / ⇄) */
  readonly dir: string
  readonly name: string
  /** the mono `source:` chip under the name */
  readonly chip: string
  /** the panel body (usually a <Sequence>, optionally preceded by a subhead) */
  readonly panel: React.ReactNode
}

export const SubTabbedSequences = ({
  group,
  tabs,
  defaultId,
}: {
  /** radio-group name + id prefix (e.g. 'mdmode') */
  readonly group: string
  readonly tabs: readonly SubTab[]
  /** which tab is checked initially (default: the first) */
  readonly defaultId?: string
}) => (
  <>
    {tabs.map((t, i) => (
      <input
        key={t.id}
        type="radio"
        name={group}
        id={`${group}-${t.id}`}
        className="mtabs"
        defaultChecked={defaultId != null ? t.id === defaultId : i === 0}
      />
    ))}
    <div className="tabbar" role="tablist">
      {tabs.map((t) => (
        <label key={t.id} className="tablabel" htmlFor={`${group}-${t.id}`} role="tab">
          <span className="tl-top">
            <span className="dirn">{t.dir}</span> {t.name}
          </span>
          <span className="tl-chip">{t.chip}</span>
        </label>
      ))}
    </div>
    <div className="mpanels">
      {tabs.map((t) => (
        <div key={t.id} className="mpanel">
          {t.panel}
        </div>
      ))}
    </div>
  </>
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
