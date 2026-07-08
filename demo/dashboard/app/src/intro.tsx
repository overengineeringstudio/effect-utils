import { type ReactNode, useCallback, useEffect, useState } from 'react'

import {
  MiniChat,
  MiniFlow,
  MiniIDE,
  MiniJsx,
  MiniLocalSqlite,
  MiniMdFile,
  MiniNotionApp,
  MiniNotionDb,
  MiniNotionPage,
  MiniNotionProps,
  MiniReactPage,
  MiniSchemaCode,
  MiniTerminal,
  NotionChip,
  mdLogo,
  reactLogo,
  schemaMark,
  sqliteLogo,
} from './mockups.tsx'

// ---------------------------------------------------------------------------
// intro slides (first tab, id "intro") — static presenter-facing "why + how"
// deck for screen sharing. Not a DemoModel: no beats/explainer/backups, so it
// is handled as a special tab alongside DEMOS rather than through the model.
// ---------------------------------------------------------------------------

// slide-1 actor name icons (small, consistent line weight, accent, theme-aware)
const svgIcon = (d: string) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {d.split('|').map((p) => (
      <path key={p} d={p} />
    ))}
  </svg>
)
const icUsers = svgIcon(
  'M12 11.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4|M5.5 19.5a6.5 6.5 0 0 1 13 0',
)
const icSparkle = svgIcon(
  'M11 3l1.5 4.2L16.7 9 12.5 10.5 11 15 9.5 10.5 5.3 9l4.2-1.8z|M18 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
)
const icBraces = svgIcon('M9.5 6.5 5 12l4.5 5.5|M14.5 6.5 19 12l-4.5 5.5')
const icTerminal = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M7 10l3 2.5-3 2.5M13 15.5h4" />
  </svg>
)
const icGear = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="3.1" />
    <path d="M12 2.2v3M12 18.8v3M4.4 4.4l2.1 2.1M17.5 17.5l2.1 2.1M2.2 12h3M18.8 12h3M4.4 19.6l2.1-2.1M17.5 6.5l2.1-2.1" />
  </svg>
)

// lego brick — the "snap together" motif (How-slide kicker only).
const iconLego = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
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
const ActorCard = ({
  mock,
  name,
  icon,
  re = false,
}: {
  mock: ReactNode
  name: string
  icon: ReactNode
  re?: boolean
}) => (
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
  const blocks: {
    key: string
    num: string
    name: string
    icon: ReactNode
    desc: string
    body: ReactNode
  }[] = [
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
    { key: 'md', fill: '#cdbdf2', logo: mdLogo, lc: '#4b3f7a', lx: 186, ly: 217 },
    { key: 'sqlite', fill: '#a9d8bb', logo: sqliteLogo, lc: '#2f6b48', lx: 249, ly: 215 },
    { key: 'schema', fill: '#f4b3a2', logo: schemaMark, lc: '#a24a37', lx: 309, ly: 216 },
    { key: 'react', fill: '#aeddec', logo: reactLogo, lc: undefined, lx: 372, ly: 215 },
  ]
  return (
    <svg
      viewBox="0 0 460 300"
      className="w-full"
      role="img"
      aria-label="A tinkerer assembling bespoke Notion tools at a workbench, under a lightbulb"
    >
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
        <path
          d="M78 208c0-20 15-30 34-30s34 10 34 30v46H78z"
          fill={shirt}
          stroke={ink}
          strokeWidth="2.4"
        />
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
        <rect
          x="103"
          y="176"
          width="18"
          height="14"
          rx="4"
          fill={skin}
          stroke={ink}
          strokeWidth="2.2"
        />
        <circle cx="112" cy="150" r="30" fill={skin} stroke={ink} strokeWidth="2.4" />
        {/* hair cap */}
        <path
          d="M83 152c0-27 58-27 58 0 0-11-13-18-29-18s-29 7-29 18z"
          fill={hair}
          stroke={ink}
          strokeWidth="2.2"
        />
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
          <g key={g.key}>
            {/* antenna */}
            <line
              x1={cx}
              y1="202"
              x2={cx}
              y2="192"
              stroke={ink}
              strokeWidth="2.2"
              strokeLinecap="round"
            />
            <circle cx={cx} cy="189" r="4" fill={g.fill} stroke={ink} strokeWidth="2.2" />
            {/* body */}
            <rect
              x={gx}
              y="202"
              width="44"
              height="44"
              rx="10"
              fill={g.fill}
              stroke={ink}
              strokeWidth="2.4"
            />
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

// Disclaimer-slide kicker icon — a lightbulb (ties to the poster's inspiration
// motif), matching iconLego's line weight so the three kickers read as a set.
const iconBulb = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9 18h6M10 21h4" />
    <path d="M12 3a6 6 0 0 0-3.6 10.8c.5.4.85 1 .85 1.65v.55h5.5v-.55c0-.65.34-1.25.85-1.65A6 6 0 0 0 12 3z" />
  </svg>
)

// Intro deck slide order — drives the nav dots, the ← / → bound, and which
// <section> IntroSlides reveals. Index matches the three slides below.
const SLIDE_LABELS = ['Why', 'How', 'Disclaimer'] as const

// Chevron glyph for the prev/next buttons — module-scoped (captures nothing).
const navChevron = (d: string) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={d} />
  </svg>
)

