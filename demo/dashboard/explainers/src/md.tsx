/**
 * md.tsx — the port of notion-md: "keep local Markdown two-way synced with
 * Notion, no copy-paste, no clobbering". The most complex of the five: Beat 2
 * holds THREE independent `[data-seq]` sub-tab sequences (Local / Notion /
 * Shared), each a causally-distinct sync story.
 *
 * FIXED SIDES across all three tabs: the `.nmd` mini-IDE is always LEFT, the
 * Notion page always RIGHT — direction lives only in the center arrows
 * (push → / ← pull / ⇄ merge). Each mode's causality is declared as data via
 * `multiSyncStory`, which ASSERTS cause-before-effect and throws `CausalityError`
 * if a mode is inverted (see app/test/causality.test.ts for the negative tests).
 *
 * Role bands (kit): a line/block edited FIRST reads blue (`orig`); a line/block
 * that RECEIVES on sync reads green (`recv`), gated behind the packet's arrival.
 * Which pane carries `orig` vs `recv` is derived from each story's edits, so the
 * reversed Notion-pull mode falls out of the data, not a special case.
 */
import type * as React from 'react'
import type { Actor } from '../../kit/actors.ts'
import { Teammate, You } from '../../kit/actors.ts'
import {
  Beat,
  Cm,
  CodeLine,
  DirFlow,
  MiniIDE,
  NotionBlock,
  NotionPage,
  NotionSurface,
  OK,
  Prompt,
  STR,
  Sequence,
  SubTabbedSequences,
  Swap,
  Terminal,
  TerminalLine,
  Tg,
  TypingCaret,
  type IdeTreeItem,
  type SubTab,
} from '../../kit/components.tsx'
import { ROADMAP } from '../../kit/fixtures.ts'
import { type MultiSyncStory, captionsToSteps, multiSyncStory } from '../../kit/syncStory.ts'

// ── the three causal step-models (asserted at build time) ────────────────────
// Shared timeline: the edit is authored at step 2; a single sync packet departs
// at step-3 entry and travels ~1.15s; every received effect is gated to that
// arrival (the kit CSS realizes the 1.15s delay; the model asserts the ordering).
const SYNC = { step: 3, duration: 1150 } as const
const EDIT_AT = { step: 2 } as const
const RECV_AT = { step: 3, delay: 1150 } as const

/** LOCAL — source: local, push →. The IDE edits, Notion receives. (3 steps) */
export const mdLocalStory = multiSyncStory({
  steps: captionsToSteps([
    'roadmap.nmd declares source: local — the file is the source of truth; the page is in sync.',
    'Edit a line in the file (left). Local owns it.',
    'notion md sync pushes it — the Notion page updates. pushed.',
  ]),
  sync: SYNC,
  direction: 'push',
  edits: [
    {
      label: 'pricing',
      from: 'ide',
      to: 'notion',
      editAt: EDIT_AT,
      receiveAt: RECV_AT,
      swap: { was: ROADMAP.pricing.was, now: ROADMAP.pricing.now, at: EDIT_AT },
    },
  ],
})

/** NOTION — source: remote, ← pull. REVERSED: Notion edits, the IDE receives.
 *  Step 4 is the honest "overwritten on next pull" warning. (4 steps) */
export const mdRemoteStory = multiSyncStory({
  steps: captionsToSteps([
    'source: remote — Notion is the source of truth; in sync.',
    'A teammate edits the Notion page (right).',
    'notion md sync pulls it — roadmap.nmd updates. pulled.',
    'Hand-edit the file? It’s overwritten on the next pull — switch to shared to keep both.',
  ]),
  sync: SYNC,
  direction: 'pull',
  edits: [
    {
      label: 'pricing',
      from: 'notion',
      to: 'ide',
      editAt: EDIT_AT,
      receiveAt: RECV_AT,
      swap: { was: ROADMAP.pricing.was, now: ROADMAP.pricing.now, at: EDIT_AT },
    },
  ],
})

