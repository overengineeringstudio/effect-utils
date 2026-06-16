# `edit` stays a single-shot session — no live watch / bidirectional sync

A live, two-way watch mode was investigated — push each `:w` save to Notion as
you type (local→remote), and reflect upstream Notion edits into the open editor
buffer (remote→local) — and **rejected**. `edit` remains the single-shot
`$EDITOR` session of decision [0003](./0003-edit-is-a-session-not-live-sync.md) /
[0017](./0017-edit-is-an-ephemeral-file-engine-session.md): pull once → edit → push
once on clean exit. The "live" feeling is instead approximated by making the
**existing** post-exit push legible (staged progress, decision
[0018](./0018-staged-task-list-sync-progress.md)) and surfacing remote drift the
guarded push already detects as a visible stderr note.

## Why (two walls, both empirically spiked)

The reuse story is fine — push-on-save is the existing engine in a loop, and the
guarded push already self-advances its base snapshot per write, so the
"moving base" is free. The walls are not engineering gaps; they are inherent to
driving a black-box `$EDITOR` that owns its buffer **and** the terminal:

- **No live feedback (local→remote).** The editor is spawned with the real TTY
  inherited (`editor-commands.ts` `defaultRunEditor`, `stdin/stdout/stderr:
'inherit'`) and the CLI blocks on its exit. Nothing can render to that terminal
  while the editor is up without corrupting its screen. So per-save sync status
  could only ever appear _after_ the editor exits — which defeats watch mode.
- **No live reflection (remote→local).** Even if the CLI detects an upstream
  change (cheap via `last_edited_time`) and rewrites the temp file, it **cannot
  make the editor reload it**. Spiked in vim/nvim: `:set autoread` alone never
  reloads an idle buffer (needs `:checktime`, which only the user's own
  `CursorHold` autocmd fires, clean-buffer only); the CLI has no channel to send
  it because the editor owns the TTY. VS Code auto-reloads clean buffers;
  emacs/nano do not by default. A remote change against an _unsaved_ buffer is a
  destructive 3-way merge (vim throws a blocking `W12` modal).

Watch mode also forfeits the clean-abort guarantee (once a save lands, content is
on Notion — `:cq` can no longer mean "nothing synced") and spams Notion version
history (each `:w` is a full-body `replace_content`).

True live bidirectional editing requires a **custom TUI editor the CLI fully
owns** (OT/CRDT, drop `$EDITOR`) — a different product that abandons the
`git commit` / `kubectl edit` covenant this tool is built on. That is out of
scope here; if it is ever wanted it is its own VRS pass, not a tweak to `edit`.

## What we ship instead ("fix the hang + warn")

- **Staged progress** on the post-exit push (decision 0018, R43–R45): the silent
  multi-round-trip push surfaces as sequential stderr stage lines
  (observe → write-body → write-title → settle), so it no longer reads as a hang.
- **Drift notes**: when the guarded push auto-merges against a moved remote, or
  conflicts (exit 7, `.conflict.md`), `edit` emits a visible stderr note. This
  reuses the engine's **existing** drift outcomes — no background poller, no
  extra `last_edited_time` round-trip (which would swim against the
  redundant-pull collapse, #788, and the single-source-of-truth consolidation,
  decision [0019](./0019-one-canonical-body-at-both-wire-boundaries.md)).

## Status

accepted (reaffirms 0003 / 0017 with empirical spikes; composes with 0018
progress. Supersedes nothing — it records the rejection of an alternative.)
