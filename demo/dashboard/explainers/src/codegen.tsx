/**
 * codegen.tsx — the port of notion-schema-codegen (3.1): "point at a live Notion
 * database → introspect it into a typed Effect schema; CI goes red when Notion
 * drifts". Composed from the shared kit (MacWindow/MiniIDE/NotionSurface/Terminal/
 * Sequence) + a `syncStory` step-model encoding the CORRECT causal sequence.
 *
 * THE INVERSION (vs sqlite/react/iac): this is a READ. Notion (RIGHT) is the
 * pre-existing source of truth and NEVER changes across steps 1–3; the generated
 * code (LEFT mini-IDE) is the gated EFFECT. The flow runs right → left.
 *
 * THE CAUSAL FIX (review [HIGH], codegen step 2): the original asserted a hard
 * contradiction — the badge said "reading…" (packet in flight) while the terminal
 * already showed `✓ wrote` and the whole schema was materialized at t=0 of step 2.
 * Here the schema + `✓ wrote` + the badge→"typed" flip are ALL gated behind the
 * read packet's single-pass arrival (`r2b`, ~1.35s), derived from the model below.
 * Constructing the story asserts this: set the effect's delay to 0 (code present
 * while "reading…") and `syncStory` THROWS `CausalityError`, failing the build.
 *
 * The codegen shape uses `syncStory` with NO `local` pane (there is no pre-sync
 * local edit): the `generate` command IS the action at step-2 entry, and the only
 * effect is the generated code, gated to the packet's arrival.
 */
import {
  Beat,
  MiniIDE,
  NotionSurface,
  OK,
  Prompt,
  Sequence,
  Terminal,
  TerminalLine,
  nbsp,
  type IdeTreeItem,
  type NotionNav,
} from '../../kit/components.tsx'
import { LABELS, PRIORITY_OPTIONS } from '../../kit/fixtures.ts'
import { captionsToSteps, syncStory } from '../../kit/syncStory.ts'

/**
 * The declarative causal model. Constructing it ASSERTS cause-before-effect and
 * throws `CausalityError` on inversion (see app/test/causality.test.ts). `local` is
 * omitted — codegen has no pre-sync local-pane flip. The `generate`/read packet
 * departs at step-2 entry and travels ~1.35s; the generated code is the sole
 * effect, gated to that ARRIVAL (NOT step entry — that is the fixed [HIGH] bug).
 */
export const codegenStory = syncStory({
  steps: captionsToSteps([
    'Point at a live Notion database.',
    'Typed Effect schemas — generated, not written.',
    'Real autocomplete, real compile errors.',
    "A CI drift gate: the schema can't change without your build failing.",
  ]),
  // the read packet: `notion schema generate` departs at step-2 entry, travels
  // ~1.35s (aligned to the kit CSS r2b gate that reveals the code on arrival).
  sync: { step: 2, duration: 1350 },
  // the sole effect — the generated schema materializing in the mini-IDE — gated
  // to the packet ARRIVAL. `pane: 'ide'` names the left/output pane as the effect.
  remote: {
    pane: 'ide',
    swap: { was: 'schema.gen.ts — empty', now: 'export const Task = …', at: { step: 2, delay: 1350 } },
  },
})

// The generated code + the `✓ wrote` terminal line derive their reveal class from
// the model, so neither can appear before its cause (the read packet) arrives.
// gatedRevealClass({ step: 2, delay: 1350 }) → 'r2b' (step-2, transition-delay 1.35s).
const codeReveal = codegenStory.gatedRevealClass(codegenStory.remote.swap.at)

// ── Priority option set — the ONE source rendered three ways ───────────────────
// Canonical order from the shared fixture (High | Medium | Low). The schema
// `Literal(...)`, the autocomplete popup, and the compile-error union all derive
// from this, so they can NEVER drift (the original HTML shipped a latent bug:
// `Literal('High','Low','Medium')` vs an autocomplete of 'High'|'Medium'|'Low').
const PRIO = PRIORITY_OPTIONS // ['High', 'Medium', 'Low']
const prioUnion = PRIO.map((p) => `'${p}'`).join(' | ')