/** SHARED — source: shared, ⇄ merge. TWO crossing edits: the IDE edits Pricing,
 *  Notion edits Enterprise (different lines → clean auto-merge). Step 4 is the
 *  same-line conflict escalation (a draft is written; Notion untouched). (4 steps) */
export const mdSharedStory = multiSyncStory({
  steps: captionsToSteps([
    'source: shared — two-way; a base is recorded in .notion-md/.',
    'Both sides edit different lines — Pricing here, Enterprise there.',
    'Non-overlapping — clean auto-merge; both edits coexist. shared-merged.',
    'Both edit the same line? A conflict roughdraft is written — Notion is left unchanged. shared-conflict.',
  ]),
  sync: SYNC,
  direction: 'two',
  edits: [
    {
      label: 'pricing',
      from: 'ide',
      to: 'notion',
      editAt: EDIT_AT,
      receiveAt: RECV_AT,
      swap: { was: ROADMAP.pricing.was, now: ROADMAP.pricing.now, at: EDIT_AT },
    },
    {
      label: 'enterprise',
      from: 'notion',
      to: 'ide',
      editAt: EDIT_AT,
      receiveAt: RECV_AT,
      swap: { was: ROADMAP.enterprise.was, now: ROADMAP.enterprise.now, at: EDIT_AT },
    },
  ],
})

// ── shared chrome + a data-driven line renderer ──────────────────────────────
const NAV = [
  { icon: '🔍', label: 'Search' },
  { icon: '📄', label: 'Docs' },
  { icon: ROADMAP.navEmoji, label: 'Roadmap', on: true },
]

const TREE: readonly IdeTreeItem[] = [
  { kind: 'fold', label: 'docs' },
  { kind: 'file', label: ROADMAP.file, icon: '◆', selected: true },
]

// `.notion-md/` (the recorded base for two-way merge) only exists in shared mode.
const SHARED_TREE: readonly IdeTreeItem[] = [...TREE, { kind: 'file', label: '.notion-md', icon: '▸' }]

const actorFor = (from: string): Actor => (from === 'ide' ? You : Teammate)

/**
 * Render one line's value from the story: a role-banded swap (with a typewriter
 * caret on the AUTHOR side, coloured by persona) or plain static text when this
 * mode has no edit for the label. The returned `role` drives the causal band.
 */
const lineValue = (
  story: MultiSyncStory,
  label: string,
  pane: 'ide' | 'notion',
  staticText: string,
): { role: 'orig' | 'recv' | undefined; node: React.ReactNode } => {
  const edit = story.edits.find((e) => e.label === label)
  if (!edit || edit.swap == null) return { role: undefined, node: staticText }
  const role = story.roleOf(label, pane)
  const now =
    role === 'orig' ? (
      <TypingCaret actor={actorFor(edit.from)} ch={edit.swap.now.length + 1}>
        {edit.swap.now}
      </TypingCaret>
    ) : (
      edit.swap.now
    )
  return { role, node: <Swap was={edit.swap.was} now={now} /> }
}

