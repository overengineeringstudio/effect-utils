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

// Hand-drawn "ink" turbulence filters — feTurbulence + feDisplacementMap nudge
// clean vectors into wobbly hand-drawn linework. `#intro-ink` (low displacement
// relative to a big 200-unit viewBox) is for the large doodle; `#intro-ink2`
// (higher displacement) is for the small 24-unit mascot glyphs. Defined ONCE for
// the whole deck via a zero-size absolutely-positioned <svg> (NOT display:none —
// filters inside a hidden subtree silently no-op in some engines).
const InkDefs = () => (
  <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
    <defs>
      <filter id="intro-ink" x="-20%" y="-20%" width="140%" height="140%">
        {/* LOW baseFrequency → the noise field varies slowly, so neighbouring
            points on a stroke displace together and the line undulates like a
            pen wobble instead of jumping in rectilinear "steps". A moderate
            `scale` keeps that wobble continuous; the extra octave adds fine
            grain without re-introducing jitter. */}
        <feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves={3} seed={7} result="n" />
        <feDisplacementMap in="SourceGraphic" in2="n" scale="2.7" xChannelSelector="R" yChannelSelector="G" />
      </filter>
      <filter id="intro-ink2" x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves={2} seed={2} result="n" />
        <feDisplacementMap in="SourceGraphic" in2="n" scale="1.6" />
      </filter>
    </defs>
  </svg>
)

// Bright saturated Notion "mascot" chip holding a white line-icon. Notion's own
// convention: rounded-SQUARES carry object icons, CIRCLES carry face/character
// icons. `tone` picks one of the saturated mascot colors (--m-*, defined in CSS,
// deliberately theme-INVARIANT so white strokes always read on the fill). Each
// glyph runs through the `#intro-ink2` filter so it looks hand-inked.
type MascotTone = 'blue' | 'gold' | 'purple' | 'teal' | 'green'
const MascotChip = ({
  tone,
  round = false,
  lg = false,
  children,
}: {
  tone: MascotTone
  round?: boolean
  lg?: boolean
  children: ReactNode
}) => (
  <span
    className={['intro-mascot', round === true ? 'round' : '', lg === true ? 'lg' : ''].filter(Boolean).join(' ')}
    style={{ background: `var(--m-${tone})` }}
    aria-hidden="true"
  >
    <svg
      viewBox="0 0 24 24"
      filter="url(#intro-ink2)"
      fill="none"
      stroke="#fff"
      strokeWidth={2.1}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  </span>
)

// The four actor mascots (+ automations). Left "Knowledge work" column reads as
// characters → CIRCLES (a person avatar, a friendly bot face); right "Engineering"
// column reads as objects → rounded-SQUARES (code braces, a terminal). Colors are
// drawn from the mockup's blue / gold / purple / teal palette.
const icUsers = (
  <MascotChip tone="blue" round>
    <circle cx="12" cy="8.4" r="3.4" />
    <path d="M6 19a6 6 0 0 1 12 0" />
  </MascotChip>
)
const icSparkle = (
  <MascotChip tone="gold" round>
    <path d="M12 3.5v2" />
    <circle cx="12" cy="3" r="0.6" fill="#fff" stroke="none" />
    <rect x="5.6" y="6" width="12.8" height="12" rx="4" />
    <circle cx="9.6" cy="12" r="1.05" fill="#fff" stroke="none" />
    <circle cx="14.4" cy="12" r="1.05" fill="#fff" stroke="none" />
    <path d="M9.6 15q2.4 1.9 4.8 0" />
  </MascotChip>
)
const icBraces = (
  <MascotChip tone="purple">
    <path d="M9.5 5s-3.5 1.3-3.5 7 3.5 7 3.5 7" />
    <path d="M14.5 5s3.5 1.3 3.5 7-3.5 7-3.5 7" />
  </MascotChip>
)
const icTerminal = (
  <MascotChip tone="teal">
    <rect x="4" y="5.5" width="16" height="13" rx="2.5" />
    <path d="M7.5 10l3 2.4-3 2.4M12.6 15h4" />
  </MascotChip>
)
const icGear = (
  <MascotChip tone="green">
    <path d="M4 8.5a7.5 7.5 0 0 1 12.2-2l1.8 1.9" />
    <path d="M20 15.5a7.5 7.5 0 0 1-12.2 2l-1.8-1.9" />
    <path d="M18.5 4.5v4h-4M5.5 19.5v-4h4" />
  </MascotChip>
)