// Prev / dots / next navigator for the intro deck (keyboard ← / → mirror it).
// Clamped at both ends, like a real slides app; dots jump directly.
const IntroSlideNav = ({ slide, onGo }: { slide: number; onGo: (i: number) => void }) => {
  const arrowCls =
    'inline-flex h-8 w-8 items-center justify-center rounded-full border border-border text-fg-muted transition hover:border-border-strong hover:text-fg disabled:pointer-events-none disabled:opacity-30'
  return (
    <div className="flex items-center justify-center gap-5 pt-2">
      <button
        type="button"
        aria-label="Previous slide"
        disabled={slide === 0}
        onClick={() => onGo(slide - 1)}
        className={arrowCls}
      >
        {navChevron('M15 6l-6 6 6 6')}
      </button>
      <div className="flex items-center gap-2">
        {SLIDE_LABELS.map((label, idx) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            aria-current={idx === slide ? 'true' : undefined}
            onClick={() => onGo(idx)}
            className={
              idx === slide
                ? 'h-2 w-6 rounded-full bg-accent transition-all'
                : 'h-2 w-2 rounded-full bg-border transition-all hover:bg-fg-faint'
            }
          />
        ))}
      </div>
      <button
        type="button"
        aria-label="Next slide"
        disabled={slide === SLIDE_LABELS.length - 1}
        onClick={() => onGo(slide + 1)}
        className={arrowCls}
      >
        {navChevron('M9 6l6 6-6 6')}
      </button>
    </div>
  )
}

const IntroSlides = ({ hidden, slide, onGo }: { hidden: boolean; slide: number; onGo: (i: number) => void }) => (
  <section hidden={hidden} className="intro mx-auto flex min-h-[70vh] max-w-[1120px] flex-col justify-center gap-6">
    {/* Slide 1 — Why: the ecosystem around Notion (hub = source of truth) */}
    <section hidden={slide !== 0} className="w-full py-2">
      <div className="mb-1.5 text-[13px] text-fg-muted">Why</div>
      <h2 className="m-0 mb-6 text-[25px] font-bold tracking-tight">
        Notion, for users, developers, and agents
      </h2>
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
    <section hidden={slide !== 1} className="w-full py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[13px] text-fg-muted">
        <span className="text-fg-muted">{iconLego}</span> How
      </div>
      <h2 className="m-0 mb-5 text-[25px] font-bold tracking-tight">
        Principled Notion building blocks for agents and developers
      </h2>
      <HowGallery />
    </section>
    {/* Slide 3 — Disclaimer: these are inspiration, not a product. Copy left,
        full-color Notion-style "tinkerer's workbench" poster right. */}
    <section hidden={slide !== 2} className="w-full py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[13px] text-fg-muted">
        <span className="text-fg-muted">{iconBulb}</span> Disclaimer
      </div>
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
              <span className="mt-0.5 flex-none text-[13px] font-bold tabular-nums text-accent">
                {p.num}
              </span>
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
    <IntroSlideNav slide={slide} onGo={onGo} />
  </section>
)

/**
 * Intro deck: the first tab's three-slide "why → how → disclaimer" story, shown
 * one slide at a time. Owns the current slide index and the ← / → keyboard nav
 * (active only while the deck is visible), delegating the slide markup to
 * IntroSlides. Slides stay mounted (HowGallery keeps its tab state) and toggle
 * via `hidden`.
 */
export const IntroPanel = ({ hidden }: { hidden: boolean }) => {
  const [slide, setSlide] = useState(0)
  const go = useCallback((i: number) => setSlide(Math.max(0, Math.min(i, SLIDE_LABELS.length - 1))), [])
  useEffect(() => {
    if (hidden === true) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey === true || e.ctrlKey === true || e.altKey === true) return
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      if (e.key === 'ArrowRight') setSlide((c) => Math.min(c + 1, SLIDE_LABELS.length - 1))
      else if (e.key === 'ArrowLeft') setSlide((c) => Math.max(c - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hidden])
  return <IntroSlides hidden={hidden} slide={slide} onGo={go} />
}
