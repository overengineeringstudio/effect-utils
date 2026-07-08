import type { ReactNode } from 'react'

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

// Inline actor/motif icons (currentColor → theme-aware). Kept tiny and line-art
// to match the dashboard's restrained visual language.
// Tiny monochrome glyphs for the chat mockup (currentColor → theme-aware).
const g = (d: string): ReactNode => (
  <svg
    width="8"
    height="8"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={d} />
  </svg>
)
const gBulb = g('M6 11h4M6.5 13h3M8 2a4 4 0 0 1 2.5 7.2V11h-5V9.2A4 4 0 0 1 8 2z')
const gPencil = g('M11 2.5l2.5 2.5L6 12.5 3 13.5l1-3z')
const gSearch = g('M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM11 11l3 3')
const gChevD = g('M4 6l4 4 4-4')
const gChevR = g('M6 4l4 4-4 4')
const gGlobe = g(
  'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM1.5 8h13M8 1.5c2 2 2 11 0 13M8 1.5c-2 2-2 11 0 13',
)

// ---------------------------------------------------------------------------
// Miniature "native UI" mockups — theme-aware; all styling lives in index.css
// under the `.intro` scope. Each is a small faux screenshot of the real thing.
// ---------------------------------------------------------------------------
// A Notion to-do block (bespoke, app-side — NOT a kit restyle so it can't leak
// into other kit surfaces). `done` = checked + strikethrough; `k` keys hover anims.
const Todo = ({
  done = false,
  k,
  children,
}: {
  done?: boolean
  k?: string
  children: ReactNode
}) => (
  <div className={done === true ? 'blk todo done' : 'blk todo'} data-k={k}>
    <span className="cbx" aria-hidden="true" />
    <span className="lbl">{children}</span>
  </div>
)

// mini Notion page — a rendered Notion doc. Shares its to-do list 1:1 with the
// .md pane (block 01) so the sync animation shows the SAME item flip on both ends.
export const MiniNotionPage = () => (
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
      <Todo done k="fin">
        Finalize the API spec
      </Todo>
      <Todo k="ship">Ship v1</Todo>
    </NotionPage>
  </NotionSurface>
)

