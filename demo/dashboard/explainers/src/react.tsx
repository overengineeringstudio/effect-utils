/**
 * react.tsx — the port of notion-react: "write a Notion page as JSX; a reconciler
 * emits only the block ops that changed". Composed from the shared kit + a local
 * fixture island + a `syncStory` step-model encoding the CORRECT causal sequence
 * (and FAILING THE BUILD if it is inverted).
 *
 * THE LOAD-BEARING CAUSAL FIX (causality review §2 [HIGH] step-3): the rendered
 * Notion block must update AFTER the source edit + rerun/sync — never at the same
 * instant as the edit. The original HTML forced the IDE `budget` swap and the
 * Notion block swap onto ONE shared `.swap` rule (both flipped at t=0 of step 3);
 * this port separates cause (IDE, ungated at step-3 entry) from effect (Notion,
 * gated behind the packet's ~1.45s arrival) via `syncStory`'s intra-step gate.
 *
 * The story (exported for the causality proof):
 *   step 1  the JSX program + an empty/target Notion page (idle)
 *   step 2  `bun run page.tsx` → the whole page materializes (appends:5),
 *           gated to the first sync packet's arrival
 *   step 3  edit ONE line (the `budget` const, at step entry — the CAUSE) + rerun;
 *           ONLY the Phase-2 block updates (updates:1), gated to the packet's
 *           arrival (the EFFECT lags the edit — the review's headline fix)
 *   step 4  rerun unchanged → a genuine no-op (0 0 0)
 * The kit CSS + react.css gates realize these delays; the model asserts the order.
 */
import {
  Beat,
  Cursor,
  Flow,
  KW,
  MiniIDE,
  NotionSurface,
  OK,
  Prompt,
  STR,
  Sequence,
  Swap,
  Terminal,
  TerminalLine,
  Tg,
  type IdeTreeItem,
  type NotionNav,
} from '../../kit/components.tsx'
import { captionsToSteps, syncStory } from '../../kit/syncStory.ts'

// ── the fixture island (spec §3: react is its own island — NOT the shared Tasks
//    rows; inlined here rather than in the shared fixtures.ts) ─────────────────
/** beat 2 — the `Launch` page. One `budget` swap value, rendered in TWO panes
 *  (the IDE source literal + the rendered Notion block) but gated independently. */
const LAUNCH = {
  file: 'src/page.tsx',
  pageTitle: 'Launch',
  heading: '🚀 Launch Plan',
  phases: ['Phase 1 · Alpha', 'Phase 2 · Beta — ', 'Phase 3 · GA'] as const,
  budget: { was: '$40k', now: '$80k' },
  // op counts, exact + load-bearing (the "reveal" the viewer reads)
  run1: 'appends:5 updates:0 removes:0',
  run2: 'appends:0 updates:1 removes:0',
  run3: 'appends:0 updates:0 removes:0',
} as const

/** beat 1 — the raw-API churn page (`🚀 Q2 Plan`; one line: Draft → Final). */
const Q2_CHURN = {
  page: 'Q2 Plan',
  blocks: [
    { text: 'Final', tag: 'delete → re-create' },
    { text: 'Scope', tag: 're-created' },
    { text: 'Ship it', tag: 're-created' },
  ],
} as const

/** beat 4 — the blockKey → notion block id map (identity survives restarts). */
const BLOCKKEY_MAP = [
  { key: 'b:overview', id: 'block_a1b2…' },
  { key: 'b:scope', id: 'block_c3d4…' },
  { key: 'b:ship', id: 'block_e5f6…' },
] as const

// ── the declarative causal model (asserted at build time) ─────────────────────
/** Constructing this asserts cause-before-effect; a violation throws
 *  `CausalityError` and fails the build (no html is written). The load-bearing
 *  hop is step 3: the IDE edit (cause, step-entry) → the Notion block update
 *  (effect, gated to the ~1.45s packet arrival). Cause and effect SHARE step 3;
 *  the intra-step `{step,delay}` gate is what keeps the effect behind the cause. */