const ModeSequence = ({
  story,
  source,
  legendCap,
  flow,
  term,
  after,
}: {
  story: MultiSyncStory
  source: string
  legendCap: string
  flow: React.ReactNode
  term: React.ReactNode
  after: React.ReactNode
}) => {
  const idePrice = lineValue(story, 'pricing', 'ide', ROADMAP.pricing.was)
  const ideEnt = lineValue(story, 'enterprise', 'ide', ROADMAP.enterprise.was)
  const ntnPrice = lineValue(story, 'pricing', 'notion', ROADMAP.pricing.was)
  const ntnEnt = lineValue(story, 'enterprise', 'notion', ROADMAP.enterprise.was)
  return (
    <Sequence
      steps={story.steps}
      legendCap={legendCap}
      after={after}
      stage={
        <>
          {/* LEFT — the .nmd mini-IDE (fixed) */}
          <MiniIDE file={ROADMAP.file} tree={source === 'shared' ? SHARED_TREE : TREE} tab={ROADMAP.file}>
            <CodeLine>
              <Cm>---</Cm>
            </CodeLine>
            <CodeLine>
              <Tg>source:</Tg> <STR>{source}</STR>
            </CodeLine>
            <CodeLine>
              <Tg>notion_page_id:</Tg> <Cm>{ROADMAP.pageId}</Cm>
            </CodeLine>
            <CodeLine>
              <Cm>---</Cm>
            </CodeLine>
            <CodeLine>
              <Tg># {ROADMAP.heading}</Tg>
            </CodeLine>
            <CodeLine role={idePrice.role}>Pricing: {idePrice.node}{ROADMAP.unit}</CodeLine>
            <CodeLine role={ideEnt.role}>Enterprise: {ideEnt.node}</CodeLine>
          </MiniIDE>

          {/* CENTER — the notion md CLI drives it; the direction packet animates */}
          <div className="midcol">
            {flow}
            <Terminal file="notion md">
              <TerminalLine>
                <Prompt /> notion md sync
              </TerminalLine>
              {term}
            </Terminal>
          </div>

          {/* RIGHT — the Notion page (fixed) */}
          <NotionSurface workspace={ROADMAP.workspace} workspaceInitial={ROADMAP.workspaceInitial} nav={NAV}>
            <NotionPage emoji={ROADMAP.emoji} heading={ROADMAP.heading}>
              <NotionBlock role={ntnPrice.role}>Pricing: {ntnPrice.node}{ROADMAP.unit}</NotionBlock>
              <NotionBlock role={ntnEnt.role}>Enterprise: {ntnEnt.node}</NotionBlock>
            </NotionPage>
          </NotionSurface>
        </>
      }
    />
  )
}

// ── the three sub-tab panels ─────────────────────────────────────────────────
const LocalPanel = (
  <>
    <p className="subhead">
      <b>Local is the source of truth.</b>{' '}
      <span className="h">
        Your <code>.nmd</code> pushes to Notion — a push-only mirror. Terminal prints <code>pushed</code>.
      </span>
    </p>
    <ModeSequence
      story={mdLocalStory}
      source="local"
      legendCap="The whole flow, in 3 steps"
      flow={<DirFlow direction="push" badge="local owns" note="push →" />}
      term={
        <TerminalLine out extra="step-hide r3b">
          <OK>pushed</OK>
        </TerminalLine>
      }
      after={null}
    />
  </>
)

const RemotePanel = (
  <>
    <p className="subhead">
      <b>Notion is the source of truth.</b>{' '}
      <span className="h">
        Notion pulls into your <code>.nmd</code> — pull-only. Local hand-edits are never pushed. Terminal prints{' '}
        <code>pulled</code>.
      </span>
    </p>
    <ModeSequence
      story={mdRemoteStory}
      source="remote"
      legendCap="The whole flow, in 4 steps"
      flow={<DirFlow direction="pull" badge="notion owns" note="← pull" />}
      term={
        <TerminalLine out extra="step-hide r3b">
          <OK>pulled</OK>
        </TerminalLine>
      }
      after={
        <div className="warnnote step-hide r4">
          ⚠ Hand-edit the file on a <code>source: remote</code> page? It’s <b>overwritten on the next pull</b> —
          you’re warned. Switch to <code>shared</code> to keep both.
        </div>
      }
    />
  </>
)

const SharedPanel = (
  <>
    <p className="subhead">
      <b>Two-way, guarded.</b>{' '}
      <span className="h">
        A 3-way merge vs a base in <code>.notion-md/</code>. Different lines auto-merge; the same line writes a
        conflict draft and <b>never clobbers Notion</b>.
      </span>
    </p>
    <ModeSequence
      story={mdSharedStory}
      source="shared"
      legendCap="Two-way, then the conflict escalation"
      flow={<DirFlow direction="two" badge="two-way" note="⇄ merge" />}
      term={
        <>
          <TerminalLine out extra="step-hide r3only">
            <OK>shared-merged</OK>
          </TerminalLine>
          <TerminalLine out extra="step-hide r4">same line → shared-conflict</TerminalLine>
        </>
      }
      after={
        <>
          <div className="rdraft step-hide r4">
            <div className="rdraft-bar">⚠ {ROADMAP.conflictFile}</div>
            <div className="rdraft-body">
              <div className="cf base">
                <span className="mk">base</span>
                <span className="vv">Pricing: {ROADMAP.conflict.base}{ROADMAP.unit}</span>
              </div>
              <div className="cf loc">
                <span className="mk">local</span>
                <span className="vv">Pricing: {ROADMAP.conflict.local}{ROADMAP.unit}</span>
              </div>
              <div className="cf rem">
                <span className="mk">remote</span>
                <span className="vv">Pricing: {ROADMAP.conflict.remote}{ROADMAP.unit}</span>
              </div>
            </div>
            <div className="rdraft-note">✓ Notion left unchanged — never clobbers.</div>
          </div>
        </>
      }
    />
  </>
)

