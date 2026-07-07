// APPENDIX — guarded-merge proof (NOT part of the ~3-min core demo).
//
// Proves `notion md`'s money claim for the explainer deep-dive: when the same
// line diverges on BOTH sides, it writes a `*.conflict.roughdraft.md` and leaves
// Notion untouched — it never clobbers. Self-contained: start the watcher to
// establish an in-sync base, stop it (so the conflict is deterministic), diverge
// the same Status line in Notion (via API) and locally, then one-shot sync.
//
// Run (inside `devenv shell`, from repo root):
//   devenv shell -- bun demo/md/e2e.merge-proof.spec.ts
//
// Its own evidence + served report (id `md-merge-proof`) — separate from the
// core demo report so the core storyboard stays clean and tight.

import { runDemo } from '../harness/runner.ts'
import { blockTextEquals } from '../harness/notion-api.ts'
import type { Demo } from '../harness/spec.ts'
import { mdScaffold, STATUS_BASE, STATUS_LOCAL, STATUS_REMOTE } from './_shared.ts'

export const mdMergeProof: Demo = {
  id: 'md-merge-proof',
  title: 'notion md — guarded-merge proof (appendix)',
  ...mdScaffold,
  beats: [
    {
      id: 'mp0-watch',
      narration:
        'Baseline: the watcher is running and both files are in sync — the Status line reads "On track for the Q3 release."',
      action: {
        kind: 'pty',
        cmd: 'notion md sync --watch roadmap.nmd spec.nmd --poll-interval-ms 3000',
        background: true,
      },
      expectTerminal: '"event":"sync"',
      expectNotion: (ctx) => blockTextEquals(ctx.api, ctx.pageIds.roadmap!, STATUS_BASE),
      screenshot: ['terminal', 'notion'],
      capturePages: ['roadmap'],
      budgetSec: 12,
    },
    {
      id: 'mp1-stop-watch',
      narration:
        'I stop the watcher first — under a running watcher a fast poll could pull the remote edit before the local one lands, turning the conflict into a plain pull.',
      action: { kind: 'pty-signal', key: 'ctrl+c' },
      screenshot: ['terminal'],
      budgetSec: 3,
    },
    {
      id: 'mp2-notion-edit',
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
      id: 'mp3-local-edit',
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
      id: 'mp4-guarded-merge',
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
  runDemo(mdMergeProof, { reset })
    .then((r) => process.exit(r.failCount === 0 ? 0 : 1))
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}