export const reactStory = syncStory({
  steps: captionsToSteps([
    'A Notion page, written as a React component.',
    'Run it → the whole page appears.',
    'Change one line, rerun → only that block updates.',
    'Unchanged → a genuine no-op (stable blockKey reconciliation).',
  ]),
  // the IDE `budget` edit — the CAUSE, at step-3 entry (delay 0, ungated)
  local: { pane: 'ide', swap: { was: LAUNCH.budget.was, now: LAUNCH.budget.now, at: { step: 3 } } },
  // the rerun packet: departs at step-3 entry, travels ~1.45s (matches the CSS pkttravel 1.45s)
  sync: { step: 3, duration: 1450 },
  // the Notion Phase-2 block — the EFFECT, gated to the packet ARRIVAL (~1.45s into step 3)
  remote: { pane: 'notion', swap: { was: LAUNCH.budget.was, now: LAUNCH.budget.now, at: { step: 3, delay: 1450 } } },
})

// The IDE edit swap (cause) is placed straight from the model.
const budgetSwap = reactStory.local!.swap
// The gated Notion-update confirmation line derives its reveal class from the
// model → `r3b` (packet-arrival), so the terminal cannot claim `updates:1`
// before the sync that produced it lands.
const updateReveal = reactStory.gatedRevealClass(reactStory.remote.swap.at) // → r3b

// ── beat 2 chrome ─────────────────────────────────────────────────────────────
const IDE_TREE: readonly IdeTreeItem[] = [
  { kind: 'fold', label: 'src' },
  { kind: 'file', label: 'page.tsx', icon: '◈', selected: true },
  { kind: 'file', label: 'blocks.tsx', icon: '▤' },
  { kind: 'file', label: 'notion.ts', icon: '▤' },
]

const NOTION_NAV: readonly NotionNav[] = [
  { icon: '🔍', label: 'Search' },
  { icon: '🚀', label: 'Launch', on: true },
  { icon: '📄', label: 'Docs' },
  { icon: '🗓', label: 'Roadmap' },
]

