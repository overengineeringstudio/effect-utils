/**
 * Surfaces.stories — the filled window surfaces: the SQLite `DbBrowser`, the
 * `MiniIDE` (+ `FileTree`), the `NotionSurface` (table + page variants) and the
 * `Terminal`. Data comes from fixtures.ts.
 *
 * REFACTOR NOTE: DbBrowser and NotionSurface take the tabular body as RAW children
 * — the story has to hand-author the `.dbb-grid` / `.ntn-tbl` `<table>` markup
 * (colgroup/thead/tbody, `.nmc`/`.pg`/`.colh` spans). There is no Row/Cell/Grid
 * component, so this markup is duplicated between every explainer and every story.
 * See the report's refactor-candidates list.
 */
import type { Meta, StoryObj } from '@storybook/react'
import {
  CodeLine,
  DbBrowser,
  type DbTable,
  FileTree,
  type IdeTreeItem,
  KW,
  MiniIDE,
  type NotionNav,
  NotionPage,
  NotionSurface,
  PriorityPill,
  STR,
  StatusPill,
  Terminal,
  TerminalLine,
  Tg,
  WinTitle,
} from './components.tsx'
import { LABELS, PRIORITY_OPTIONS, TASKS } from './fixtures.ts'

const meta = {
  title: 'Kit/Surfaces',
  parameters: { layout: 'padded' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

// ── DbBrowser ────────────────────────────────────────────────────────────────
const DB_TABLES: readonly DbTable[] = [
  { name: 'pages', icon: '▤', selected: true },
  { name: 'people', icon: '▤' },
  { name: 'sprints', icon: '▤' },
  { name: '_sync_log', icon: '◈' },
]

export const DbBrowserGrid: Story = {
  name: 'DbBrowser (SQLite)',
  render: () => (
    <div style={{ maxWidth: 430 }}>
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
            {TASKS.map((t, i) => (
              <tr key={t.name} className={i === 0 ? 'sel' : undefined}>
                <td className="gut">{i + 1}</td>
                <td>{t.name}</td>
                <td>{t.status}</td>
                <td>{t.priority}</td>
                <td>{t.team}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DbBrowser>
    </div>
  ),
}

// ── MiniIDE + FileTree ───────────────────────────────────────────────────────
const IDE_TREE: readonly IdeTreeItem[] = [
  { kind: 'fold', label: 'src' },
  { kind: 'file', label: 'notion.ts' },
  { kind: 'file', label: 'sync.ts', selected: true },
]

export const MiniIDEEditor: Story = {
  name: 'MiniIDE (editor)',
  render: () => (
    <div style={{ maxWidth: 460 }}>
      <MiniIDE file="sync.ts" tree={IDE_TREE} tab={<>sync.ts</>}>
        <CodeLine>
          <KW>import</KW> {'{ '}
          <Tg>Roadmap</Tg>
          {' } '}
          <KW>from</KW> <STR>'@acme/notion'</STR>
        </CodeLine>
        <CodeLine>
          <KW>const</KW> db = <Tg>Roadmap</Tg>.open()
        </CodeLine>
        <CodeLine role="orig">
          <KW>await</KW> db.tasks.set(<STR>'Ship v1'</STR>, <STR>'Done'</STR>)
        </CodeLine>
        <CodeLine role="recv">
          {'// ✓ synced to Notion · 12 rows guarded'}
        </CodeLine>
      </MiniIDE>
    </div>
  ),
}

/** FileTree in isolation — folder headers (`fold`) + selectable files. */
export const FileTreeOnly: Story = {
  name: 'FileTree',
  render: () => (
    <div style={{ maxWidth: 220, border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
      <FileTree
        items={[
          { kind: 'fold', label: 'src' },
          { kind: 'file', label: 'roadmap.nmd', selected: true },
          { kind: 'file', label: 'product-spec.nmd' },
          { kind: 'fold', label: 'docs', icon: '▸' },
        ]}
      />
    </div>
  ),
}

// ── NotionSurface (table) ────────────────────────────────────────────────────
const NOTION_NAV: readonly NotionNav[] = [
  { icon: '🔍', label: 'Search' },
  { icon: '▤', label: 'Tasks', on: true },
  { icon: '📄', label: 'Docs' },
  { icon: '🗓', label: 'Roadmap' },
]

export const NotionTable: Story = {
  name: 'NotionSurface (table)',
  render: () => (
    <div style={{ maxWidth: 356 }}>
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
            {TASKS.slice(0, 3).map((t) => (
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
  ),
}

// ── NotionSurface (page) ─────────────────────────────────────────────────────
export const NotionPageView: Story = {
  name: 'NotionSurface + NotionPage',
  render: () => (
    <div style={{ maxWidth: 356 }}>
      <NotionSurface
        workspace={LABELS.workspace}
        workspaceInitial={LABELS.workspaceInitial}
        nav={[
          { icon: '◆', label: 'Roadmap', on: true },
          { icon: '▦', label: 'Specs' },
        ]}
      >
        <NotionPage emoji="🚀" heading="Launch roadmap">
          <div className="blk">Finalize the API spec</div>
          <div className="blk">Ship v1</div>
        </NotionPage>
      </NotionSurface>
    </div>
  ),
}

// ── Terminal ─────────────────────────────────────────────────────────────────
export const TerminalSession: Story = {
  name: 'Terminal',
  render: () => (
    <div style={{ maxWidth: 430 }}>
      <Terminal title={<WinTitle logo="terminal" file="zsh — notion-db" />}>
        <TerminalLine>
          <span className="p">❯</span> notion db track tasks
        </TerminalLine>
        <TerminalLine out>pulling Tasks → {LABELS.sqliteFile}</TerminalLine>
        <TerminalLine out>
          {PRIORITY_OPTIONS.length} priorities · {TASKS.length} rows · ready
        </TerminalLine>
        <TerminalLine>
          <span className="p">❯</span> <span className="cur" />
        </TerminalLine>
      </Terminal>
    </div>
  ),
}
