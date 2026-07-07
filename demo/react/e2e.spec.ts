// E2E storyboard for the `notion-react` demo — a Notion page written as a React
// component, reconciled by a diffing renderer. Beats: render the JSX tree cold
// (10 block appends); change one line (the budget) + rerun → a single in-place
// update; add a phase → a single insert; rerun unchanged → a genuine no-op. The
// printed op counts are the proof that reruns diff rather than rebuild.
//
// Run (inside `devenv shell`, from repo root):
//   devenv shell -- bun demo/react/e2e.spec.ts             # reset (fresh page) + run
//   devenv shell -- bun demo/react/e2e.spec.ts --no-reset  # reuse current page
//
// Reset is ON by default here: the hero of beat 1 is the COLD-cache render
// (appends:10), which the already-populated FsCache would otherwise collapse to
// zero ops. react's reset.sh is cheap (archive + create one page, clear cache,
// restore stage/page.tsx). Assertions are authoritative via the Notion API
// (the changed block's text read back); the terminal op counts are secondary.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pageHasText } from '../harness/notion-api.ts'
import { runDemo } from '../harness/runner.ts'
import type { Demo } from '../harness/spec.ts'

const NEW_BUDGET = '$5.1M'
const P4_TITLE = 'Phase 4 — Post-launch review'
const P3_LINE = `  { id: 'p3', title: 'Phase 3 — Retail rollout', body: 'flagship stores live' },`
const P4_LINE = `  { id: 'p4', title: '${P4_TITLE}', body: 'debrief and retro' },`

export const reactDemo: Demo = {
  id: 'react',
  title: 'notion-react — render JSX to a Notion page, diff-only reruns',
  demoRel: 'demo/react',
  stageRel: 'demo/react/stage',
  resetRel: 'demo/react/reset.sh',
  watchLog: 'run.log',
  isolate: false,
  // Notion is bursty-429 today: each `bun run page.tsx` sync retries internally
  // and can take ~60-90s. Space beats generously so each starts with a recovered
  // rate budget, and give beats big soft budgets so the poll ceiling (budget×4)
  // outlasts a slow, retried sync rather than declaring FAIL early.
  beatPauseMs: 20_000,
  pages: [{ role: 'page' }],
  resolvePages: ({ demoDir }) => {
    const id = readFileSync(join(demoDir, '.demo-state', 'page-id'), 'utf8').trim()
    return {
      page: { id, url: `https://www.notion.so/${id.replace(/-/g, '')}` },
    }
  },
  beats: [
    {
      id: 'beat1-render',
      narration:
        'This is a Notion page written as a React component — headings, a divider, a toggle per launch phase. I run the program and the whole page materializes.',
      action: { kind: 'pty', cmd: 'bun run page.tsx' },
      // Cold cache → 10 block appends (H1, para, divider, H2, 3 toggles + bodies).
      expectTerminal: /appends:10/,
      expectNotion: (ctx) => pageHasText(ctx.api, ctx.pageIds.page!, 'Q2 Launch Plan'),
      screenshot: ['terminal', 'notion'],
      capturePages: ['page'],
      notionReady: { kind: 'text', value: 'Q2 Launch Plan' },
      budgetSec: 40,
    },
    {
      id: 'beat2-budget',
      narration:
        'I change one value — the budget, one line of JSX — and rerun the exact same command. Only the intro paragraph changes: a single update, not a rebuild.',
      action: {
        kind: 'edit',
        file: 'page.tsx',
        apply: (t) => t.replace(`const budget = '$4.2M'`, `const budget = '${NEW_BUDGET}'`),
        then: 'bun run page.tsx',
      },
      expectTerminal: /updates:1/,
      expectNotion: (ctx) => pageHasText(ctx.api, ctx.pageIds.page!, NEW_BUDGET),
      screenshot: ['terminal', 'notion'],
      capturePages: ['page'],
      notionReady: { kind: 'text', value: NEW_BUDGET },
      budgetSec: 40,
    },
    {
      id: 'beat3-add-phase',
      narration:
        'Same deal for structure — I add a fourth phase and rerun. One new toggle appears at the end; everything else is untouched.',
      action: {
        kind: 'edit',
        file: 'page.tsx',
        apply: (t) => t.replace(P3_LINE, `${P3_LINE}\n${P4_LINE}`),
        then: 'bun run page.tsx',
      },
      // A new toggle + its nested paragraph = two appends.
      expectTerminal: /appends:2/,
      expectNotion: (ctx) => pageHasText(ctx.api, ctx.pageIds.page!, 'Phase 4'),
      screenshot: ['terminal', 'notion'],
      capturePages: ['page'],
      notionReady: { kind: 'text', value: 'Phase 4' },
      budgetSec: 40,
    },
    {
      id: 'beat4-noop',
      narration:
        'And re-rendering an unchanged tree is a genuine no-op — the stable block keys make the diff exact across separate runs.',
      action: { kind: 'pty', cmd: 'bun run page.tsx' },
      expectTerminal: /appends:0updates:0inserts:0removes:0/,
      screenshot: ['terminal'],
      budgetSec: 30,
    },
  ],
}

if (import.meta.main) {
  const reset = !process.argv.includes('--no-reset')
  runDemo(reactDemo, { reset })
    .then((r) => process.exit(r.failCount === 0 ? 0 : 1))
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}
