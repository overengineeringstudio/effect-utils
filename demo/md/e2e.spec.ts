// E2E storyboard for the CORE `notion md` demo — two-way propagation, the
// ~3-min watch-mode hero. Three beats: start the watcher, local→Notion,
// Notion→local. (The guarded-merge / conflict scenario lives in the separate
// `e2e.merge-proof.spec.ts` appendix — it's an explainer deep-dive, not part of
// the core demo.)
//
// Run (inside `devenv shell`, from repo root):
//   devenv shell -- bun demo/md/e2e.spec.ts              # reset + full run
//   devenv shell -- bun demo/md/e2e.spec.ts --no-reset   # reuse current pages
//
// Assertions are authoritative via the Notion API; the terminal + local files
// are secondary evidence. On camera the "notion-side edit" beat is a human
// editing the browser; here we reproduce the same mutation through the API so
// the run is deterministic.

import { runDemo } from '../harness/runner.ts'
import { pageHasText, todoChecked } from '../harness/notion-api.ts'
import type { Demo } from '../harness/spec.ts'
import { mdScaffold, NEW_ENDPOINT, TODO } from './_shared.ts'

export const mdDemo: Demo = {
  id: 'md',
  title: 'notion md — two-way propagation',
  ...mdScaffold,
  // No shim: we drive the REAL on-camera umbrella command `notion md …`. The
  // `notion` (notion-cli) binary is on the devenv-shell profile, so the harness
  // must be launched inside `devenv shell` (see harness/README) — the pty
  // inherits that PATH and `notion` resolves exactly as it does for the presenter.
  beats: [
    {
      id: 'beat0-watch',
      narration:
        'One command. It watches two local files and keeps them in sync with Notion — no push, no pull; direction lives in each file.',
      action: {
        kind: 'pty',
        cmd: 'notion md sync --watch roadmap.nmd spec.nmd --poll-interval-ms 3000',
        background: true,
      },
      expectTerminal: '"event":"sync"',
      expectNotion: (ctx) => todoChecked(ctx.api, ctx.pageIds.roadmap!, TODO, false),
      screenshot: ['terminal', 'notion'],
      budgetSec: 12,
    },
    {
      id: 'beat1-local-to-notion',
      narration:
        'I check a box in my editor and save — watch pushes it straight to the Notion page.',
      action: {
        kind: 'edit',
        file: 'roadmap.nmd',
        apply: (t) => t.replace(`- [ ] ${TODO}`, `- [x] ${TODO}`),
      },
      expectTerminal: 'shared-merged',
      expectNotion: (ctx) => todoChecked(ctx.api, ctx.pageIds.roadmap!, TODO, true),
      screenshot: ['terminal', 'notion'],
      capturePages: ['roadmap'],
      // Shoot only once the web UI shows the box ticked (strikethrough text).
      notionReady: { kind: 'todoChecked', text: TODO },
      budgetSec: 10,
    },
    {
      id: 'beat2-notion-to-local',
      narration:
        'spec.nmd mirrors a page my team authors in Notion. I add an endpoint in Notion — a few seconds later it lands in my repo.',
      action: {
        kind: 'notion',
        run: (ctx) =>
          ctx.api.appendChildren(ctx.pageIds.spec!, [
            {
              type: 'bulleted_list_item',
              bulleted_list_item: {
                rich_text: [{ type: 'text', text: { content: NEW_ENDPOINT } }],
              },
            },
          ]),
      },
      expectTerminal: 'pulled',
      expectFile: { file: 'spec.nmd', contains: NEW_ENDPOINT },
      expectNotion: (ctx) => pageHasText(ctx.api, ctx.pageIds.spec!, NEW_ENDPOINT),
      screenshot: ['terminal', 'notion'],
      capturePages: ['spec'],
      // Shoot only once the new endpoint is visible on the page.
      notionReady: { kind: 'text', value: NEW_ENDPOINT },
      budgetSec: 12,
    },
  ],
}

if (import.meta.main) {
  const reset = !process.argv.includes('--no-reset')
  runDemo(mdDemo, { reset })
    .then((r) => process.exit(r.failCount === 0 ? 0 : 1))
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}
