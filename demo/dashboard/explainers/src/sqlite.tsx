/**
 * sqlite.tsx — the pilot port of notion-sqlite: "edit a Notion row with plain
 * SQL locally → it lands live in Notion". Composed from the shared kit +
 * fixtures + a `syncStory` step-model that encodes the CORRECT causal sequence
 * (and FAILS THE BUILD if it is inverted).
 *
 * The story (exported for the causality proof):
 *   step 1  both cells In Progress (idle)
 *   step 2  the UPDATE types in; the SQLite cell flips to Done only at typing
 *           completion (~1.35s); Notion still In Progress
 *   step 3  one guarded sync — a single packet crosses; Notion flips to Done
 *           only on arrival (~1.45s); the badge settles syncing→synced
 *   step 4  settled
 * The kit CSS gates realize these delays; the model asserts their ordering.
 */
import {
  Beat,
  Cm,
  DbBrowser,
  Flow,
  KW,
  NotionSurface,
  OK,
  PriorityPill,
  Prompt,
  Sequence,
  SqlitePrompt,
  STR,
  StatusPill,
  Swap,
  Terminal,
  TerminalLine,
  TypingCaret,
  nbsp,
} from '../../kit/components.tsx'
import { EDITED_TASK, LABELS, SQLITE_STORY, TASKS } from '../../kit/fixtures.ts'
import { You } from '../../kit/actors.ts'
import { captionsToSteps, syncStory } from '../../kit/syncStory.ts'

/** The declarative causal model. Constructing it asserts cause-before-effect;
 *  a violation throws `CausalityError` and fails the build. */
export const sqliteStory = syncStory({
  steps: captionsToSteps([
    'Your Notion database, as a local SQLite file.',
    'Edit a row with plain SQL — locally.',
    'One guarded sync pushes it.',
    '…and it lands in Notion, live.',
  ]),
  // local SQLite cell: In Progress → Done at typing completion (~1.35s into step 2)
  local: { pane: 'db', swap: { was: 'In Progress', now: 'Done', at: { step: 2, delay: 1350 } } },
  // the guarded sync: the `notion db sync` command departs at step-3 entry and the
  // single packet travels ~1.45s (matches the kit CSS pkttravel 1.45s at step 3)
  sync: { step: 3, duration: 1450 },
  // remote Notion cell: gated to packet ARRIVAL (~1.45s into step 3), NOT step entry
  remote: { pane: 'notion', swap: { was: 'In Progress', now: 'Done', at: { step: 3, delay: 1450 } } },
})

// sqlite has a distinct local-pane flip (the DB cell), so `local` is present.
const localSwap = sqliteStory.local!.swap
// The gated confirmation lines derive their reveal class from the model, so the
// terminal cannot claim "done" before its cause completes.
const localDoneReveal = sqliteStory.gatedRevealClass(localSwap.at) // → r2b
const remoteDoneReveal = sqliteStory.gatedRevealClass(sqliteStory.remote.swap.at) // → r3b

const DB_TABLES = [
  { name: 'pages', icon: '▤', selected: true },
  { name: 'people', icon: '▤' },
  { name: 'sprints', icon: '▤' },
  { name: '_sync_log', icon: '◈' },
]

const NOTION_NAV = [
  { icon: '🔍', label: 'Search' },
  { icon: '▤', label: 'Tasks', on: true },
  { icon: '📄', label: 'Docs' },
  { icon: '🗓', label: 'Roadmap' },
]

