// E2E storyboard for the `notion md` watch-mode demo — the typed source of
// truth the harness drives end-to-end and the artifact we review to dial the
// demo in before it's driven manually on camera.
//
// Run (inside `devenv shell`, from repo root):
//   bun demo/md/e2e.spec.ts              # reset + full run
//   bun demo/md/e2e.spec.ts --no-reset   # reuse current live pages
//
// Assertions are authoritative via the Notion API; the terminal + local files
// are secondary evidence. On camera the "notion-side edit" beats are a human
// editing the browser; here we reproduce the same mutation through the API so
// the run is deterministic.

import { runDemo } from '../harness/runner.ts'
import { blockTextEquals, pageHasText, todoChecked } from '../harness/notion-api.ts'
import type { Demo } from '../harness/spec.ts'

// Fixed strings shared across beats (must match seed/*.nmd + reset.sh output).
const TODO = 'Finalize the API spec'
const STATUS_BASE = 'On track for the Q3 release.'
const STATUS_REMOTE = 'Slipping — blocked on review.'
const STATUS_LOCAL = 'Ready to ship today.'
const NEW_ENDPOINT = 'DELETE /v1/pages'

export const mdDemo: Demo = {
  id: 'md',
  title: 'notion md — watch-mode hero',
  demoRel: 'demo/md',
  stageRel: 'demo/md/stage',
  resetRel: 'demo/md/reset.sh',
  watchLog: 'watch.log',
  // No shim: we drive the REAL on-camera umbrella command `notion md …`. The
  // `notion` (notion-cli) binary is on the devenv-shell profile, so the harness
  // must be launched inside `devenv shell` (see README) — the pty inherits that
  // PATH and `notion` resolves exactly as it does for the presenter.
  pages: [
    { role: 'roadmap', nmdFile: 'roadmap.nmd' },
    { role: 'spec', nmdFile: 'spec.nmd' },
  ],
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
      budgetSec: 12,
    },
    {
      id: 'beat3a-stop-watch',
      narration:
        'Now the case every naive sync gets wrong: my teammate and I edit the same line at once. First I stop the watcher so the conflict is deterministic.',
      action: { kind: 'pty-signal', key: 'ctrl+c' },
      screenshot: ['terminal'],
      budgetSec: 3,
    },
    {
      id: 'beat3b-notion-edit',
      narration:
        'My teammate edits the Status line in Notion — "On track" becomes "Slipping — blocked on review."',
      action: {
        kind: 'notion',
        run: async (ctx) => {
          const block = await ctx.api.findBlockByText(ctx.pageIds.roadmap!, STATUS_BASE)
          if (!block) throw new Error(`Status block "${STATUS_BASE}" not found`)
          await ctx.api.updateBlock(block.id, {
            paragraph: {
              rich_text: [{ type: 'text', text: { content: STATUS_REMOTE } }],
            },
          })
        },
      },
      expectNotion: (ctx) => blockTextEquals(ctx.api, ctx.pageIds.roadmap!, STATUS_REMOTE),
      screenshot: ['notion'],
      capturePages: ['roadmap'],
      budgetSec: 6,
    },
    {
      id: 'beat3c-local-edit',
      narration:
        'At the same time I change the same line in my editor to "Ready to ship today." and save.',
      action: {
        kind: 'edit',
        file: 'roadmap.nmd',
        apply: (t) => t.replace(STATUS_BASE, STATUS_LOCAL),
      },
      expectFile: { file: 'roadmap.nmd', contains: STATUS_LOCAL },
      budgetSec: 3,
    },
    {
      id: 'beat3d-guarded-merge',
      narration:
        'One sync. It refuses to clobber — writes a conflict draft with Base/Local/Remote, and Notion is untouched.',
      action: { kind: 'pty', cmd: 'notion md sync roadmap.nmd' },
      expectTerminal: 'shared-conflict',
      // Authoritative: Notion still shows the teammate's line — NOT clobbered.
      expectNotion: (ctx) => blockTextEquals(ctx.api, ctx.pageIds.roadmap!, STATUS_REMOTE),
      // The conflict artifact captured the local edit.
      expectFile: { file: 'roadmap.nmd.conflict.roughdraft.md', contains: STATUS_LOCAL },
      screenshot: ['terminal', 'notion'],
      capturePages: ['roadmap'],
      budgetSec: 10,
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