// ── codegen fixture OVERLAY (not yet in the shared fixture) ────────────────────
// The narrative rows + the deliberate rename story are codegen-specific overlays.
// These are NOT in kit/fixtures.ts yet (see report — they want a `renamedTo:
// 'Active'` overlay on In Progress + these three rows). Marked local + explicit.
type Sel = { readonly cls: string; readonly label: string; readonly plain?: boolean }
interface CodegenRow {
  readonly name: string
  readonly status: Sel // Notion `status` select (rename overlay lives here)
  readonly prio: Sel // Notion `priority` select
  readonly blocked: boolean // the drift property — added to Notion at step 4 only
}
const CODEGEN_ROWS: readonly CodegenRow[] = [
  // 'Active' is the rename OVERLAY of the canonical In Progress (the whole beat-1
  // point: "In Progress → Active, renamed in the UI"). iac shows this same row as
  // In Progress; do not let a shared fixture collapse them.
  { name: 'Launch pricing page', status: { cls: 'blue', label: 'Active' }, prio: { cls: 'red', label: 'High', plain: true }, blocked: true },
  { name: 'Draft changelog', status: { cls: 'gray', label: 'Todo' }, prio: { cls: 'amber', label: 'Med', plain: true }, blocked: false },
  { name: 'Ship onboarding', status: { cls: 'green', label: 'Done' }, prio: { cls: 'gray', label: 'Low', plain: true }, blocked: false },
]

// ── shared chrome ─────────────────────────────────────────────────────────────
const IDE_TREE: readonly IdeTreeItem[] = [
  { kind: 'fold', label: 'src', icon: '▾' },
  { kind: 'file', label: 'schema.gen.ts', icon: '◆', selected: true },
  { kind: 'file', label: 'notion.config.ts', icon: '▤' },
  { kind: 'file', label: 'app.ts', icon: '▤' },
]

const NOTION_NAV: readonly NotionNav[] = [
  { icon: '🔍', label: 'Search' },
  { icon: '▦', label: 'Tasks', on: true },
  { icon: '📄', label: 'Docs' },
  { icon: '🗓', label: 'Roadmap' },
]

// ── the reversed, stepped-label connector (codegen-local; see report) ──────────
// A `.cgflow` = the "reversed Flow with a stepped 4-label badge" the kit does not
// have yet: DirFlow renders a single static badge string and Flow is L→R with no
// `l-drift`, so NO shared component can carry {generate|reading…|typed|drift!}
// mirrored right→left. Realized locally per the task's "describe a needed kit
// piece" clause; its causal states live in codegen.css.
const CgFlow = () => (
  <div className="cgflow">
    <div className="cgflow-badge">
      <span className="dot" />
      <span className="lbl">
        <span className="l-done">typed</span>
        <span className="l-idle">generate</span>
        <span className="l-sync">reading…</span>
        <span className="l-drift">drift!</span>
      </span>
    </div>
    <div className="cgflow-rail">
      <span className="track" />
      <span className="head" />
      <span className="pkt" />
    </div>
    <div className="cgflow-check">✓ typed</div>
  </div>
)

// ── a Notion select pill (codegen-local `.npill`; kit `.pill` is High/Med only) ─
const NPill = ({ sel }: { sel: Sel }) => (
  <span className={`npill ${sel.cls}${sel.plain ? ' plain' : ''}`}>{sel.label}</span>
)