// ── beat 2 sequence ──────────────────────────────────────────────────────────
const SeeItWork = () => (
  <Sequence
    steps={sqliteStory.steps}
    legendCap="The whole flow, in four steps"
    stage={
      <>
        {/* LEFT: local SQLite DB browser + the terminal driving it */}
        <div className="seq-col left">
          <DbBrowser
            file={LABELS.sqliteFile}
            tables={DB_TABLES}
          >
            <table className="dbb-grid">
              <colgroup>
                <col style={{ width: '24px' }} />
                <col />
                <col style={{ width: '88px' }} />
                <col style={{ width: '56px' }} />
                <col style={{ width: '60px' }} />
              </colgroup>
              <thead>
                <tr>
                  <th className="gut"> </th>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Team</th>
                </tr>
              </thead>
              <tbody>
                <tr className="sel">
                  <td className="gut">1</td>
                  <td>{EDITED_TASK.name}</td>
                  <td className="edit">
                    <Swap was={localSwap.was} now={localSwap.now} />
                  </td>
                  <td>{EDITED_TASK.priority}</td>
                  <td>{EDITED_TASK.team}</td>
                </tr>
                {TASKS.slice(1).map((t, i) => (
                  <tr key={t.name}>
                    <td className="gut">{i + 2}</td>
                    <td>{t.name}</td>
                    <td>{t.status}</td>
                    <td>{t.priority}</td>
                    <td>{t.team}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DbBrowser>

          <Terminal>
            <TerminalLine extra="only-1">
              <Prompt /> <span className="cur" />
            </TerminalLine>
            <TerminalLine extra="step-hide r2">
              <SqlitePrompt />{' '}
              <TypingCaret actor={You}>
                <KW>update</KW> pages <KW>set</KW> <STR>"Status"</STR>=<STR>'Done'</STR>
              </TypingCaret>
            </TerminalLine>
            <TerminalLine extra="step-hide r2 cont">
              <KW>where</KW> <STR>"Name"</STR>=<STR>'{SQLITE_STORY.whereName}'</STR>;
            </TerminalLine>
            <TerminalLine out extra={`step-hide ${localDoneReveal}`}>
              {SQLITE_STORY.rowsUpdated}
            </TerminalLine>
            <TerminalLine extra="step-hide r3">
              <Prompt /> notion db <span style={{ color: 'var(--blue)' }}>sync</span>
            </TerminalLine>
            <TerminalLine out extra="step-hide r3">
              <span className="r3" style={{ opacity: 1 }}>
                {SQLITE_STORY.pushing}
              </span>
            </TerminalLine>
            <TerminalLine out extra={`step-hide ${remoteDoneReveal}`}>
              <OK>✓</OK> {SQLITE_STORY.applied}
            </TerminalLine>
          </Terminal>
        </div>

        {/* MIDDLE: sync flow (SQLite → Notion) */}
        <Flow done="synced" idle="db sync" syncing="syncing…" />

        {/* RIGHT: Notion surface */}
        <div className="seq-col right">
          <NotionSurface
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
                <col />
                <col style={{ width: '96px' }} />
                <col style={{ width: '60px' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>
                    <span className="colh">Aa Name</span>
                  </th>
                  <th>
                    <span className="colh">◔ Status</span>
                  </th>
                  <th>
                    <span className="colh">⚑ Prio</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="nm">
                    <span className="nmc">
                      <span className="pg">📄</span>
                      <span className="nmt">{TASKS[0].name}</span>
                    </span>
                  </td>
                  <td>
                    <Swap
                      was={<StatusPill status="In Progress" />}
                      now={<StatusPill status="Done" />}
                    />
                  </td>
                  <td>
                    <PriorityPill priority="High" />
                  </td>
                </tr>
                <tr>
                  <td className="nm">
                    <span className="nmc">
                      <span className="pg">📄</span>
                      <span className="nmt">{TASKS[1].name}</span>
                    </span>
                  </td>
                  <td>
                    <StatusPill status="Done" />
                  </td>
                  <td>
                    <PriorityPill priority="Medium" />
                  </td>
                </tr>
                <tr>
                  <td className="nm">
                    <span className="nmc">
                      <span className="pg">📄</span>
                      <span className="nmt">{TASKS[2].name}</span>
                    </span>
                  </td>
                  <td>
                    <StatusPill status="In Progress" />
                  </td>
                  <td>
                    <PriorityPill priority="High" />
                  </td>
                </tr>
              </tbody>
            </table>
          </NotionSurface>
        </div>
      </>
    }
  />
)

// ── the full thread ──────────────────────────────────────────────────────────
export const Sqlite = () => (
  <div className="thread">
    {/* LEAD */}
    <header className="lead">
      <h1>
        <code>notion{nbsp(' db')}</code> — edit your Notion database with plain SQL
      </h1>
      <p>
        Pull a Notion database into a local <code>.sqlite</code> file. <code>SELECT</code>, bulk{' '}
        <code>UPDATE</code>, script it — then sync every change back, guarded.
      </p>
    </header>

    {/* BEAT 1 — THE PROBLEM */}
    <Beat num="01" tag="The problem">
      <h2>
        The same bulk edit: dozens of API calls — or one line of <em>SQL</em>.
      </h2>
      <div className="stage">
        <div className="ways">
          <div className="target-cap">mark 40 tasks done · three ways</div>
          <div className="waylist">
            <div className="wayrow">
              <div className="waylabel">
                <span className="wayname">API</span>
                <span className="waykind">scripting</span>
                <span className="waymark">✗ 40 calls</span>
              </div>
              <div className="waycode">
                <div>
                  const rows = <KW>await</KW> notion.databases.query({'{ database_id }'}) <Cm>// + paginate</Cm>
                </div>
                <div>
                  <KW>for</KW> (const p <KW>of</KW> rows.results)
                </div>
                <div>&nbsp;&nbsp;<KW>await</KW> notion.pages.update({'{ page_id: p.id, properties: { Status: … } }'})</div>
              </div>
            </div>
            <div className="wayrow">
              <div className="waylabel">
                <span className="wayname">CLI</span>
                <span className="waykind">ad-hoc</span>
                <span className="waymark">✗ per-row</span>
              </div>
              <div className="waycode">
                <div>
                  <Cm>$</Cm> ntn db query &lt;db&gt; --status <STR>"In Progress"</STR> <Cm># collect ids</Cm>
                </div>
                <div>
                  <Cm>$</Cm> ntn page update &lt;id&gt; --status <STR>"Done"</STR> <Cm># …once per row</Cm>
                </div>
              </div>
            </div>
            <div className="wayrow win">
              <div className="waylabel">
                <span className="wayname">SQL</span>
                <span className="waykind">a local file</span>
                <span className="waymark">✓ one line</span>
              </div>
              <div className="waycode">
                <div>
                  <KW>UPDATE</KW> tasks <KW>SET</KW> Status = <STR>'Done'</STR> <KW>WHERE</KW> Status ={' '}
                  <STR>'In Progress'</STR>;
                </div>
                <div>
                  <Cm>$</Cm> notion db sync <Cm># one guarded push</Cm>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="caption">
        <b>
          A local SQLite file makes your Notion database queryable and scriptable — plain SQL, the read/write API you
          already know.
        </b>{' '}
        <span className="hint">
          Over the Notion API it's paginated queries and one <code>update</code> call per row. A file is{' '}
          <code>SELECT</code>, one bulk <code>UPDATE</code>, and your whole toolchain.
        </span>
      </p>
    </Beat>

    {/* BEAT 2 — HOW IT WORKS */}
    <Beat num="02" tag="How it works">
      <h2>
        Edit a row with SQL locally — the change lands <em>live</em> in Notion.
      </h2>
      <div className="stage">
        <SeeItWork />
      </div>
      <p className="caption">
        <b>
          <code>notion db track</code> pulls the database into a local <code>&lt;db-id&gt;.sqlite</code>. Edit the{' '}
          <code>pages</code> table with ordinary SQL, run <code>notion db sync</code> — the write lands on the real
          Notion row.
        </b>{' '}
        <span className="hint">
          Each write is read-after-write verified before it settles. Two-way push needs <code>--mode{nbsp(' shared')}</code>{' '}
          at <code>track</code> time.
        </span>
      </p>
    </Beat>

    {/* BEAT 3 — WHAT IT ENABLES */}
    <Beat num="03" tag="What it enables">
      <h2>
        Your Notion database is now an ordinary <em>SQLite file</em>.
      </h2>
      <div className="stage">
        <div className="s3">
          <div className="filecard">
            <div className="file-frame">
              <div className="file-bar">
                <span className="fi">◆</span> {LABELS.sqliteFile}
              </div>
              <div className="toolfan">
                <div className="tool">
                  <span className="ti">▸</span> sqlite3 <span className="tg">— the CLI</span>
                </div>
                <div className="tool">
                  <span className="ti">▸</span> any SQLite driver <span className="tg">— your scripts</span>
                </div>
                <div className="tool">
                  <span className="ti">▸</span> a GUI browser <span className="tg">— point &amp; click</span>
                </div>
                <div className="tool">
                  <span className="ti">▸</span> SELECT · JOIN · bulk UPDATE
                </div>
              </div>
            </div>
            <div className="sot">◆ a real file · versionable, scriptable</div>
          </div>
          <div className="projarrow">
            <div className="plabel">
              synced
              <br />
              both ways
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
                <div className="grid-bar" style={{ borderRadius: 0 }}>
                  <span className="doc-dot" />
                  <span className="nm">{LABELS.notionMiniGridTitle}</span>
                  <span className="src">Notion</span>
                </div>
                <table className="gtable">
                  <thead>
                    <tr>
                      <th>
                        <span className="colh">Name</span>
                      </th>
                      <th>
                        <span className="colh">Status</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Draft brief</td>
                      <td>
                        <StatusPill status="Done" />
                      </td>
                    </tr>
                    <tr>
                      <td>Review copy</td>
                      <td>
                        <StatusPill status="Done" />
                      </td>
                    </tr>
                    <tr>
                      <td>Ship assets</td>
                      <td>
                        <StatusPill status="In Progress" />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div className="view-cap">a live view · still editable</div>
          </div>
        </div>
      </div>
      <p className="caption">
        <b>It's just a file.</b>{' '}
        <span className="hint">
          Every tool that speaks SQLite — the <code>sqlite3</code> CLI, your scripts, a GUI — now edits your Notion
          data. <code>sync</code> keeps both sides in step, both ways. Your database stopped being a walled grid.
        </span>
      </p>
      <div className="promise">
        ✓ …and it never corrupts your data — <b>unsafe writes are refused, not dropped</b>{' '}
        <span className="nxt">here's how ↓</span>
      </div>
    </Beat>

    {/* CODA — GOING DEEPER */}
    <div className="coda-rule">
      <span>Going deeper · optional</span>
    </div>
    <Beat num="04" tag="The toolkit" coda>
      <h2>
        Everything <em>notion db</em> does.
      </h2>
      <div className="stage">
        <div className="features">
          <div className="fcard">
            <div className="ft">
              <span className="fico">⌦</span> Track any database
            </div>
            <div className="fb">
              <code>notion db track</code> pulls a Notion database into a local <code>.sqlite</code> file.
            </div>
          </div>
          <div className="fcard">
            <div className="ft">
              <span className="fico">▤</span> Plain SQL
            </div>
            <div className="fb">
              Query and edit with any SQLite tool; <code>notion db sync</code> pushes the cells back.
            </div>
          </div>
          <div className="fcard">
            <div className="ft">
              <span className="fico">⇄</span> Two-way sync
            </div>
            <div className="fb">
              <code>--mode shared</code> syncs both directions; <code>local</code> / <code>remote</code> stay one-way.
            </div>
          </div>
          <div className="fcard">
            <div className="ft">
              <span className="fico">◆</span> Fails closed
            </div>
            <div className="fb">
              Formula/rollup writes and hard deletes are refused as a typed guard — never silently dropped.
            </div>
          </div>
          <div className="fcard">
            <div className="ft">
              <span className="fico">◷</span> Watch mode
            </div>
            <div className="fb">
              <code>sync --watch</code> reacts to local edits and re-checks Notion for remote changes.
            </div>
          </div>
          <div className="fcard">
            <div className="ft">
              <span className="fico">▦</span> Status &amp; conflicts
            </div>
            <div className="fb">
              <code>notion db status</code> shows drift; overlapping edits surface as conflicts, not overwrites.
            </div>
          </div>
        </div>
      </div>
      <div className="fidelity">
        <div className="fidrow">
          <span className="blabel">Writable</span>
          <span className="chips">
            {['Text', 'Number', 'Select', 'Status', 'Multi-select', 'Date', 'Checkbox', 'URL'].map((b) => (
              <span className="bchip" key={b}>
                {b}
              </span>
            ))}
          </span>
        </div>
        <div className="fidrow">
          <span className="blabel muted">Edit in Notion</span>
          <span className="chips">
            {['Formula', 'Rollup', 'Created / edited time'].map((b) => (
              <span className="bchip muted" key={b}>
                {b}
              </span>
            ))}
          </span>
        </div>
      </div>
    </Beat>

    <p className="foot">
      What first-class would look like: Notion exposing real transactional SQL over a typed database. Until then,{' '}
      <code>notion db</code> gives you <code>sqlite3</code> plus a sync that refuses to corrupt your data.
    </p>
  </div>
)