const MD_TABS: readonly SubTab[] = [
  { id: 'local', dir: '→', name: 'Local', chip: 'source: local', panel: LocalPanel },
  { id: 'remote', dir: '←', name: 'Notion', chip: 'source: remote', panel: RemotePanel },
  { id: 'shared', dir: '⇄', name: 'Shared', chip: 'source: shared', panel: SharedPanel },
]

// ── the full thread ──────────────────────────────────────────────────────────
export const Md = () => (
  <div className="thread">
    {/* LEAD */}
    <header className="lead">
      <h1>
        <code>notion md</code> — 2-way Markdown sync for Notion pages
      </h1>
      <p>
        Point it at a Notion page, get a local Markdown file. Edit either side — your editor or Notion — and it syncs
        both ways.
      </p>
    </header>

    {/* BEAT 1 — THE PROBLEM */}
    <Beat num="01" tag="The problem">
      <h2>
        Working with files is easier than working with a CLI/API in many cases
      </h2>
      <div className="stage">
        <div className="ways">
          <div className="target-cap">the same one-line change to a Notion page, three ways</div>
          {/* three ways to touch it: API (scripting) · CLI (ad-hoc) · a local file */}
          <div className="waylist">
            <div className="wayrow">
              <div className="waylabel">
                <span className="wayname">API</span>
                <span className="waykind">scripting</span>
                <span className="waymark">✗ verbose</span>
              </div>
              <div className="waycode">
                <div>
                  <Tg>await</Tg> notion.blocks.children.list({'{ block_id }'})
                </div>
                <div>
                  <Cm>// find the Pricing block by hand, then…</Cm>
                </div>
                <div>
                  <Tg>await</Tg> notion.blocks.update({'{ block_id, … }'})
                </div>
              </div>
            </div>
            <div className="wayrow">
              <div className="waylabel">
                <span className="wayname">CLI</span>
                <span className="waykind">ad-hoc</span>
                <span className="waymark">✗ clunky</span>
              </div>
              <div className="waycode">
                <div>
                  <Cm>$</Cm> ntn block list &lt;page&gt; <Cm># hunt for the block id</Cm>
                </div>
                <div>
                  <Cm>$</Cm> ntn block update &lt;id&gt; --text <STR>"Pricing: $30 / mo"</STR>
                </div>
              </div>
            </div>
            <div className="wayrow win">
              <div className="waylabel">
                <span className="wayname">a file</span>
                <span className="waykind">grep / edit</span>
                <span className="waymark">✓ trivial</span>
              </div>
              <div className="waycode">
                <div>
                  <Cm>$</Cm> grep Pricing roadmap.md
                </div>
                <div>
                  <Cm>$</Cm> sed -i <STR>'s/$25/$30/'</STR> roadmap.md <Cm># or just edit it · git diff</Cm>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="caption">
        <b>A coding agent, a build, or a quick grep over the API means fetch, page through blocks, guess the state, write, refetch.</b>{' '}
        <span className="hint">
          A local Markdown file skips all that — your editor, your agent, and git already speak it, and it's always
          current.
        </span>
      </p>
    </Beat>

    {/* BEAT 2 — HOW IT WORKS (sub-tabbed by source-of-truth mode) */}
    <Beat num="02" tag="How it works · pick the direction">
      <h2>
        Edit a file — one <em>source:</em> field decides which way it flows.
      </h2>
      <SubTabbedSequences group="mdmode" tabs={MD_TABS} defaultId="local" />
      <p className="caption">
        <b>
          Fixed sides across all three tabs: the <code>.nmd</code> in a mini-IDE on the left, the Notion page on the
          right — direction lives in the center arrows, never in pane position.
        </b>{' '}
        <span className="hint">
          One <code>source:</code> field per file picks push (<code>local</code>) · pull (<code>remote</code>) ·
          two-way guarded merge (<code>shared</code>). A freshly-tracked page is <code>remote</code> by default.
        </span>
      </p>
    </Beat>

    {/* BEAT 3 — WHAT IT ENABLES */}
    <Beat num="03" tag="What it enables">
      <h2>
        One sync, three very different <em>jobs</em>.
      </h2>
      <div className="stage">
        <div className="enables">
          <div className="ecard local">
            <span className="edir">local →</span>
            <div className="etitle">Skills &amp; docs → Notion</div>
            <div className="ebody">
              Keep agent skills and docs as Markdown in your repo — mirror them into Notion for the team to read.
            </div>
          </div>
          <div className="ecard notion">
            <span className="edir">← notion</span>
            <div className="etitle">Notion as a CMS</div>
            <div className="ebody">Author in Notion; sync the content down into your website build.</div>
          </div>
          <div className="ecard shared">
            <span className="edir">⇄ shared</span>
            <div className="etitle">Live 2-way collaboration</div>
            <div className="ebody">
              An agent edits the file, a teammate edits the page — a guarded merge keeps both.
            </div>
          </div>
        </div>
      </div>
    </Beat>

    {/* CODA — GOING DEEPER */}
    <div className="coda-rule">
      <span>Going deeper · optional</span>
    </div>
    <Beat num="04" tag="The toolkit" coda>
      <h2>
        More than a sync — the full <em>notion md</em> toolkit.
      </h2>
      <div className="stage">
        <div className="features">
          <div className="fcard">
            <div className="ft">
              <span className="fico">⇄</span> Two-way sync
            </div>
            <div className="fb">
              One engine, both directions — <code>source: local / remote / shared</code> picks the flow.
            </div>
          </div>
          <div className="fcard">
            <div className="ft">
              <span className="fico">◆</span> Guarded merge
            </div>
            <div className="fb">Overlapping edits become a conflict file — never a silent overwrite.</div>
          </div>
          <div className="fcard">
            <div className="ft">
              <span className="fico">✓</span> Verified writes
            </div>
            <div className="fb">Re-reads the page after every push and asserts it matches before moving on.</div>
          </div>
          <div className="fcard">
            <div className="ft">
              <span className="fico">⎇</span> Git-friendly state
            </div>
            <div className="fb">
              A content-addressed base in a sidecar, keyed by page id — survives <code>git mv</code>.
            </div>
          </div>
          <div className="fcard">
            <div className="ft">
              <span className="fico">◷</span> Watch mode
            </div>
            <div className="fb">Reacts to local saves instantly; polls Notion on an interval (30s default).</div>
          </div>
          <div className="fcard">
            <div className="ft">
              <span className="fico">⚑</span> Self-describing files
            </div>
            <div className="fb">Frontmatter sets direction; an unbound local file creates the page on push.</div>
          </div>
        </div>
      </div>
      <div className="fidelity">
        <div className="fidrow">
          <span className="blabel">Round-trips</span>
          <span className="chips">
            {['Headings', 'Lists', 'To-dos', 'Toggles', 'Quotes', 'Callouts', 'Code', 'Dividers', 'Equations'].map(
              (b) => (
                <span className="bchip" key={b}>
                  {b}
                </span>
              ),
            )}
            <span className="bchip q">Tables · beta</span>
          </span>
        </div>
        <div className="fidrow">
          <span className="blabel muted">Edit in Notion</span>
          <span className="chips">
            {['Bookmarks', 'Embeds', 'Synced blocks', 'Databases'].map((b) => (
              <span className="bchip muted" key={b}>
                {b}
              </span>
            ))}
          </span>
        </div>
      </div>
    </Beat>
  </div>
)