// ── beat 2 sequence ────────────────────────────────────────────────────────────
const SeeItWork = () => (
  <Sequence
    steps={codegenStory.steps}
    legendCap="The whole flow, in four steps"
    stage={
      <>
        {/* LEFT: the generated code (mini-IDE) + the terminal driving it — the EFFECT */}
        <div className="seq-col left">
          <MiniIDE file="schema.gen.ts" tag="TS" tree={IDE_TREE} tab="schema.gen.ts">
            {/* step-1 placeholder — the gated effect's "before" state */}
            <div className="ide-empty only-1">
              <span className="big">◆</span>
              <span>
                <b>schema.gen.ts</b> — empty
                <br />
                run <span style={{ color: 'var(--accent)' }}>notion schema generate</span> to fill it
              </span>
            </div>

            {/* generated code — gated to the read packet's arrival (r2b), NOT step entry */}
            <div className={`step-hide ${codeReveal}`}>
              <span className="cm">// generated · do not edit</span>
            </div>
            <div className={`step-hide ${codeReveal}`}>
              <span className="kw">export const</span> <span className="fn">Task</span> =
            </div>
            <div className={`step-hide ${codeReveal}`}>
              {'  '}Schema.<span className="fn">Struct</span>({'{'}
            </div>
            <div className={`step-hide ${codeReveal}`}>{'    Name:     NotionSchema.'}<span className="fn">title</span>,</div>
            <div className={`step-hide ${codeReveal}`}>{'    Status:   NotionSchema.'}<span className="fn">status</span>(),</div>
            <div className={`step-hide ${codeReveal}`}>
              {'    Priority: Schema.'}<span className="fn">Literal</span>(
            </div>
            <div className={`step-hide ${codeReveal}`}>
              {'      '}
              {PRIO.map((p, i) => (
                <span key={p}>
                  <span className="sv">'{p}'</span>
                  {i < PRIO.length - 1 ? ', ' : ''}
                </span>
              ))}
              ),
            </div>
            <div className={`step-hide ${codeReveal}`}>{'  })'}</div>

            {/* payoff: autocomplete popup (step 3 only) — rendered from PRIO */}
            <div className="pop step-hide r3 only-3" style={{ right: '8px', top: '6px' }}>
              <div className="pop-h">Priority · autocomplete</div>
              {PRIO.map((p, i) => (
                <div key={p} className={i === 0 ? 'pop-row sel' : 'pop-row'}>
                  <span className="ic">◆</span>
                  <span className="sv">'{p}'</span>
                </div>
              ))}
            </div>
            {/* payoff: red squiggle / compile error (step 3 only) — union from PRIO */}
            <div className="ide-err step-hide r3 only-3" style={{ right: '8px', bottom: '8px', maxWidth: '200px' }}>
              task.Priority = <span className="squig">'Urgent'</span>
              <span className="m">
                ✗ not <span style={{ color: 'var(--ink)' }}>{prioUnion}</span>
              </span>
            </div>
          </MiniIDE>

          <Terminal file="zsh — your repo">
            <TerminalLine extra="only-1">
              <Prompt /> <span className="cur" />
            </TerminalLine>
            {/* the CAUSE: the generate command, ungated, at step-2 entry */}
            <TerminalLine extra="step-hide r2">
              <Prompt /> notion <span className="cmd">schema generate</span> <span className="id">&lt;db-id&gt;</span>{' '}
              <span className="fl">-o</span> <span className="id">schema.gen.ts</span> <span className="fl">--typed-options</span>
            </TerminalLine>
            {/* the EFFECT: `✓ wrote` — gated to the read packet's arrival (r2b) */}
            <TerminalLine out extra={`step-hide ${codeReveal}`}>
              introspecting Tasks… <OK>✓</OK> wrote schema.gen.ts
            </TerminalLine>
            {/* step 4 — the drift gate (staggered so column added → diff → detect → exit reads in order) */}
            <TerminalLine extra="step-hide r4">
              <Prompt /> notion <span className="cmd">schema diff</span> <span className="id">&lt;db-id&gt;</span>{' '}
              <span className="fl">--file</span> <span className="id">schema.gen.ts</span> <span className="fl">--exit-code</span>
            </TerminalLine>
            <TerminalLine out extra="step-hide r4 cgd1">
              comparing &lt;db-id&gt; ↔ schema.gen.ts
            </TerminalLine>
            <TerminalLine out extra="step-hide r4 cgd2">
              <span className="add">+ Blocked (checkbox)</span> — new property in Notion
            </TerminalLine>
            <TerminalLine extra="step-hide r4 cgd3">
              <span className="err">✗ schema drift detected</span>
              <span className="ex">exit 1</span>
            </TerminalLine>
          </Terminal>
        </div>

        {/* MIDDLE: generation flow — right → left (Notion → code, a READ) */}
        <CgFlow />

        {/* RIGHT: Notion surface — the SOURCE OF TRUTH (never changes across steps 1–3) */}
        <div className="seq-col right">
          <NotionSurface
            tag="source of truth"
            workspace={LABELS.workspace}
            workspaceInitial={LABELS.workspaceInitial}
            nav={NOTION_NAV}
          >
            <div className="ntn-h">
              <span className="emoji">{LABELS.dbEmoji}</span>
              {LABELS.dbName}
            </div>
            <table className="ntn-tbl">
              <colgroup>
                <col style={{ width: '44%' }} />
                <col style={{ width: '22%' }} />
                <col style={{ width: '16%' }} />
                <col style={{ width: '18%' }} />
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
                  {/* the drift property — reflows in only at step 4 (colflash) */}
                  <th className="newp r4col">
                    <span className="colh">☑ Blocked</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {CODEGEN_ROWS.map((r) => (
                  <tr key={r.name}>
                    <td className="nm">
                      <span className="nmc">
                        <span className="pg">📄</span>
                        <span className="nmt">{r.name}</span>
                      </span>
                    </td>
                    <td>
                      <NPill sel={r.status} />
                    </td>
                    <td>
                      <NPill sel={r.prio} />
                    </td>
                    <td className="r4col">
                      <span className={r.blocked ? 'ck on' : 'ck'}>{r.blocked ? '☑' : '☐'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </NotionSurface>
        </div>
      </>
    }
  />
)

// ── the full thread ────────────────────────────────────────────────────────────
export const Codegen = () => (
  // `.cg` scopes every shared-class override (widths, .ide-code overlays, pills,
  // terminal spans) to this page so nothing leaks onto sqlite/md/react/iac.
  <div className="thread cg">
    {/* LEAD */}
    <header className="lead">
      <h1>
        <code>notion{nbsp(' schema')}</code> — your Notion databases, as typed code
      </h1>
      <p>
        The database is the source of truth. Introspect it into a typed Effect schema, commit that, and let CI go red
        the moment Notion drifts from your types.
      </p>
      <div className="dir">
        <span className="db">Notion DB</span>
        <svg viewBox="0 0 26 12">
          <path d="M1 6 H20" stroke="var(--muted)" strokeWidth="1.6" fill="none" />
          <path d="M16 2 L24 6 L16 10 Z" fill="var(--muted)" />
        </svg>
        <b>codegen</b>
        <svg viewBox="0 0 26 12">
          <path d="M1 6 H20" stroke="var(--muted)" strokeWidth="1.6" fill="none" />
          <path d="M16 2 L24 6 L16 10 Z" fill="var(--muted)" />
        </svg>
        <span className="cd">typed code</span>
      </div>
    </header>

    {/* BEAT 1 — THE PROBLEM */}
    <Beat num="01" tag="The problem">
      <h2>
        In your code, a Notion DB is <code>any</code> — until you <em>generate</em> its types.
      </h2>
      <div className="stage">
        <div className="ways">
          <div className="target-cap">typed access to a Notion database · two ways</div>
          <div className="waylist">
            <div className="wayrow">
              <div className="waylabel">
                <span className="wayname">by hand</span>
                <span className="waykind">untyped</span>
                <span className="waymark">✗ runtime</span>
              </div>
              <div className="waycode">
                <div>
                  page.properties.Status <span className="cm">// : any — no shape</span>
                </div>
                <div>
                  task.Status = <span className="sv">"Doen"</span>{' '}
                  <span className="cm">// typo compiles → fails at runtime</span>
                </div>
                <div>
                  <span className="cm">// no autocomplete on options · drifts when the DB changes</span>
                </div>
              </div>
            </div>
            <div className="wayrow win">
              <div className="waylabel">
                <span className="wayname">generated</span>
                <span className="waykind">typed</span>
                <span className="waymark">✓ compile</span>
              </div>
              <div className="waycode">
                <div>
                  <span className="cm">$</span> notion schema generate -o schema.gen.ts
                </div>
                <div>
                  Status: <span className="sv">"Todo"</span> | <span className="sv">"In Progress"</span> |{' '}
                  <span className="sv">"Done"</span> <span className="cm">// literal union · autocomplete</span>
                </div>
                <div>
                  task.Status = <span className="sv">"Doen"</span>{' '}
                  <span className="cm">// ✗ caught by tsc, before you ship</span>
                </div>
                <div>
                  <span className="cm"># notion schema diff --exit-code → CI drift gate</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="caption">
        <b>
          Read from code, a Notion DB's properties are <code>any</code> and its options are bare strings — typos and
          renamed options blow up at runtime, with no autocomplete.
        </b>{' '}
        <span className="hint">
          <code>notion schema generate</code> emits typed Effect schemas straight from the live DB — select options
          become literal unions (real autocomplete, typos caught by <code>tsc</code>) — and{' '}
          <code>notion schema diff --exit-code</code> is the CI drift gate.
        </span>
      </p>
    </Beat>

    {/* BEAT 2 — HOW IT WORKS */}
    <Beat num="02" tag="How it works">
      <h2>
        One command reads the live database and writes a <em>typed schema</em>.
      </h2>
      <div className="stage">
        <SeeItWork />
      </div>
      <p className="caption">
        <b>
          <code>notion schema generate</code> introspects the live database and writes a typed{' '}
          <code>schema.gen.ts</code> — every select becomes a literal union, so your editor autocompletes options and{' '}
          <code>tsc</code> rejects wrong ones.
        </b>{' '}
        <span className="hint">
          Change the database in Notion and <code>notion schema diff --exit-code</code> fails your build (exit 1). The
          arrow only runs Notion → code: it reads the database, never writes it.
        </span>
      </p>
    </Beat>

    {/* BEAT 3 — WHAT IT ENABLES */}
    <Beat num="03" tag="What it enables">
      <h2>
        Your Notion databases become <em>versioned, typed code</em>.
      </h2>
      <div className="stage">
        <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
          {/* repo */}
          <div className="repo">
            <div className="repo-frame">
              <div className="repo-bar">⎇ main · your repo</div>
              <div className="repo-tree">
                <div className="row">📁 src/schemas/</div>
                <div className="row file indent">
                  <span className="fi">◆</span> tasks.gen.ts
                </div>
                <div className="row file indent">
                  <span className="fi">◆</span> tasks.gen.api.ts
                </div>
                <div className="row indent">📄 notion.config.ts</div>
              </div>
            </div>
            <div className="sot">◆ committed · reviewed in PRs</div>
          </div>
          {/* projection */}
          <div className="projarrow">
            <div className="plabel">
              imported,
              <br />
              type-checked
            </div>
            <svg viewBox="0 0 110 26">
              <path d="M4 13 H96" stroke="currentColor" strokeWidth="1.8" fill="none" />
              <path d="M90 8 L100 13 L90 18 Z" fill="currentColor" />
            </svg>
          </div>
          {/* typed usage */}
          <div style={{ position: 'relative', width: '400px' }}>
            <div className="code">
              <div className="code-bar">
                ◆ app.ts
                <span className="ro" style={{ color: 'var(--ok)' }}>
                  end-to-end typed
                </span>
              </div>
              <div className="code-body">
                <div>
                  <span className="kw">const</span> pages = <span className="kw">yield*</span>{' '}
                  <span className="fn">TasksApi</span>.<span className="fn">queryAll</span>()
                </div>
                <div className="hl g" style={{ margin: '4px -7px' }}>
                  page.properties.Status
                </div>
              </div>
            </div>
            <div className="pop" style={{ left: '44px', top: '92px' }}>
              <div className="pop-h">hover · inferred type</div>
              <div className="pop-row">
                <span className="sv">"Todo" | "In Progress" | "Done"</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="caption">
        <b>Commit the generated schema and it's just code — versioned, reviewed in PRs, type-checked end to end.</b>{' '}
        <span className="hint">
          <code>queryAll · get · create · update</code> are all typed against the real database, so a wrong property
          name or option fails at compile time, not in production. List every DB you track in{' '}
          <code>notion.config.ts</code> and <code>notion schema generate-config</code> regenerates them all at once.
        </span>
      </p>
      <div className="promise">
        ✓ …and it's honest about which way the data flows — <b>it reads Notion, never writes it ↓</b>{' '}
        <span className="nxt">reads, never writes</span>
      </div>
    </Beat>

    {/* CODA — HONEST FRAMING */}
    <div className="coda-rule">
      <span>Being honest · the direction</span>
    </div>
    <Beat num="04" tag="…and it stays honest" coda>
      <h2>
        This <em>reads</em> Notion to generate types. It never <span className="w">writes</span> Notion.
      </h2>
      <div className="stage">
        <div style={{ display: 'flex', alignItems: 'stretch', gap: '20px', flexWrap: 'wrap', justifyContent: 'center' }}>
          {/* real / today */}
          <div className="doc">
            <div className="doc-bar">
              <span className="doc-dot g" />
              <span className="doc-name">notion schema</span>
              <span className="doc-src">3.1 · shipping</span>
            </div>
            <div className="doc-body">
              <div className="doc-flow">
                <span className="db">Notion DB</span>
                <svg viewBox="0 0 22 11">
                  <path d="M1 5.5 H15" stroke="currentColor" strokeWidth="1.5" fill="none" />
                  <path d="M12 1.5 L20 5.5 L12 9.5 Z" fill="currentColor" />
                </svg>
                <span className="cd">typed code</span>
              </div>
              <div className="doc-steps">
                <b>introspect</b> → <b>generate</b> → <b>diff --exit-code</b>
              </div>
              <span className="tagline tag-g">✓ read-only · Notion owns the shape</span>
            </div>
          </div>
          {/* planned inverse */}
          <div className="doc dashed">
            <div className="doc-bar">
              <span className="doc-dot m" />
              <span className="doc-name">notion schema apply</span>
              <span className="doc-src">3.2 · planned</span>
            </div>
            <div className="doc-body">
              <div className="doc-flow">
                <span className="cd">a file</span>
                <svg viewBox="0 0 22 11">
                  <path d="M1 5.5 H15" stroke="currentColor" strokeWidth="1.5" fill="none" />
                  <path d="M12 1.5 L20 5.5 L12 9.5 Z" fill="currentColor" />
                </svg>
                <span className="db">Notion DB</span>
              </div>
              <div className="doc-steps">
                <b>declare</b> → <b>plan</b> → <b>provision Notion</b>
              </div>
              <span className="tagline tag-b">◷ roadmap · a separate, inverse capability</span>
            </div>
          </div>
        </div>
      </div>
      <p className="caption">
        <b>
          Be honest about what this is: introspect → codegen → drift{' '}
          <em style={{ fontStyle: 'normal', color: 'var(--accent)' }}>detection</em>. It reads Notion; it never writes
          it.
        </b>{' '}
        <span className="hint">
          You still create and change the database in Notion.{' '}
          <code>notion schema diff &lt;id&gt; --file schema.gen.ts --exit-code</code> mirrors the live DB against your
          committed types and <b style={{ color: 'var(--warn)' }}>fails CI (exit 1)</b> the moment they disagree — so
          drift can't silently ship. Provisioning Notion <em style={{ fontStyle: 'normal' }}>from</em> a file is the
          separate, planned inverse.
        </span>
      </p>
    </Beat>

    <p className="foot">
      This is the <b>DB → code</b> direction: Notion owns the shape, your types follow.
      <span className="inv">
        The honest inverse — declare the database in a file and provision Notion to match (<b>code → DB</b>) — is a
        separate, <b>planned</b> capability: see <code>notion schema apply</code> (3.2, roadmap).
      </span>
    </p>
  </div>
)
