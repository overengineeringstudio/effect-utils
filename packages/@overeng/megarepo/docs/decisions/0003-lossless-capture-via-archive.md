# Lossless capture via `.archive/`; safety never depends on classifying dirt

## Status

accepted

## Context

A real-store survey proved that classifying uncommitted changes as "generated" vs
"source" by path is unreliable both ways (`src/build/app.ts` matched a `build/`
pattern but is hand-written; `*.d.ts.map` / `*.genie.js` are generated but matched
nothing). `mr` is generic and cannot know a repo's generated set, yet nearly every
cold worktree carries ~10 dirty files of regenerated drift — so "any dirt blocks
deletion" reclaims almost nothing.

Separately, gc had a blind spot: archived worktrees. An external worktree tool's
`archive` moves a worktree to `<repo>/.archive/<name>/` (keeps `.git`, logs
metadata), but gc walks only `refs/{heads,tags,commits}` and skips dotdirs, so
`.archive/` accumulated unboundedly. That convention already implements exactly the
"move aside, keep recoverable" behaviour capture needs.

## Decision

Deletion safety must NOT depend on the gen/source classifier. The lossless floor:
delete only when nothing irreplaceable is lost — every local commit is reachable
on a remote (`git rev-list <head> --not --remotes` empty after `fetch --prune`),
no unpushed commits, and **no stash** (stash refs live in the bare and do not
travel with a dir move). Any uncommitted/untracked dirt travels intact with the
move, so it does not block deletion.

Capture-then-delete is implemented AS **archiving to `.archive/`**: a qualifying
worktree is `git worktree move`d there (recoverable), its branch ref freed (so
`mr apply` can re-materialize it), then **reaped** (hard-deleted) once past the
retention TTL ([0005](0005-three-reclamation-timers.md)). gc grows awareness of
`.archive/` to reap it. "Generated vs source" is demoted to a UX-only filter.

## Consequences

- Provably lossless regardless of classifier accuracy; a wrongly-archived worktree
  is restorable until reaped.
- gc must scan `.archive/` (a known store convention, documented in the layout) for
  retention reaping, never treating it as a live `refs/*` worktree, and must
  re-check the cross-megarepo veto under lock before reaping.
- **Stash is checked repo-globally, kept that way** (validation): per-worktree
  stash would lift eligibility from 6 to ~61 worktrees (~7.9G), but the over-keep
  is conservative (never risks a stash) and per-worktree attribution is fuzzy.
