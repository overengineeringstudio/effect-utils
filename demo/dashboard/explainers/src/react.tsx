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
  Cm,
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

/** beat 4 — the blockKey → notion block id map (identity survives restarts). */
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
        The same page: block-by-block API calls — or <em>one JSX component</em>.
      </h2>
      <div className="stage">
        <div className="ways">
          <div className="waylist">
            <div className="wayrow">
              <div className="waylabel">
                <span className="wayname">block API</span>
                <span className="waykind">imperative</span>
                <span className="waymark">✗ every run</span>
              </div>
              <div className="waycode">
                <div>
                  <Cm>// change one line → the only API is:</Cm>
                </div>
                <div>
                  blocks.delete(id) <Cm>…×N · tear down</Cm>
                </div>
                <div>
                  blocks.append(block) <Cm>…×N · rebuild</Cm>
                </div>
                <div>
                  <Cm>// …or hand-roll a keyed diff + cache yourself</Cm>
                </div>
              </div>
            </div>
            <div className="wayrow win">
              <div className="waylabel">
                <span className="wayname">a component</span>
                <span className="waykind">declarative</span>
                <span className="waymark">✓ updates: 1</span>
              </div>
              <div className="waycode">
                <div>
                  <Cm>// write the page you want:</Cm>
                </div>
                <div>
                  <KW>const</KW> <Tg>Page</Tg> = () =&gt; &lt;<Tg>Doc</Tg>&gt;…&lt;/<Tg>Doc</Tg>&gt;
                </div>
                <div>
                  <Cm>$</Cm> bun run page.tsx <Cm>// rerun → only the changed block: updates: 1</Cm>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="caption">
        <b>Notion's block API is imperative — append / update / delete against block ids.</b>{' '}
        <span className="hint">
          Re-render a page and you wipe-and-re-append every block, or hand-roll a keyed diff yourself. Write the page as
          a component instead: rerun, and only the block that changed updates.
        </span>
      </p>
    </Beat>

    {/* BEAT 2 — HOW IT WORKS */}
    <Beat num="02" tag="How it works">
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

    {/* BEAT 3 — WHAT IT ENABLES */}
    <Beat num="03" tag="What it enables">
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
        ✓ …and identity survives restarts — <b>the diff is keyed, not positional</b>
      </div>
    </Beat>

    {/* CODA — GOING DEEPER */}
    <Beat num="04" tag="The toolkit" coda>
      <h2>
        Everything <em>notion-react</em> does.
      </h2>
      <div className="stage">
        <div className="features">
          <div className="fcard">
            <div className="ft">
              <span className="fico">⚛</span> Page as a component
            </div>
            <div className="fb">
              Author a Notion page as JSX; <code>bun run page.tsx</code> renders it to real blocks.
            </div>
          </div>
          <div className="fcard">
            <div className="ft">
              <span className="fico">⇄</span> Block-level diff
            </div>
            <div className="fb">
              Rerun applies only what changed (<code>updates: 1</code>) — no rebuild, no duplication.
            </div>
          </div>
          <div className="fcard">
            <div className="ft">
              <span className="fico">⎇</span> Stable identity
            </div>
            <div className="fb">
              Each block carries a <code>blockKey</code>; a persisted <code>.notion-cache.json</code> maps it to the
              real Notion id, so identity survives restarts.
            </div>
          </div>
          <div className="fcard">
            <div className="ft">
              <span className="fico">✓</span> Precise ops
            </div>
            <div className="fb">add → create · remove → archive · change → update, with op counts surfaced.</div>
          </div>
          <div className="fcard">
            <div className="ft">
              <span className="fico">◷</span> Idempotent reruns
            </div>
            <div className="fb">
              No change → a clean no-op (<code>appends:0 updates:0 removes:0</code>).
            </div>
          </div>
          <div className="fcard">
            <div className="ft">
              <span className="fico">◆</span> Typed &amp; composable
            </div>
            <div className="fb">Plain React — typed components, props, and loops compose the page.</div>
          </div>
        </div>
      </div>
    </Beat>
  </div>
)
