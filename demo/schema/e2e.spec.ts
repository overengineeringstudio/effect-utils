// E2E storyboard for the `notion schema` (IaC) demo — introspect a live Notion
// database → typed Effect schema → drift detection in CI. Beats: generate a
// typed schema with literal-union option types; regenerate the whole workspace
// from a config file; prove the generated file is in sync (`diff --exit-code`
// → 0); then introduce drift by adding a property in Notion and prove the gate
// fails (`diff --exit-code` → 1).
//
// Run (inside `devenv shell`, from repo root):
//   devenv shell -- bun demo/schema/e2e.spec.ts
//
// This demo is mostly TERMINAL + generated-file evidence. Assertions: the
// generated `.gen.ts` exists and contains a `Schema.Literal(` union; the diff
// exit code (surfaced as `DIFF_EXIT:$?` in the tee'd log); and the live data
// source gaining the `Blocked` property (authoritative via the Notion API). A
// single Notion screenshot of the Tasks DB is context.
//
// One-shot: beat4 permanently adds `Blocked` to the Tasks DB. Before each run,
// ensure it is absent (the runner's report is a durable capture regardless).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addCheckboxProperty,
  dataSourceHasProperty,
  resolveDataSourceId,
} from '../harness/notion-api.ts'
import { runDemo } from '../harness/runner.ts'
import type { Demo } from '../harness/spec.ts'

const DRIFT_PROP = 'Blocked'
const TASKS_ID = '"$(cat ../.demo-state/tasks-db-id)"'

const stateId = (demoDir: string, f: string): string =>
  readFileSync(join(demoDir, '.demo-state', f), 'utf8').trim()

// Memoize the Tasks data source id so the drift beats don't re-resolve it.
let tasksDsCache: string | undefined
const tasksDs = async (demoDir: string): Promise<string> => {
  if (!tasksDsCache) tasksDsCache = await resolveDataSourceId(stateId(demoDir, 'tasks-db-id'))
  return tasksDsCache
}

export const schemaDemo: Demo = {
  id: 'schema',
  title: 'notion schema — typed Effect schemas + CI drift detection',
  demoRel: 'demo/schema',
  stageRel: 'demo/schema/stage',
  resetRel: 'demo/schema/reset.sh',
  watchLog: 'run.log',
  isolate: false,
  pages: [{ role: 'tasks' }, { role: 'people' }],
  resolvePages: ({ demoDir }) => ({
    tasks: { id: stateId(demoDir, 'tasks-db-id'), url: stateId(demoDir, 'tasks-url') },
    people: { id: stateId(demoDir, 'people-db-id'), url: stateId(demoDir, 'people-url') },
  }),
  beats: [
    {
      id: 'beat1-generate',
      narration:
        'Notion gives you JSON. Point at a database and here is the whole thing as a typed Effect schema — generated, not written — with literal-union option types straight from the select options.',
      action: {
        kind: 'pty',
        cmd:
          `{ notion schema generate ${TASKS_ID} -o schema.gen.ts --typed-options --include-api;` +
          ` echo "GEN_EXIT:$?"; }`,
      },
      expectTerminal: /GEN_EXIT:0/,
      expectFile: { file: 'schema.gen.ts', contains: 'Schema.Literal(' },
      screenshot: ['terminal', 'notion'],
      capturePages: ['tasks'],
      budgetSec: 20,
    },
    {
      id: 'beat2-generate-config',
      narration:
        'That was one database. Now declare them all in a config and regenerate every binding in a single command — Tasks and a new People schema.',
      action: {
        kind: 'pty',
        cmd: `{ notion schema generate-config; echo "GENCFG_EXIT:$?"; }`,
      },
      expectTerminal: /GENCFG_EXIT:0/,
      expectFile: { file: 'people.gen.ts', contains: 'Schema.Literal(' },
      screenshot: ['terminal'],
      budgetSec: 20,
    },
    {
      id: 'beat3-diff-insync',
      narration:
        'Your code and your Notion database can silently diverge. Here they are in sync — the gate passes and exits zero.',
      action: {
        kind: 'pty',
        cmd:
          `{ notion schema diff ${TASKS_ID} --file schema.gen.ts --exit-code;` +
          ` echo "DIFF_EXIT:$?"; }`,
      },
      expectTerminal: /DIFF_EXIT:0/,
      screenshot: ['terminal'],
      budgetSec: 15,
    },
    {
      id: 'beat4a-add-property',
      narration:
        'Now someone changes the database — they add a "Blocked" checkbox in the Notion UI.',
      action: {
        kind: 'notion',
        run: async (ctx) => addCheckboxProperty(await tasksDs(ctx.demoDir), DRIFT_PROP),
      },
      expectNotion: async (ctx) =>
        dataSourceHasProperty(await tasksDs(ctx.demoDir), DRIFT_PROP),
      screenshot: ['notion'],
      capturePages: ['tasks'],
      notionReady: { kind: 'text', value: DRIFT_PROP },
      budgetSec: 15,
    },
    {
      id: 'beat4b-diff-drift',
      narration:
        'Re-run the exact same gate. It sees the new property, prints the drift, and exits one — nobody changes your schema without your build failing.',
      action: {
        kind: 'pty',
        cmd:
          `{ notion schema diff ${TASKS_ID} --file schema.gen.ts --exit-code;` +
          ` echo "DIFF_EXIT:$?"; }`,
      },
      expectTerminal: /DIFF_EXIT:1/,
      screenshot: ['terminal'],
      budgetSec: 15,
    },
  ],
}

if (import.meta.main) {
  const reset = process.argv.includes('--reset')
  runDemo(schemaDemo, { reset })
    .then((r) => process.exit(r.failCount === 0 ? 0 : 1))
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}