// mini .md file (kit editor, markdown syntax) — same to-do list as MiniNotionPage.
export const MiniMdFile = () => (
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
export const MiniNotionApp = () => (
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
export const MiniChat = () => (
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
      <div className="resp">
        All set — your bug tracker is live in Notion, pulling from Slack, Notion &amp; email;
        duplicates grouped.
      </div>
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
export const MiniIDE = () => (
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
export const MiniTerminal = () => (
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
      <span className="cc-file" data-k="cc">
        roadmap.md
      </span>
      <span className="cc-tool">)</span>
    </TerminalLine>
    <TerminalLine out>
      <span className="cc-ln">⎿ </span> <span className="del">- [ ] Ship v1</span>
    </TerminalLine>
    <TerminalLine out>
      {'   '}
      <span className="add" data-k="cc2">
        + [x] Ship v1
      </span>
    </TerminalLine>
    <TerminalLine out>
      <span className="recvln" data-k="cc3">
        → reflected to Notion ✓
      </span>
    </TerminalLine>
  </Terminal>
)

// mini workflow graph (Notion ⇄ external systems) — automations. No kit
// equivalent, so bespoke SVG inside kit window chrome; styled app-side (.pflow).
export const MiniFlow = () => (
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
const SqSwap = ({
  k,
  was,
  wasCls,
  now,
}: {
  k: string
  was: string
  wasCls: string
  now: string
}) => (
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
export const MiniNotionDb = ({ flip = false }: { flip?: boolean }) => (
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
              <SqSwap k="sq-n2" was={'In Progress'} wasCls="st-prog" now="Done" />
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
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M5.5 8l4.5 4.5L14.5 8" />
  </svg>
)
const tMulti = (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="4" cy="5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="4" cy="10" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="4" cy="15" r="1.2" fill="currentColor" stroke="none" />
    <path d="M8 5h9M8 10h9M8 15h6" />
  </svg>
)
const tDate = (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="10" cy="10" r="7.3" />
    <path d="M10 5.6V10l3 1.8" />
  </svg>
)

// a Notion property row: [type icon] name · (optional select options) · chevron
const PropRow = ({
  icon,
  name,
  opts,
  k,
}: {
  icon: ReactNode
  name: string
  opts?: string
  k?: string
}) => (
  <div className="np-row" data-k={k}>
    <span className="np-ic">{icon}</span>
    <span className="np-nm">{name}</span>
    {opts !== undefined && <span className="np-opts">{opts}</span>}
    <span className="np-cv">›</span>
  </div>
)

// The Notion side of the SCHEMA block: a PROPERTIES view (property name + type),
// 1:1 with schema.gen.ts. Status is a select whose options generate the literal.
export const MiniNotionProps = () => (
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
      <span className="recvln" data-k="sql">
        1 row updated · synced to Notion ✓
      </span>
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
export const MiniLocalSqlite = () => (
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
export const MiniSchemaCode = () => (
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
export const MiniJsx = () => (
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
export const MiniReactPage = () => (
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
        <span className="swap" data-k="rbudget">
          <span className="s-was">↳ budget…</span>
          <span className="s-now">↳ budget $42k</span>
        </span>
      </div>
    </NotionPage>
  </NotionSurface>
)
// Official Notion "N" logo — single path, currentColor (theme-aware, CSP-safe).
const NotionMark = ({ size = 20, className }: { size?: number; className?: string }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    role="img"
    aria-label="Notion"
  >
    <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952l1.448.328s0 .84-1.168.84l-3.222.186c-.093-.187 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.746l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.216-1.632z" />
  </svg>
)
// Notion mark on a fixed white tile (near-black mark) — same in both themes, like
// the real app icon. Used wherever Notion is the branded chip (hub, title bars).
export const NotionChip = ({ size = 16 }: { size?: number }) => (
  <span className="intro-nchip">
    <NotionMark size={size} />
  </span>
)
// A Notion window title: white N chip + "Notion" label (for NotionSurface bars).
const notionTitle = <WinTitle icon={<NotionChip size={12} />} label="Notion" />

// ── per-block iconic technology logos (self-contained inline SVG, theme-aware) ──
// Markdown mark (rounded rect border + "M▼").
export const mdLogo = (
  <svg width="20" height="14" viewBox="0 0 208 128" aria-label="Markdown">
    <rect
      x="5"
      y="5"
      width="198"
      height="118"
      rx="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="10"
    />
    <path
      fill="currentColor"
      d="M30 98V30h19l20 25 20-25h19v68H108V59l-19 24-20-24v39zm128 0-30-33h19V30h20v35h20z"
    />
  </svg>
)
// SQLite feather.
export const sqliteLogo = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-label="SQLite"
  >
    <path d="M21 3.5C13.4 4 7.3 8.9 5.6 16.3c-.35 1.5-.5 3-.5 4.2" />
    <path d="M19.2 5.4C13.6 6.3 9.4 10.2 7.7 15.6" />
    <path d="M17.4 7.6c-3.9 1.1-6.7 3.9-8.2 7.7" />
    <path d="M5.1 20.5 8 17.4" />
  </svg>
)
// React atom (iconic cyan; legible on both themes).
export const reactLogo = (
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
export const schemaMark = (
  <svg
    width="22"
    height="16"
    viewBox="0 0 30 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.25"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-label="schema round-trip"
  >
    <ellipse cx="5" cy="4.5" rx="4" ry="1.7" />
    <path d="M1 4.5v6.5c0 .95 1.8 1.7 4 1.7s4-.75 4-1.7V4.5" />
    <path d="M24 3.5c-1.1 0-1.6.6-1.6 1.6S22.9 7 21.8 8c1.1 1 1.6 1.4 1.6 2.4s-.5 1.6.6 1.6" />
    <path d="M25.5 3.5c1.1 0 1.6.6 1.6 1.6S27.6 7 28.7 8c-1.1 1-1.6 1.4-1.6 2.4s.5 1.6-.6 1.6" />
    <path d="M10 6.5h8.5M16.5 5 18.5 6.5l-2 1.5" />
    <path d="M18.5 11h-8.5M12 9.5 10 11l2 1.5" />
  </svg>
)
