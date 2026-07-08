/**
 * iac.tsx — the port of notion-schema-iac (3.2, PLANNED / roadmap-preview):
 * "declare the Notion database you want in a typed file, `plan` it, `apply` it —
 * additive-only, destructive changes fail closed." The honest inverse of codegen
 * (3.1): instead of reading Notion → code, a file provisions Notion, left → right.
 *
 * This is the ONE explainer that ships as a designed preview of an UNBUILT
 * front-end. Its whole framing rests on a decluttering decision that MUST NOT
 * regress on port:
 *   - a SINGLE sticky banner is the sole "planned" indicator (no per-beat pills,
 *     no per-terminal mock ribbons, no projected tags);
 *   - the provisioned Notion grid renders CLEAN / normal (never ghosted);
 *   - the flow is a NEUTRAL accent throughout — never green-verified (nothing
 *     here is a live write, so there is no `✓ verified`; contrast: react has one).
 * Color convention (load-bearing, kept disjoint): amber = PLANNED/preview only;
 * warn/red = destructive + blocked only.
 *
 * The causal step-model (exported for the build-time proof) applies the two
 * review fixes for beat 2:
 *   step 1  declare        — file shown; Notion empty ("no Tasks DB"); flow idle
 *   step 2  plan           — `plan` prints the would-create diff; Notion STILL
 *                            empty (plan makes no writes); flow idle, no packet
 *   step 3  apply          — the `apply` command departs at step entry (CAUSE);
 *                            the provisioned DB + terminal `done`/lock are GATED
 *                            behind the write packet's single-pass arrival (~1.4s)
 *                            (EFFECT) — never painted at t=0
 *   step 4  refuse         — a destructive re-run is BLOCKED (real guard names);
 *                            the flow takes a NON-POSITIVE / blocked state
 *                            (packet off, neutral — never accent-positive, never
 *                            green); the provisioned DB persists (a no-op refusal)
 *
 * No typewriter, no personas: every reveal is a block/opacity fade (the only live
 * cursor is the step-1 terminal block cursor).
 */
import {
  Beat,
  Cursor,
  DirFlow,
  MacWindow,
  MiniIDE,
  NotionSurface,
  PriorityPill,
  Sequence,
  Terminal,
  TerminalLine,
  WinTitle,
  nbsp,
  type IdeTreeItem,
  type NotionNav,
} from '../../kit/components.tsx'
import { captionsToSteps, syncStory } from '../../kit/syncStory.ts'

/**
 * The declarative causal model — the "apply" shape: a SINGLE gated hop with NO
 * distinct local-pane flip (the action IS the `apply` command at step-3 entry,
 * and the only effect is the remote one — Notion getting provisioned — gated to
 * the write packet's arrival). Constructing it ASSERTS cause-before-effect; an
 * inverted model (provisioned at t=0, before the packet lands) throws
 * `CausalityError` and fails the build.
 */
export const iacStory = syncStory({
  steps: captionsToSteps([
    'Declare the database you want — in a typed file.',
    'Plan shows exactly what it would create — before touching anything.',
    'Apply would provision it — reconciling the delta on every run.',
    'Additive only; anything that could lose data is refused.',
  ]),
  // the `apply` write packet departs at step-3 entry and travels ~1.4s (matches
  // the DirFlow `dpkttravel 1.4s` in the kit CSS + the iac.css ntn-swap gate).
  sync: { step: 3, duration: 1400 },
  // Notion provisions (empty → provisioned) gated to the packet ARRIVAL, NOT
  // step entry — the CAUSAL FIX. `pane: 'notion'` = the RIGHT / effect pane.
  remote: { pane: 'notion', swap: { was: 'empty', now: 'provisioned', at: { step: 3, delay: 1400 } } },
})

// The terminal `done` + lock-written lines derive their reveal class from the
// model, so the terminal cannot claim "done" before the write packet arrives:
// step 3 + delay>0 → `r3b` (gated at ~1.45s in the kit CSS, just after arrival).
const applyDoneReveal = iacStory.gatedRevealClass(iacStory.remote.swap.at) // → r3b

// ── the desired-state file (shared LEFT actor) ───────────────────────────────
const IDE_TREE: readonly IdeTreeItem[] = [
  { kind: 'fold', label: 'schema' },
  { kind: 'file', label: 'tasks.notiondb.ts', icon: '◆', selected: true },
  { kind: 'file', label: 'people.notiondb.ts', icon: '◇' },
  { kind: 'file', label: 'sprints.notiondb.ts', icon: '◇' },
  { kind: 'file', label: 'tasks.notiondb.lock.json', icon: '▤' },
]