// Always-on "signature" hero cluster: a row of four BIG bright mascot chips that
// sits directly under the slide-1 headline, so the intro's INITIAL state is
// unmistakably Notion + colorful before the presenter clicks anything (the actor
// mascots only appear on click-reveal). All four carry OBJECT icons, so per Notion
// convention they're rounded-squares (no `round`): a page-with-check (blue), a
// two-way sync cycle (teal), code braces (purple), a database cylinder (gold).
// Each glyph is a white line-icon inked via `#intro-ink2`, same as the actor chips.
const HeroMascots = () => (
  <div className="intro-hero-mascots" aria-hidden="true">
    <MascotChip tone="blue" lg>
      <path d="M6.5 4.4a1.4 1.4 0 0 1 1.4-1.4H14l4 4v11.6a1.4 1.4 0 0 1-1.4 1.4H7.9a1.4 1.4 0 0 1-1.4-1.4z" />
      <path d="M14 3v4h4" />
      <path d="M8.7 13.2l2.2 2.2 4-4.4" />
    </MascotChip>
    <MascotChip tone="teal" lg>
      <path d="M5 9.2a7 7 0 0 1 11.6-3.1L19 8.4" />
      <path d="M19 14.8a7 7 0 0 1-11.6 3.1L5 15.6" />
      <path d="M19 4.2v4.2h-4.2" />
      <path d="M5 19.8v-4.2h4.2" />
    </MascotChip>
    <MascotChip tone="purple" lg>
      <path d="M9.5 5s-3.5 1.3-3.5 7 3.5 7 3.5 7" />
      <path d="M14.5 5s3.5 1.3 3.5 7-3.5 7-3.5 7" />
    </MascotChip>
    <MascotChip tone="gold" lg>
      <ellipse cx="12" cy="6.2" rx="6.4" ry="2.8" />
      <path d="M5.6 6.2v11.6c0 1.55 2.86 2.8 6.4 2.8s6.4-1.25 6.4-2.8V6.2" />
      <path d="M5.6 12c0 1.55 2.86 2.8 6.4 2.8s6.4-1.25 6.4-2.8" />
    </MascotChip>
  </div>
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

// Signature hand-drawn doodle for the "Why" hero: an inky browser window holding
// a few Notion "blocks", with a little orange reader-mascot peeking from the top
// corner. The linework is `currentColor` (theme-aware → inherits the slide's ink)
// run through `#intro-ink` so it reads sketched, not vector-clean; only the mascot
// face uses a fixed saturated fill. Purely decorative accent beside the headline.
const WhyDoodle = ({ className }: { className?: string }) => (
  <svg
    id="why-doodle"
    className={className}
    width="168"
    height="139"
    viewBox="0 0 212 176"
    fill="none"
    aria-hidden="true"
    style={{ color: 'var(--color-fg-muted)' }}
  >
    <g
      filter="url(#intro-ink)"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    >
      {/* browser frame + address bar */}
      <path
        strokeWidth={2.7}
        d="M20 44 q-2 -1 -3 3 l-1 92 q0 5 5 5 l150 -1 q5 0 5 -5 l1 -94 q0 -4 -5 -4 l-118 1"
      />
      <path strokeWidth={2.1} d="M15 66 l162 -1" />
      <circle strokeWidth={1.9} cx="31" cy="55" r="2.4" />
      <circle strokeWidth={1.9} cx="41" cy="55" r="2.2" />
      <circle strokeWidth={1.9} cx="51" cy="55" r="2.5" />
      {/* three Notion blocks: check + wobbly text lines */}
      <rect strokeWidth={2} x="33" y="83" width="9" height="8" rx="1.6" />
      <path strokeWidth={2.4} d="M52 87 q24 -4 47 -1 t45 2" />
      <rect strokeWidth={2} x="33" y="101" width="8" height="9" rx="1.6" />
      <path strokeWidth={2.1} d="M52 106 q20 -3 38 1 t36 0" />
      <rect strokeWidth={2} x="33" y="120" width="9" height="8" rx="1.6" />
      <path strokeWidth={2.6} d="M52 124 q26 -2 52 1 t48 -2" />
      {/* a little cursor arrow */}
      <path strokeWidth={2.4} fill="currentColor" d="M150 112 l18 9 l-7 2 l4 10 l-5 2 l-4 -10 l-6 5 z" />
    </g>
    {/* reader mascot: circle face, uneven glasses, inky (fixed saturated fill) */}
    <g transform="translate(158 18)" filter="url(#intro-ink2)">
      <circle cx="26" cy="26" r="25" fill="var(--m-gold)" />
      <g stroke="#fff" strokeLinecap="round" fill="none">
        <circle strokeWidth={2.5} cx="18" cy="25" r="6" />
        <circle strokeWidth={2.5} cx="34" cy="24" r="5.3" />
        <path strokeWidth={2.3} d="M24 25 q2 1 4 -0.5" />
        <path strokeWidth={2.1} d="M9 22 q1 -5 7 -4 M39 20 q6 0 6 5" />
        <path strokeWidth={2.4} d="M19 37 q7 4 14 -1" />
      </g>
    </g>
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
        {icon}
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
    name: string
    icon: ReactNode
    body: ReactNode
  }[] = [
    {
      key: 'md',
      name: 'notion md',
      icon: mdLogo,
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
      name: 'notion sqlite',
      icon: sqliteLogo,
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
      name: 'notion schema',
      icon: schemaMark,
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
      name: 'notion-react',
      icon: reactLogo,
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
    <div className="flex flex-col gap-10">
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
      {/* active block — just the mockup pair; the tab above carries the name */}
      {b.body}
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

// GitHub mark (Octocat silhouette) — for the Slide-3 "browse the source" CTA.
const ghLogo = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
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

// Slide-1 "Why" node reveal: presenter clicks through the diagram one node at
// a time — top pair (users, developers), then the second pair (productivity
// agents, coding agents), then the automations block — instead of dumping the
// whole hub-and-spoke diagram at once. Hidden nodes stay `invisible` (not
// unmounted) so the layout never reflows; revealed nodes just fade in place.
const SLIDE1_NODE_COUNT = 5

const Slide1 = ({ active }: { active: boolean }) => {
  const [revealed, setRevealed] = useState(0)
  // re-entering slide 1 (nav away and back) restarts the narration
  useEffect(() => {
    if (active) setRevealed(0)
  }, [active])
  // no explicit `visible` here: `visibility` is inherited, and an explicit
  // `visible` on a shown node would override the *parent* slide section's
  // `invisible` once the presenter moves off slide 1 — leave the property
  // unset so it just inherits whatever the parent section is doing.
  const reveal = (i: number) =>
    `transition-opacity duration-300 ${i < revealed ? 'opacity-100' : 'invisible opacity-0'}`
  return (
    <div className="cursor-pointer" onClick={() => setRevealed((n) => Math.min(n + 1, SLIDE1_NODE_COUNT))}>
      <div className="mb-6 flex items-start justify-between gap-6">
        <div>
          <div className="mb-1.5 text-[13px] text-fg-muted">Why</div>
          <h2 className="m-0 text-[25px] font-bold tracking-tight">
            Notion, for users, developers, and agents
          </h2>
          {/* always-on signature: colourful Notion mascot chips, right under the
              headline — the slide's default state is Notion from the first frame */}
          <HeroMascots />
        </div>
        {/* pushed down (mt-12) so its top-corner reader-mascot clears the slide
            nav pinned top-right; smaller so it reads as a tucked hero accent
            rather than fighting the new mascot cluster */}
        <WhyDoodle className="mt-12 -mr-1 hidden flex-none lg:block" />
      </div>
      <div className="flex flex-wrap items-stretch justify-center gap-2">
        {/* Knowledge work — each actor has its own hand-drawn arrow to the hub */}
        <div className="flex min-w-[290px] flex-1 flex-col gap-2.5">
          <div className="text-[11px] text-fg-faint">Knowledge work</div>
          <div className={`flex items-center gap-1.5 ${reveal(0)}`}>
            <div className="min-w-0 flex-1">
              <ActorCard icon={icUsers} mock={<MiniNotionApp />} name="users" />
            </div>
            <HandArrow />
          </div>
          <div className={`flex items-center gap-1.5 ${reveal(2)}`}>
            <div className="min-w-0 flex-1">
              <ActorCard icon={icSparkle} mock={<MiniChat />} name="productivity agents" />
            </div>
            <HandArrow />
          </div>
        </div>
        {/* Notion hub — always visible, the anchor of the diagram */}
        <div className="flex min-w-[144px] flex-col items-center justify-center rounded-2xl border-2 border-accent/50 bg-accent/5 px-6 py-5 text-center">
          <span className="mb-1.5 inline-flex">
            <NotionChip size={26} />
          </span>
          <span className="text-[16px] font-bold leading-tight">Notion</span>
        </div>
        {/* Engineering */}
        <div className="flex min-w-[290px] flex-1 flex-col gap-2.5">
          <div className="text-right text-[11px] text-fg-faint">Engineering</div>
          <div className={`flex items-center gap-1.5 ${reveal(1)}`}>
            <HandArrow />
            <div className="min-w-0 flex-1">
              <ActorCard re icon={icBraces} mock={<MiniIDE />} name="developers" />
            </div>
          </div>
          <div className={`flex items-center gap-1.5 ${reveal(3)}`}>
            <HandArrow />
            <div className="min-w-0 flex-1">
              <ActorCard re icon={icTerminal} mock={<MiniTerminal />} name="coding agents" />
            </div>
          </div>
        </div>
      </div>
      {/* automations & integrations — its own arrow up to the hub */}
      <div className={`mt-2 flex flex-col items-center gap-1 ${reveal(4)}`}>
        <HandArrow vertical />
        <div className="flex w-full max-w-[440px] items-center gap-3.5 p-1">
          <div className="w-[200px] flex-none">
            <MiniFlow />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold">
              {icGear}automations &amp; integrations
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const IntroSlides = ({ hidden, slide, onGo }: { hidden: boolean; slide: number; onGo: (i: number) => void }) => (
  <section hidden={hidden} className="intro relative mx-auto min-h-[70vh] max-w-[1120px] pt-2">
    {/* hand-drawn "ink" filter defs — rendered once for the whole deck */}
    <InkDefs />
    {/* slide controls — pinned top-right so they never move between slides */}
    <div className="absolute right-0 top-0 z-10">
      <IntroSlideNav slide={slide} onGo={onGo} />
    </div>
    {/* stage: all three slides stacked in ONE grid cell, so the frame is always
        as tall as the tallest slide and the kicker/headline never shift when
        switching. Inactive slides use `invisible` (keeps layout → stable frame),
        NOT `hidden` (which collapses the frame and makes the header jump). */}
    <div className="grid">
      {/* Slide 1 — Why: the ecosystem around Notion (hub = source of truth) */}
      <section aria-hidden={slide !== 0} className={`col-start-1 row-start-1 w-full py-2 ${slide === 0 ? '' : 'invisible'}`}>
      <Slide1 active={slide === 0} />
    </section>
      {/* Slide 2 — How: building blocks that snap together */}
      <section aria-hidden={slide !== 1} className={`col-start-1 row-start-1 w-full py-2 ${slide === 1 ? '' : 'invisible'}`}>
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
      <section aria-hidden={slide !== 2} className={`col-start-1 row-start-1 w-full py-2 ${slide === 2 ? '' : 'invisible'}`}>
      <div className="mb-1.5 flex items-center gap-1.5 text-[13px] text-fg-muted">
        <span className="text-fg-muted">{iconBulb}</span> Disclaimer
      </div>
      <h2 className="m-0 mb-6 text-[25px] font-bold tracking-tight">Inspiration, not a product.</h2>
      <div className="flex flex-wrap items-center gap-x-12 gap-y-8">
        {/* left column: the three points + a soft CTA to the source repo */}
        <div className="flex min-w-[300px] max-w-[460px] flex-1 flex-col gap-7">
          <ol className="m-0 flex list-none flex-col gap-5 p-0">
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
          {/* soft CTA — the tools live here as a public reference, not a product */}
          <a
            href="https://github.com/overengineeringstudio/effect-utils"
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-2 rounded-lg border border-border bg-bg-panel px-3.5 py-2 text-[13px] font-medium text-fg-muted transition hover:border-border-strong hover:text-fg"
          >
            <span className="inline-flex h-4 w-4 flex-none">{ghLogo}</span>
            <span className="font-mono">overengineeringstudio/effect-utils</span>
            <span className="text-fg-faint">↗</span>
          </a>
        </div>
        {/* full-color poster on its own warm cream inset (fixed in both themes) */}
        <div className="intro-poster min-w-[320px] flex-1">
          <WorkbenchPoster />
        </div>
      </div>
      </section>
    </div>
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