// ── beat 2 sequence ──────────────────────────────────────────────────────────
const SeeItWork = () => (
  <Sequence
    steps={reactStory.steps}
    legendCap="The whole flow, in four steps"
    stage={
      <>
        {/* LEFT: the JSX program (mini-IDE) + the terminal running it */}
        <div className="seq-col left">
          <MiniIDE file={LAUNCH.file} tag="tsx" tree={IDE_TREE} tab="page.tsx">
            {/* the edited line — its `budget` swap is the CAUSE (flips at step-3 entry) */}
            <div className="edit">
              <KW>const</KW> budget = <Swap was={<STR>{`"${budgetSwap.was}"`}</STR>} now={<STR>{`"${budgetSwap.now}"`}</STR>} />
            </div>
            <div>
              {'<'}
              <Tg>Page</Tg> <span className="at">title</span>=<STR>"{LAUNCH.pageTitle}"</STR>
              {'>'}
            </div>
            <div className="ind">
              {'<'}
              <Tg>Heading</Tg>
              {'>'}
              {LAUNCH.heading}
              {'</'}
              <Tg>Heading</Tg>
              {'>'}
            </div>
            <div className="ind">
              {'<'}
              <Tg>Divider</Tg> /{'>'}
            </div>
            <div className="ind">
              {'<'}
              <Tg>Toggle</Tg>
              {'>'}
              {LAUNCH.phases[0]}
              {'</'}
              <Tg>Toggle</Tg>
              {'>'}
            </div>
            <div className="ind">
              {'<'}
              <Tg>Toggle</Tg>
              {'>'}
              {LAUNCH.phases[1]}
              {'{budget}'}
              {'</'}
              <Tg>Toggle</Tg>
              {'>'}
            </div>
            <div className="ind">
              {'<'}
              <Tg>Toggle</Tg>
              {'>'}
              {LAUNCH.phases[2]}
              {'</'}
              <Tg>Toggle</Tg>
              {'>'}
            </div>
            <div>
              {'</'}
              <Tg>Page</Tg>
              {'>'}
            </div>
          </MiniIDE>

          <Terminal file="zsh — notion-react">
            <TerminalLine extra="only-1">
              <Prompt /> <Cursor />
            </TerminalLine>
            {/* run 1 — the command reveals at step-2 entry (cause) */}
            <TerminalLine extra="step-hide r2">
              <Prompt /> bun run page.tsx
            </TerminalLine>
            {/* run 1 result — gated to the first packet's arrival (r2a, ~1.45s) */}
            <TerminalLine out extra="step-hide r2a">
              <OK>✓</OK> synced → {LAUNCH.run1}
            </TerminalLine>
            {/* run 2 — edit + rerun; command at step-3 entry */}
            <TerminalLine extra="step-hide r3">
              <Prompt /> bun run page.tsx <span className="out">· edited budget</span>
            </TerminalLine>
            {/* run 2 result — gated to the packet arrival (r3b) so it can't claim
                `updates:1` while the flow still says "syncing…" */}
            <TerminalLine out extra={`step-hide ${updateReveal}`}>
              <OK>✓</OK> synced → {LAUNCH.run2}
            </TerminalLine>
            {/* run 3 — unchanged, genuine no-op at step-4 entry */}
            <TerminalLine extra="step-hide r4">
              <Prompt /> bun run page.tsx
            </TerminalLine>
            <TerminalLine out extra="step-hide r4">
              <OK>✓</OK> synced → {LAUNCH.run3} <OK>· no-op</OK>
            </TerminalLine>
          </Terminal>
        </div>

        {/* MIDDLE: reconcile flow (JSX → Notion), always left → right. The green
            `✓ verified` check is react-specific (spec note 6). */}
        <Flow done="synced" idle="idle" syncing="syncing…" />

        {/* RIGHT: the Notion surface as a rendered PAGE */}
        <div className="seq-col right">
          <NotionSurface workspace="Acme" workspaceInitial="A" nav={NOTION_NAV}>
            <div className="ntn-page">
              <div className="ntn-empty only-1">Empty page · run to render</div>
              <div className="blk h1 step-hide r2a">{LAUNCH.heading}</div>
              <div className="ntn-div step-hide r2a" />
              <div className="blk toggle step-hide r2a">
                <span className="tgl">▸</span>
                {LAUNCH.phases[0]}
                <span className="ntn-btag k">untouched</span>
              </div>
              {/* the single UPDATED block — swap gated to packet arrival; band + tag too */}
              <div className="blk toggle step-hide r2a ntn-upd">
                <span className="tgl">▸</span>
                {LAUNCH.phases[1]}
                <Swap was={budgetSwap.was} now={budgetSwap.now} />
                <span className="ntn-btag u">update</span>
              </div>
              <div className="blk toggle step-hide r2a">
                <span className="tgl">▸</span>
                {LAUNCH.phases[2]}
                <span className="ntn-btag k">untouched</span>
              </div>
            </div>
          </NotionSurface>
        </div>
      </>
    }
  />
)