const NOTION_NAV: readonly NotionNav[] = [
  { icon: '🔍', label: 'Search' },
  { icon: '▦', label: 'Tasks', on: true },
  { icon: '📄', label: 'Docs' },
]

/** The typed desired-state file — the declarative source of truth (LEFT, cause). */
const DesiredStateCode = () => (
  <>
    <div>
      <span className="kw">export default</span> <span className="fn">defineDatabase</span>({'{'}
    </div>
    <div>{'  '}name: <span className="str">'Tasks'</span>,</div>
    <div>
      {'  '}parent: <span className="fn">parentPage</span>(env.DEMO_PARENT_PAGE),
    </div>
    <div>{'  '}properties: {'{'}</div>
    <div>
      {'    '}Name:{'     '}property.<span className="fn">title</span>(),
    </div>
    <div>
      {'    '}Status:{'   '}property.<span className="fn">select</span>({'{ options: ['}
      <span className="cm">…</span>
      {'] }'}),
    </div>
    <div>
      {'    '}Priority: property.<span className="fn">select</span>({'{ options: ['}
      <span className="cm">…</span>
      {'] }'}),
    </div>
    <div>
      {'    '}
      <span className="cm">// …number, date, checkbox, url</span>
    </div>
    <div>{'  },'}</div>
    <div>{'})'}</div>
  </>
)

// ── the provisioned Notion database (RIGHT, effect) ──────────────────────────
/** The clean/normal provisioned Tasks DB — renders as a real Notion table, NOT
 *  ghosted/projected. `In Progress` is CANONICAL here (codegen overlays a rename
 *  to `Active` on the same row; this page keeps the canonical value). */
const ProvisionedDB = () => (
  <NotionSurface
    label="Tasks"
    workspace="Team"
    workspaceInitial="T"
    nav={NOTION_NAV}
  >
    <div className="ntn-h">
      <span className="emoji">✅</span>Tasks
    </div>
    <table className="ntn-tbl">
      <colgroup>
        <col />
        <col style={{ width: '104px' }} />
        <col style={{ width: '58px' }} />
      </colgroup>
      <thead>
        <tr>
          <th>
            <span className="colh">Aa Name</span>
          </th>
          <th>
            <span className="colh">◉ Status</span>
          </th>
          <th>
            <span className="colh">⚑ Prio</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td className="nm">Launch pricing</td>
          <td>
            <span className="st st-prog">{nbsp('In Progress')}</span>
          </td>
          <td>
            <PriorityPill priority="High" />
          </td>
        </tr>
        <tr>
          <td className="nm">Draft changelog</td>
          <td>
            <span className="st st-todo">Todo</span>
          </td>
          <td>
            <PriorityPill priority="Medium" />
          </td>
        </tr>
      </tbody>
    </table>
  </NotionSurface>
)

/** The empty parent page — no Tasks DB yet (the "before"). */
const EmptyNotion = () => (
  <MacWindow variant="ntn" title={<WinTitle logo="notion" label="Notion · Team workspace" />} tag="notion">
    <div className="ntn-empty">
      <div className="ico">▦</div>
      <div className="t1">No "Tasks" database yet</div>
      <div className="t2">Today you'd click through Notion's UI to create it and every property — by hand, unversioned.</div>
    </div>
  </MacWindow>
)

// ── beat 2 sequence — declare → plan → apply → refuse ─────────────────────────
const SeeItWork = () => (
  <Sequence
    steps={iacStory.steps}
    legendCap="The flow, in four steps"
    stage={
      <>
        {/* LEFT: the declarative desired-state file (mini-IDE) + the terminal */}
        <div className="seq-col left">
          <MiniIDE
            file="schema/tasks.notiondb.ts"
            tag="TS"
            tree={IDE_TREE}
            tab="tasks.notiondb.ts"
          >
            <DesiredStateCode />
          </MiniIDE>

          <Terminal file="zsh — schema-iac">
            {/* step 1 — idle prompt (block cursor) */}
            <TerminalLine extra="only-1">
              <span className="p">$</span> <Cursor />
            </TerminalLine>

            {/* step 2 · plan — prints the would-create diff; writes NOTHING */}
            <TerminalLine extra="step-hide r2">
              <span className="p">$</span> <span className="c">notion schema plan</span> tasks.notiondb.ts
            </TerminalLine>
            <TerminalLine extra="step-hide r2">
              <span className="hd">Plan · tasks.notiondb.ts → Notion</span>
            </TerminalLine>
            <TerminalLine out extra="step-hide r2">
              {'  '}target: create new database (no lock file yet)
            </TerminalLine>
            <TerminalLine extra="step-hide r2">
              <span className="add">{'  '}+ create database "Tasks"</span>{' '}
              <span className="out">(parent $DEMO_PARENT_PAGE)</span>
            </TerminalLine>
            <TerminalLine extra="step-hide r2">
              <span className="add">{'  '}+ property Name·Status·Priority·Tags·Estimate…</span>
            </TerminalLine>
            <TerminalLine extra="step-hide r2 sum">Plan: 1 db · 9 properties to add · 0 change · 0 blocked</TerminalLine>

            {/* step 3 · apply — command at ENTRY (cause); done/lock GATED to the
                write packet's arrival (effect), never painted at t=0 */}
            <TerminalLine extra="step-hide r3">
              <span className="p">$</span> <span className="c">notion schema apply</span> tasks.notiondb.ts
            </TerminalLine>
            <TerminalLine extra={`step-hide ${applyDoneReveal}`}>
              <span className="add">{'  '}+ create database "Tasks"</span> … <span className="ok">done</span>{'  '}
              <span className="out">2f1e…c43</span>
            </TerminalLine>
            <TerminalLine extra={`step-hide ${applyDoneReveal}`}>
              {'  '}· wrote <span className="path">tasks.notiondb.lock.json</span>{' '}
              <span className="out">· applied 10 changes</span>
            </TerminalLine>

            {/* step 4 · refuse — a destructive re-run is BLOCKED (real guard) */}
            <TerminalLine extra="step-hide r4">
              <span className="p">$</span> <span className="c">notion schema apply</span>{' '}
              <span className="out"># after deleting a property</span>
            </TerminalLine>
            <TerminalLine extra="step-hide r4">
              <span className="blk">{'  '}✗ remove property "Notes" — BLOCKED</span>
            </TerminalLine>
            <TerminalLine extra="step-hide r4">
              <span className="blk">{'    '}DestructiveSchemaMigrationRequired</span>{' '}
              <span className="out">· nothing changed</span>
            </TerminalLine>
          </Terminal>
        </div>

        {/* MIDDLE: the provision flow (file → Notion). Neutral accent throughout;
            idle 1–2 · applying 3 (single-pass packet) · BLOCKED 4 (iac.css). */}
        <DirFlow direction="push" badge="provision" note="file → Notion" />

        {/* RIGHT: Notion — empty ("no Tasks DB") → provisioned DB. The provisioned
            grid is the resolved base view; s-now is gated to the packet at step 3. */}
        <div className="seq-col right">
          <div className="ntn-swap">
            <div className="s-was">
              <EmptyNotion />
            </div>
            <div className="s-now">
              <ProvisionedDB />
            </div>
          </div>
        </div>
      </>
    }
  />
)

// ── the full thread ──────────────────────────────────────────────────────────
export const Iac = () => (
  <>
    {/* THE SOLE PLANNED INDICATOR — a single sticky banner. Do NOT scatter
        additional planned/ghost/mock badges across the frames. */}
    <div className="banner">
      <span className="bdg">Roadmap preview</span>
      <span className="msg">
        <b>Planned — not built yet.</b> <code>notion schema plan</code> and <code>notion schema apply</code>{' '}
        <b>do not exist</b>. Every command below is <b>narrated mock output</b>, not a live capture.
      </span>
    </div>

    <div className="thread">
      <div className="body-pad" />

      {/* LEAD */}
      <header className="lead">
        <p className="kicker">Notion tooling · a thread</p>
        <h1>
          <code>notion{nbsp(' schema apply')}</code> — provision your Notion database from a file
        </h1>
        <p>
          The honest inverse of codegen (3.1). Instead of generating code <em>from</em> Notion, declare the database
          you <em>want</em> in a typed file and have the tool reconcile Notion to match — additive and safe. This is a
          designed preview of where <code>notion schema</code> is headed, not a shipped feature.
        </p>
        <div className="dir">
          <span className="file">.notiondb.ts file</span>
          <svg viewBox="0 0 26 12">
            <path d="M1 6 H20" stroke="var(--muted)" strokeWidth="1.6" fill="none" />
            <path d="M16 2 L24 6 L16 10 Z" fill="var(--muted)" />
          </svg>
          <b>plan → apply</b>
          <svg viewBox="0 0 26 12">
            <path d="M1 6 H20" stroke="var(--muted)" strokeWidth="1.6" fill="none" />
            <path d="M16 2 L24 6 L16 10 Z" fill="var(--muted)" />
          </svg>
          <span className="db">Notion DB</span>
        </div>
      </header>

      {/* BEAT 1 — THE GAP */}
      <Beat num="01" tag="The gap">
        <h2>
          Codegen only reads Notion. There's <em>no way</em> to declare a database and provision it.
        </h2>
        <div className="stage">
          <div className="s1">
            {/* desired-state file */}
            <div className="code">
              <div className="code-bar">
                ◆ tasks.notiondb.ts<span className="ro">desired state</span>
              </div>
              <div className="code-body">
                <div>
                  <span className="kw">export default</span> <span className="fn">defineDatabase</span>({'{'}
                </div>
                <div className="indent">
                  name: <span className="st-code">'Tasks'</span>,
                </div>
                <div className="indent">
                  parent: <span className="fn">parentPage</span>(env.<span className="pv">DEMO_PARENT_PAGE</span>),
                </div>
                <div className="indent">properties: {'{'}</div>
                <div className="indent2">
                  Name: property.<span className="fn">title</span>(),
                </div>
                <div className="indent2">
                  Status: property.<span className="fn">select</span>({'{ options: […] }'}),
                </div>
                <div className="indent2">
                  <span className="cm">// …number, date, checkbox, url</span>
                </div>
                <div className="indent">{'},'}</div>
                <div>{'})'}</div>
              </div>
            </div>
            {/* the missing command */}
            <div className="conn amber">
              <div className="lbl">
                <b>? no command</b>
                <br />
                today you build
                <br />
                the DB by hand
              </div>
              <svg viewBox="0 0 108 24">
                <path d="M4 12 H92" stroke="var(--amber)" strokeWidth="1.8" strokeDasharray="5 5" fill="none" />
                <path d="M84 6 L98 12 L84 18 Z" fill="var(--amber)" />
              </svg>
            </div>
            {/* empty parent page: no Tasks DB */}
            <EmptyNotion />
          </div>
        </div>
        <p className="caption">
          <b>
            Shipped codegen (3.1) goes one way: Notion → code. The reverse — a file that <em>defines</em> the database
            and provisions it — doesn't exist.
          </b>{' '}
          <span className="hint">
            So the schema itself is still authored by clicking around Notion's UI, with no diff, no review, no source of
            truth in git.
          </span>
        </p>
      </Beat>

      {/* BEAT 2 — SEE HOW IT WOULD WORK (the sequence) */}
      <Beat num="02" tag="See how it would work">
        <h2>
          Declare it, <em>plan</em> it, <em>apply</em> it — a typed file provisions Notion, left{nbsp(' → ')}right.
        </h2>
        <div className="stage">
          <SeeItWork />
        </div>
        {/* reconcile strip — the "delta on every run" idea, carried over */}
        <div className="recon">
          <span className="rt">Re-run after editing the file →</span>
          <span className="rl">
            <span className="chg">~</span> add option to "Priority" <span className="chg">(+ Urgent)</span>
            {'  ·  '}
            <span className="add">+</span> property "Blocked" checkbox
          </span>
          <span className="noop">unchanged file ⇒ no-op</span>
        </div>
        <p className="caption">
          <b>
            <code>plan</code> prints every change it would make — before touching anything.
          </b>{' '}
          <span className="hint">
            (<span className="add-ink">+</span> add, <span className="chg-ink">~</span> change), creating nothing; the
            first <code>apply</code> would create the DB and write a <code>tasks.notiondb.lock.json</code>; re-runs
            reconcile only the delta.
          </span>
        </p>
        <div className="promise">
          ✓ …and it can never lose data — <b>here's the boundary ↓</b>{' '}
          <span className="nxt">additive only</span>
        </div>
      </Beat>

      {/* CODA — THE HONEST BOUNDARY. Section id gap preserved as content: this is
          the 3rd displayed beat ("03") though a beat was removed in decluttering. */}
      <div className="coda-rule">
        <span>The honest boundary · why it's safe to consider</span>
      </div>
      <Beat num="03" tag="…and destructive fails closed" coda>
        <h2>
          It would only ever <em>add</em>. Anything that could lose data is <span className="w">refused</span>.
        </h2>
        <div className="stage bound-stage">
          <div className="bound">
            {/* in scope */}
            <div className="bcol in">
              <div className="bcol-h">✓ in scope · additive</div>
              <div className="bcol-body">
                <div className="brow">
                  <span className="m">+</span>
                  <span className="t">
                    <b>create database</b> if absent
                  </span>
                </div>
                <div className="brow">
                  <span className="m">+</span>
                  <span className="t">
                    <b>add property</b> <span className="sub">(the conservative type subset only)</span>
                  </span>
                </div>
                <div className="brow">
                  <span className="m">~</span>
                  <span className="t">
                    <b>rename property</b> <span className="sub">(needs an explicit renamedFrom hint)</span>
                  </span>
                </div>
                <div className="brow">
                  <span className="m">~</span>
                  <span className="t">
                    <b>add select options</b> <span className="sub">(append-only)</span>
                  </span>
                </div>
              </div>
            </div>
            {/* out of scope */}
            <div className="bcol out">
              <div className="bcol-h">✗ out of scope · fails closed</div>
              <div className="bcol-body">
                <div className="brow">
                  <span className="m">x</span>
                  <span className="t">
                    remove a property<span className="g">BLOCKED · DestructiveSchemaMigrationRequired</span>
                  </span>
                </div>
                <div className="brow">
                  <span className="m">x</span>
                  <span className="t">
                    change a property's type<span className="g">BLOCKED · DestructiveSchemaMigrationRequired</span>
                  </span>
                </div>
                <div className="brow">
                  <span className="m">x</span>
                  <span className="t">
                    remove a select option<span className="g">BLOCKED · OptionDeletionLosesValues</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
          {/* refuse terminal (iac-local; distinct from the kit .tmnl) */}
          <div className="rterm">
            <div className="rterm-bar">
              <span className="rterm-dots">
                <i />
                <i />
                <i />
              </span>
              notion schema apply
            </div>
            <div className="rterm-body">
              <div className="cmd">
                <span className="p">$</span> <span className="c">notion schema apply</span>{' '}
                <span className="id">tasks.notiondb.ts</span>
              </div>
              <div className="out"> </div>
              <div className="blk">Error: refusing to apply — 3 destructive change(s) are out of scope.</div>
              <div className="out">{'       '}apply performs additive, non-destructive reconciliation only</div>
              <div className="out">{'       '}(create-db, add property, rename property, add select options).</div>
              <div className="out">{'       '}Nothing was changed.</div>
            </div>
            <div className="rterm-foot stop">
              <span>✗ fails closed · applies nothing rather than the safe parts</span>
              <span className="ex">exit 1</span>
            </div>
          </div>
        </div>
        {/* credibility split: real engine vs planned front-end */}
        <div className="split">
          <div className="real">
            <div className="lab">✓ real today · the engine</div>
            <p>
              The sync layer already <b>adds properties, renames them, extends select options</b>, and{' '}
              <b>refuses destructive changes</b> against a live Notion DB. Those guard names are the actual ones in{' '}
              <code>notion-datasource-sync</code>.
            </p>
          </div>
          <div className="planned">
            <div className="lab">◷ planned · the front-end</div>
            <p>
              What's <b>not built</b>: the declarative <code>plan</code>/<code>apply</code> commands, the planner that
              diffs a file against Notion, and the <code>lock.json</code> state model. A front-end doesn't get to weaken
              the guards.
            </p>
          </div>
        </div>
        <p className="caption coda-cap">
          <b>
            This is why the direction is even worth considering: the boundary is inherited from an engine that already
            fails closed today.
          </b>{' '}
          <span className="hint">
            Deletes, type changes and option removals are done deliberately in Notion — never as a silent side effect of
            editing a file.
          </span>
        </p>
      </Beat>

      <p className="foot">
        The shipped inverse is <b>3.1 codegen</b> (<code>notion schema generate</code> · DB → code). This page is the
        honest <b>code → DB</b> direction we'd build on top of the same engine.
      </p>
    </div>
  </>
)
