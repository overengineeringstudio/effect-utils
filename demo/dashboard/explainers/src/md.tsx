/**
 * md.tsx — the port of notion-md: "keep local Markdown two-way synced with
 * Notion, no copy-paste, no clobbering". The most complex of the five: Beat 2
 * holds THREE independent `[data-seq]` sub-tab sequences (Local / Notion /
 * Shared), each a causally-distinct sync story.
 *
 * FIXED SIDES across all three tabs: the `.nmd` mini-IDE is always LEFT, the
 * Notion page always RIGHT — direction lives only in the center arrows
 * (push → / ← pull / ⇄ merge). Each mode's causality is declared as data via
 * `multiSyncStory`, which ASSERTS cause-before-effect and fails the build if a
 * mode is inverted (see scripts/causality-proof.ts for the negative test).
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
  STR,
  Sequence,
  SubTabbedSequences,
  Swap,
  Tg,
  TypingCaret,
  type IdeTreeItem,
  type SubTab,
} from '../../kit/components.tsx'
import { PRODUCT_SPEC, ROADMAP } from '../../kit/fixtures.ts'
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
  { kind: 'file', label: '.notion-md', icon: '▸' },
]

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
  after,
}: {
  story: MultiSyncStory
  source: string
  legendCap: string
  flow: React.ReactNode
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
          <MiniIDE file={ROADMAP.file} tree={TREE} tab={ROADMAP.file}>
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

          {/* CENTER — direction only lives here */}
          {flow}

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
      after={
        <span className="term g step-hide r3b">
          <span className="pmt">notion md sync ›</span> pushed
        </span>
      }
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
      after={
        <>
          <span className="term b step-hide r3b">
            <span className="pmt">notion md sync ›</span> pulled
          </span>
          <div className="warnnote step-hide r4">
            ⚠ Hand-edit the file on a <code>source: remote</code> page? It’s <b>overwritten on the next pull</b> —
            you’re warned. Switch to <code>shared</code> to keep both.
          </div>
        </>
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
      after={
        <>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
            <span className="term g step-hide r3only">
              <span className="pmt">notion md sync ›</span> shared-merged
            </span>
            <span className="term w step-hide r4">
              <span className="pmt">same line ›</span> shared-conflict
            </span>
          </div>
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
      <p className="kicker">Notion tooling · a thread</p>
      <h1>
        <code>notion md</code> — Notion for people, files for everything else
      </h1>
      <p>
        Notion's the home for humans. But your agents, your build, and your Git all want a file. Keep the page and the
        file in sync — edit either side.
      </p>
    </header>

    {/* BEAT 1 — THE PROBLEM */}
    <Beat num="01" tag="The problem">
      <h2>
        The page is for people. Your agents, your build, your Git all want a <em>file</em>.
      </h2>
      <div className="stage">
        <div className="s1col">
          <div className="s1">
            {/* local doc — the file medium (LEFT) */}
            <div className="doc local">
              <div className="doc-bar">
                <span className="doc-dot f" />
                <span className="doc-name">{PRODUCT_SPEC.fileMd}</span>
                <span className="doc-src">repo</span>
              </div>
              <div className="doc-body">
                <div className="dln">
                  <span className="h"># {PRODUCT_SPEC.heading}</span>
                </div>
                <div className="dln">
                  <span className="h">- [x]</span> {PRODUCT_SPEC.todo}
                </div>
                <div className="dln">Pricing: {PRODUCT_SPEC.view} / mo</div>
              </div>
            </div>
            {/* same content, two mediums — no first-class link between them */}
            <div className="projarrow">
              <div className="plabel">
                same content
                <br />
                two mediums
              </div>
              <svg viewBox="0 0 110 26">
                <path d="M4 13 H96" stroke="currentColor" strokeWidth="1.8" fill="none" />
                <path d="M90 8 L100 13 L90 18 Z" fill="currentColor" />
                <path d="M20 18 L10 13 L20 8" stroke="currentColor" strokeWidth="1.8" fill="none" />
              </svg>
            </div>
            {/* Notion doc — rendered blocks, not raw markdown (RIGHT) */}
            <div className="doc notion">
              <div className="doc-bar">
                <span className="doc-dot n" />
                <span className="doc-name">{PRODUCT_SPEC.heading}</span>
                <span className="doc-src">Notion</span>
              </div>
              <div className="doc-body">
                <div className="nheading">{PRODUCT_SPEC.heading}</div>
                <div className="ntodo done">
                  <span className="ncheck on">
                    <svg viewBox="0 0 12 12">
                      <path
                        d="M2 6.3 L4.7 9 L10 2.9"
                        fill="none"
                        stroke="#fff"
                        strokeWidth="1.9"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <span className="t">{PRODUCT_SPEC.todo}</span>
                </div>
                <div className="ntext">Pricing: {PRODUCT_SPEC.view} / mo</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="caption">
        <b>Notion's API/UI is the right medium for humans — but agents, build pipelines, and Git all work in files.</b>{' '}
        <span className="hint">
          For an agent, a file <em>is</em> the ideal read/write API: its tools already speak <code>Edit</code> /{' '}
          <code>grep</code> / <code>git diff</code>, and a local file is always current — no guessing remote state.{' '}
          <code>notion md</code> keeps the page and the file in sync.
        </span>
      </p>
    </Beat>

    {/* BEAT 2 — SEE IT WORK (sub-tabbed by source-of-truth mode) */}
    <Beat num="02" tag="See it work · pick the direction">
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

    {/* BEAT 3 — THE SHIFT */}
    <Beat num="03" tag="The shift">
      <h2>
        Your repo is the <em>source of truth</em>. Notion becomes a live view of it.
      </h2>
      <div className="stage">
        <div className="s3">
          <div className="repo">
            <div className="repo-frame">
              <div className="repo-bar">⎇ main · your repo</div>
              <div className="repo-tree">
                <div className="row">📁 docs/</div>
                <div className="row file indent">
                  <span className="fi">◆</span> {PRODUCT_SPEC.fileNmd}
                </div>
                <div className="row indent">📁 .notion-md/</div>
              </div>
            </div>
            <div className="sot">◆ versioned, reviewed, yours</div>
          </div>
          <div className="projarrow">
            <div className="plabel">
              synced,
              <br />
              not copied
            </div>
            <svg viewBox="0 0 110 26">
              <path d="M4 13 H96" stroke="currentColor" strokeWidth="1.8" fill="none" />
              <path d="M90 8 L100 13 L90 18 Z" fill="currentColor" />
              <path d="M20 18 L10 13 L20 8" stroke="currentColor" strokeWidth="1.8" fill="none" />
            </svg>
          </div>
          <div className="view">
            <div className="view-frame">
              <div className="view-inner">
                <div className="doc-bar">
                  <span className="doc-dot n" />
                  <span className="doc-name">{PRODUCT_SPEC.heading}</span>
                  <span className="doc-src">Notion</span>
                </div>
                <div className="doc-body" style={{ fontFamily: 'var(--sans)', gap: '10px', paddingTop: '14px' }}>
                  <div className="nheading">{PRODUCT_SPEC.heading}</div>
                  <div className="ntodo done">
                    <span className="ncheck on">
                      <svg viewBox="0 0 12 12">
                        <path
                          d="M2 6.3 L4.7 9 L10 2.9"
                          fill="none"
                          stroke="#fff"
                          strokeWidth="1.9"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                    <span className="t">{PRODUCT_SPEC.todo}</span>
                  </div>
                  <div className="ntext">Pricing: {PRODUCT_SPEC.view} / mo</div>
                </div>
              </div>
            </div>
            <div className="view-cap">a live view · still editable</div>
          </div>
        </div>
      </div>
      <p className="caption">
        <b>Stop babysitting two copies.</b>{' '}
        <span className="hint">
          Your files live in git — versioned, reviewable, the real source. Notion is just a synced, editable window
          onto them. The copy-paste dance is gone.
        </span>
      </p>
      <div className="promise">
        ✓ …and it never clobbers — <b>your work is never lost</b> <span className="nxt">here’s how ↓</span>
      </div>
    </Beat>

    {/* CODA — GOING DEEPER */}
    <div className="coda-rule">
      <span>Going deeper · optional</span>
    </div>
    <Beat num="04" tag="…and it never clobbers" coda>
      <h2>
        Both sides changed the same line? You get a <em>draft</em>, not a disaster.
      </h2>
      <div className="stage">
        <div className="merge">
          <div className="col">
            <div className="mbox">
              <div className="mt">local edit</div>
              <div className="mrow">
                <span style={{ color: 'var(--blue)' }}>Pricing: {PRODUCT_SPEC.conflict.local} / mo</span>
              </div>
            </div>
            <div className="mbox">
              <div className="mt">notion edit</div>
              <div className="mrow">
                <span style={{ color: 'var(--accent)' }}>Pricing: {PRODUCT_SPEC.conflict.notion} / mo</span>
              </div>
            </div>
          </div>
          <div className="merge-core">
            <div className="merge-arrows">
              <svg viewBox="0 0 96 56">
                <path d="M2 10 C42 10 40 28 80 28" stroke="var(--muted)" strokeWidth="1.6" fill="none" />
                <path d="M2 46 C42 46 40 28 80 28" stroke="var(--muted)" strokeWidth="1.6" fill="none" />
                <path d="M74 23 L84 28 L74 33 Z" fill="var(--muted)" />
              </svg>
            </div>
            <div className="merge-op">◆ guarded 3-way merge</div>
            <div className="base-sub">
              vs base <b>{PRODUCT_SPEC.conflict.base}</b> · from .notion-md/
            </div>
            <div className="merge-arrows">
              <svg viewBox="0 0 96 26">
                <path d="M6 13 H84" stroke="var(--ok)" strokeWidth="1.8" fill="none" />
                <path d="M78 7 L88 13 L78 19 Z" fill="var(--ok)" />
              </svg>
            </div>
            <div style={{ font: '600 10px/1 var(--mono)', letterSpacing: '.04em', color: 'var(--ok)', textAlign: 'center' }}>
              writes a draft →
            </div>
          </div>
          <div className="col">
            <div className="draft">
              <div className="draft-bar">⚠ {PRODUCT_SPEC.conflictFile}</div>
              <div className="draft-body">
                <div className="conf a">
                  <span className="mk">&lt;&lt;&lt; local</span>
                  <br />
                  Pricing: {PRODUCT_SPEC.conflict.local} / mo
                </div>
                <div className="conf b">
                  <span className="mk">&gt;&gt;&gt; notion</span>
                  <br />
                  Pricing: {PRODUCT_SPEC.conflict.notion} / mo
                </div>
              </div>
            </div>
            <div className="safe">✓ both versions kept · you decide</div>
          </div>
        </div>
      </div>
      <p className="caption">
        <b>
          Every sync is a 3-way merge against a content-addressed base in <code>.notion-md/</code>.
        </b>{' '}
        <span className="hint">
          If only one side changed, it just applies. If both touched the same spot, notion md writes a{' '}
          <code>*.conflict.roughdraft.md</code> holding both versions — it never overwrites your work.
        </span>
      </p>
    </Beat>

    <p className="foot">
      What first-class would look like: Notion natively exposes any page or DB as a file-shaped, versionable,
      agent-editable surface — <em>mount your workspace as files</em>, not an export. Until then, <code>notion md</code>{' '}
      fills the gap.
    </p>
  </div>
)