// ── the full thread ──────────────────────────────────────────────────────────
export const React = () => (
  <div className="thread">
    {/* LEAD */}
    <header className="lead">
      <p className="kicker">Notion tooling · a thread</p>
      <h1>
        <code>notion-react</code> — write Notion pages as JSX
      </h1>
      <p>
        Describe a page as a React tree. A reconciler diffs it against the last sync and emits only the block ops that
        changed — no rebuild, no hand-tracking block ids.
      </p>
    </header>

    {/* BEAT 1 — THE PROBLEM */}
    <Beat num="01" tag="The problem">
      <h2>
        To change <em>one line</em> on a Notion page, the API makes you rebuild it.
      </h2>
      <div className="stage">
        <div className="s1">
          {/* raw block API: one-line intent explodes into wipe & re-append */}
          <div className="code raw">
            <div className="code-tabs">
              <span className="code-tab">
                <span className="tdot" />
                sync.ts
              </span>
              <span className="lang">raw API</span>
            </div>
            <div className="code-body">
              <div>
                <span className="cmw">// change ONE line: "Draft" → "Final"</span>
              </div>
              <div>
                <span className="cm">// but the only API you get is:</span>
              </div>
              <div>
                <span className="del">blocks.delete(b_01)</span>
              </div>
              <div>
                <span className="del">blocks.delete(b_02)</span>
              </div>
              <div>
                <span className="del">
                  blocks.delete(b_03) <span className="dots">…×N</span>
                </span>
              </div>
              <div>
                <span className="app">blocks.append(h1)</span>
              </div>
              <div>
                <span className="app">blocks.append(para)</span>
              </div>
              <div>
                <span className="app">
                  blocks.append(todo) <span className="dots">…×N</span>
                </span>
              </div>
            </div>
            <div className="code-run warn">
              <span className="play">⚠</span> wipe &amp; re-append <span className="rout">every run</span>
            </div>
          </div>

          {/* churn channel */}
          <div className="churnch">
            <div className="churn-badge">
              <span className="pulse" />
              rebuild
            </div>
            <div className="wires">
              <div className="wire">
                <span className="ah-r arrowhead" />
                <span className="packet" />
              </div>
              <div className="wlbl">delete all → append all</div>
            </div>
            <div className="churn-result">
              <span className="big">−N · +N</span>
              <span className="sm">O(blocks) churn</span>
            </div>
          </div>

          {/* notion page: EVERY block torn down & re-created */}
          <div className="churn-col">
            <div className="page">
              <div className="page-bar">
                <span className="pico">🚀</span>
                <span className="nm">{Q2_CHURN.page}</span>
                <span className="src">Notion</span>
              </div>
              <div className="page-body">
                <div className="blk h1 rebuilt">
                  {Q2_CHURN.blocks[0].text}
                  <span className="tag tag-x">{Q2_CHURN.blocks[0].tag}</span>
                </div>
                <div className="blk toggle rebuilt">
                  <span className="tgl">▸</span> {Q2_CHURN.blocks[1].text}
                  <span className="tag tag-x">{Q2_CHURN.blocks[1].tag}</span>
                </div>
                <div className="blk todo rebuilt">
                  <span className="cbx">☐</span> {Q2_CHURN.blocks[2].text}
                  <span className="tag tag-x">{Q2_CHURN.blocks[2].tag}</span>
                </div>
              </div>
            </div>
            <div className="churn-flag">
              💥 one line changed — <b>every block re-created</b>
            </div>
          </div>
        </div>
      </div>
      <p className="caption">
        <b>
          Notion's block API is raw and imperative — <code>append</code> / <code>update</code> / <code>delete</code>{' '}
          against block ids.
        </b>{' '}
        <span className="hint">
          To re-render a page you either wipe and re-append every block each run (churn, flicker, O(blocks) cost) or
          hand-roll a keyed diff, a cache, and a kill-switch yourself.
        </span>
      </p>
    </Beat>

    {/* BEAT 2 — SEE IT WORK */}
    <Beat num="02" tag="See it work">
      <h2>
        Write the page as a React component. Change one line, rerun — <em>only that block updates.</em>
      </h2>
      <div className="stage">
        <SeeItWork />
      </div>
      <p className="caption">
        <b>
          The page is a React component; <code>bun run page.tsx</code> reconciles it against the last sync.
        </b>{' '}
        <span className="hint">
          First run appends every block (<code>appends:5</code>). Change one line — the <code>budget</code> const — and
          rerun: only that block updates (<code>updates:1</code>); every other block keeps its Notion id. Run it again
          unchanged and it's a genuine no-op (<code>0 0 0</code>) — identity held by <code>blockKey</code>, not
          position.
        </span>
      </p>
    </Beat>

    {/* BEAT 3 — THE SHIFT */}
    <Beat num="03" tag="The shift">
      <h2>
        You <em>describe</em> the page. It computes the minimal block ops.
      </h2>
      <div className="stage">
        <div className="s3">
          {/* jsx tree = source of truth */}
          <div className="treecard">
            <div className="tree-frame">
              <div className="tree-bar">◆ your JSX tree</div>
              <div className="tree-body">
                <div className="n">{'<Page>'}</div>
                <div className="in">{'<Heading1>'}</div>
                <div className="in">{'<Toggle>'}</div>
                <div className="in">{'<ToDo>'}</div>
                <div className="n">{'</Page>'}</div>
              </div>
            </div>
            <div className="sot">◆ declarative · your source of truth</div>
          </div>
          {/* reconciler */}
          <div className="projarrow">
            <div className="plabel">
              reconciler
              <br />
              diffs vs last sync
            </div>
            <svg viewBox="0 0 118 26">
              <path d="M4 13 H104" stroke="currentColor" strokeWidth="1.8" fill="none" />
              <path d="M98 8 L108 13 L98 18 Z" fill="currentColor" />
            </svg>
          </div>
          {/* op summary */}
          <div className="opsum-wrap">
            <div className="opsum">
              <div className="opsum-inner">
                <div className="opsum-bar">SyncResult</div>
                <div className="oprow">
                  <span className="k">re-render identical</span>
                  <span className="v z">0 ops</span>
                </div>
                <div className="oprow">
                  <span className="k">change one prop</span>
                  <span className="v n">1 update</span>
                </div>
                <div className="oprow">
                  <span className="k">append a sibling</span>
                  <span className="v n">1 append</span>
                </div>
                <div className="oprow">
                  <span className="k">remove a sibling</span>
                  <span className="v n">1 remove</span>
                </div>
              </div>
            </div>
            <div className="opsum-cap">the exact minimum · every run</div>
          </div>
        </div>
      </div>
      <p className="caption">
        <b>Stop diffing block ids by hand.</b>{' '}
        <span className="hint">
          You hand it a tree; it reconciles against the last sync and returns a <code>SyncResult</code> — the exact{' '}
          <code>appends</code> / <code>updates</code> / <code>removes</code> it applied. Identical JSX is a{' '}
          <code>0</code>-op no-op.
        </span>
      </p>
      <div className="promise">
        ✓ …and identity survives restarts — <b>the diff is keyed, not positional</b>{' '}
        <span className="nxt">here's how ↓</span>
      </div>
    </Beat>

    {/* CODA — GOING DEEPER */}
    <div className="coda-rule">
      <span>Going deeper · optional</span>
    </div>
    <Beat num="04" tag="…and identity holds" coda>
      <h2>
        Every block carries a <em>blockKey</em>. That's how identity survives a restart.
      </h2>
      <div className="stage">
        <div className="keymap">
          {/* blockKey → notion id map */}
          <div className="keys">
            <div className="keys-bar">blockKey → notion block id</div>
            {BLOCKKEY_MAP.map((r) => (
              <div key={r.key} className="keyrow">
                <span className="bk">{r.key}</span>
                <span className="arr">→</span>
                <span className="id">{r.id}</span>
              </div>
            ))}
          </div>
          {/* persisted cache */}
          <div className="cachebadge">
            <svg viewBox="0 0 118 22">
              <path d="M4 11 H104" stroke="currentColor" strokeWidth="1.6" fill="none" />
              <path d="M98 6 L108 11 L98 16 Z" fill="currentColor" />
              <path d="M20 16 L10 11 L20 6" stroke="currentColor" strokeWidth="1.6" fill="none" />
            </svg>
            <div className="cb">FsCache</div>
            <div className="cl">
              .notion-cache.json
              <br />
              persisted, atomic
            </div>
          </div>
          {/* diff outcomes */}
          <div className="difftable">
            <div className="dbar">match a key → reuse · else…</div>
            <div className="drow">
              <span className="lbl">add a block</span>
              <span className="op c">create</span>
            </div>
            <div className="drow">
              <span className="lbl">remove a block</span>
              <span className="op a">archive</span>
            </div>
            <div className="drow">
              <span className="lbl">change props</span>
              <span className="op u">update</span>
            </div>
            <div className="drow">
              <span className="lbl">move a {'<ChildPage>'}</span>
              <span className="op m">
                pages.move <span className="soon">contract</span>
              </span>
            </div>
          </div>
        </div>
      </div>
      <p className="caption">
        <b>
          The diff is keyed on <code>blockKey</code>, not sibling position.
        </b>{' '}
        <span className="hint">
          Each rendered block matches a previously-synced Notion block through the persisted <code>FsCache</code>{' '}
          (<code>.notion-cache.json</code>) — so a match reuses the real block id, and identity holds across process
          restarts. add→create, remove→archive, change→update. Page-level <code>pages.move</code> is the designed
          contract (block ops ship today; page ops are next).
        </span>
      </p>
    </Beat>

    <p className="foot">
      What first-class would look like: Notion offering a declarative, diffable page API — hand it a tree, get the
      minimum ops. Until then, <code>notion-react</code> is that reconciler: JSX in, minimum block ops out, keyed on{' '}
      <code>blockKey</code>.
    </p>
  </div>
)
