/**
 * Sequence.stories — the ANIMATED step player. `<Sequence>` mounts `useStepPlayer`
 * on its own root ref, so it self-drives here exactly as in the explainers: the
 * segmented bar auto-advances, the SQL types in at step 2, the guarded sync packet
 * crosses at step 3, and both cells settle. Use the play/pause/prev/next controls
 * or click a segment to scrub. (Respects prefers-reduced-motion → static legend.)
 *
 * The step model is a REAL `syncStory` — constructing it asserts cause-before-effect
 * (a causally inverted story throws at build). Data is from fixtures.ts.
 */
import type { Meta, StoryObj } from '@storybook/react'
import {
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
} from './components.tsx'
import { EDITED_TASK, LABELS, SQLITE_STORY, TASKS } from './fixtures.ts'
import { You } from './actors.ts'
import { captionsToSteps, syncStory } from './syncStory.ts'

const story = syncStory({
  steps: captionsToSteps([
    'Your Notion database, as a local SQLite file.',
    'Edit a row with plain SQL — locally.',
    'One guarded sync pushes it.',
    '…and it lands in Notion, live.',
  ]),
  local: { pane: 'db', swap: { was: 'In Progress', now: 'Done', at: { step: 2, delay: 1350 } } },
  sync: { step: 3, duration: 1450 },
  remote: { pane: 'notion', swap: { was: 'In Progress', now: 'Done', at: { step: 3, delay: 1450 } } },
})

const localSwap = story.local!.swap
const localDoneReveal = story.gatedRevealClass(localSwap.at) // → r2b
const remoteDoneReveal = story.gatedRevealClass(story.remote.swap.at) // → r3b

const DB_TABLES = [
  { name: 'pages', icon: '▤', selected: true },
  { name: 'people', icon: '▤' },
  { name: '_sync_log', icon: '◈' },
]
const NOTION_NAV = [
  { icon: '🔍', label: 'Search' },
  { icon: '▤', label: 'Tasks', on: true },
  { icon: '🗓', label: 'Roadmap' },
]

const meta = {
  title: 'Kit/Sequence',
  component: Sequence,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Sequence>

export default meta
type Story = StoryObj<typeof meta>

/** The full sqlite "edit → sync → lands in Notion" flow, self-animating. */
export const EditSyncLand: Story = {
  render: () => (
    <div className="stage">
      <Sequence
        steps={story.steps}
        legendCap="The whole flow, in four steps"
        stage={
          <>
            <div className="seq-col left">
              <DbBrowser file={LABELS.sqliteFile} tables={DB_TABLES}>
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

            <Flow done="synced" idle="db sync" syncing="syncing…" />

            <div className="seq-col right">
              <NotionSurface workspace={LABELS.workspace} workspaceInitial={LABELS.workspaceInitial} nav={NOTION_NAV}>
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
                        <Swap was={<StatusPill status="In Progress" />} now={<StatusPill status="Done" />} />
                      </td>
                      <td>
                        <PriorityPill priority="High" />
                      </td>
                    </tr>
                    {TASKS.slice(1, 3).map((t) => (
                      <tr key={t.name}>
                        <td className="nm">
                          <span className="nmc">
                            <span className="pg">📄</span>
                            <span className="nmt">{t.name}</span>
                          </span>
                        </td>
                        <td>
                          <StatusPill status={t.status} />
                        </td>
                        <td>
                          <PriorityPill priority={t.priority} />
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
    </div>
  ),
}
