// E2E storyboard for the `notion sqlite` demo — a Notion database bound as a
// local, scriptable SQLite file. Three beats: read the tracked DB as SQL; edit
// a row with plain `sqlite3` + `notion db sync` and watch it land in Notion;
// then a fail-closed guard that refuses unsafe writes with a typed error.
//
// Run (inside `devenv shell`, from repo root):
//   devenv shell -- bun demo/sqlite/e2e.spec.ts            # reuse current DB
//
// The row 'Ship onboarding checklist' must start NOT Done (its committed seed
// state is 'In progress'); the run flips it to 'Done'. No reset by default —
// tracking a fresh replica takes 1-2 min and we drive the already-provisioned
// stage (see harness/README; `isolate: false`).
//
// Assertions are authoritative via the Notion API (the row's Status property
// read back through `ntn api`); the terminal is secondary evidence. Because a
// one-shot `notion db sync` only renders output inside a real TTY, each beat
// appends `echo "…_EXIT:$?"` so the tee'd log carries a deterministic token.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataSourceRowSelect } from '../harness/notion-api.ts'
import { runDemo } from '../harness/runner.ts'
import type { Demo } from '../harness/spec.ts'

const ROW = 'Ship onboarding checklist'
const TARGET_STATUS = 'Done'

// `$(cat …)` shell fragment for the tracked replica's SQLite path.
const DB = '"$(cat ../.demo-state/sqlite-path)"'

const dsId = (demoDir: string): string =>
  readFileSync(join(demoDir, '.demo-state', 'ds-id'), 'utf8').trim()

export const sqliteDemo: Demo = {
  id: 'sqlite',
  title: 'notion sqlite — a Notion database as a local SQLite file',
  demoRel: 'demo/sqlite',
  stageRel: 'demo/sqlite/stage',
  resetRel: 'demo/sqlite/reset.sh',
  watchLog: 'run.log',
  isolate: false,
  pages: [{ role: 'db' }],
  resolvePages: ({ demoDir }) => {
    const read = (f: string) =>
      readFileSync(join(demoDir, '.demo-state', f), 'utf8').trim()
    return { db: { id: read('database-id'), url: read('database-url') } }
  },
  beats: [
    {
      id: 'beat1-read',
      narration:
        'This is my Notion database — and the same database as a local SQLite file. Not an export: a live, bound replica I can read with plain SQL.',
      action: {
        kind: 'pty',
        cmd: `sqlite3 -header -column ${DB} 'select "Name","Status","Priority","Team" from pages order by "Priority";'`,
      },
      expectTerminal: ROW,
      screenshot: ['terminal', 'notion'],
      capturePages: ['db'],
      notionReady: { kind: 'text', value: ROW },
      budgetSec: 8,
    },
    {
      id: 'beat2-edit-sync',
      narration:
        'I close a task out with plain SQL — no API, no code — then a guarded sync pushes it and verifies it landed in Notion.',
      action: {
        kind: 'pty',
        cmd:
          `{ sqlite3 ${DB} "UPDATE pages SET \\"Status\\" = '${TARGET_STATUS}' WHERE \\"Name\\" = '${ROW}';"` +
          ` && notion db sync . --no-materialize-bodies; echo "SYNC_EXIT:$?"; }`,
      },
      expectTerminal: /SYNC_EXIT:0/,
      expectNotion: (ctx) =>
        dataSourceRowSelect(dsId(ctx.demoDir), ROW, 'Status', TARGET_STATUS),
      screenshot: ['terminal', 'notion'],
      capturePages: ['db'],
      // Shoot only once the DB grid shows the row carrying its new value.
      notionReady: { kind: 'rowCell', row: ROW, value: TARGET_STATUS },
      budgetSec: 25,
    },
    {
      id: 'beat3-guard',
      narration:
        'Here is what makes it safe to actually use: it refuses anything it cannot prove is safe. A local DELETE never becomes a silent Notion deletion; a read-only property is never written. It degrades to a typed refusal, never to data loss.',
      action: {
        kind: 'pty',
        cmd:
          `{ sqlite3 ${DB} "DELETE FROM pages WHERE \\"Name\\" = '${ROW}';";` +
          ` sqlite3 ${DB} "UPDATE pages SET \\"Effort (h)\\" = 999 WHERE \\"Name\\" = 'Draft Q3 roadmap';"; }`,
      },
      // Both statements must produce the typed refusal from the file's triggers.
      // NB the runner whitespace-normalizes the log slice but NOT a regex, so
      // this pattern matches the space-stripped form of the two error lines.
      expectTerminal: /DELETEFROMpagesisintentionallyunsupported.*notsupportedfordirectwrites/,
      screenshot: ['terminal'],
      budgetSec: 8,
    },
  ],
}

if (import.meta.main) {
  const reset = process.argv.includes('--reset')
  runDemo(sqliteDemo, { reset })
    .then((r) => process.exit(r.failCount === 0 ? 0 : 1))
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}
