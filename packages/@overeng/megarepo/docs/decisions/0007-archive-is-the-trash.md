# The `.archive/` worktree convention IS the recoverable trash, reaped by retention

## Status

accepted

## Context

`mr store gc` has a second blind spot: archived worktrees. An external worktree
tool's `archive` operation moves a worktree from `refs/heads/<branch>/` to the
`<repo>/.archive/<name>/` convention (keeps `.git`, logs metadata to
`.archive/README.md`, optionally deletes the branch ref). gc only walks
`refs/{heads,tags,commits}` and skips dotfile dirs, so `.archive/` is never seen
— archives accumulate indefinitely (observed in real stores).

The `.archive/` convention already implements exactly the "move aside, keep
recoverable, record metadata" behaviour that decision 0004 (capture-then-delete)
needs. An archived worktree is also the clearest stale signal: the human
explicitly said "done".

## Decision

Unify the two: `.archive/` is the single recoverable holding area ("trash"). The
flow becomes:

1. A cold, stale, lossless worktree is **archived** (moved to `<repo>/.archive/`,
   metadata recorded) — recoverable, not yet reclaimed.
2. gc grows awareness of `.archive/` and **reaps archives past a retention TTL**
   (hard-delete), reclaiming the disk.

So decision 0004's "capture-then-delete" is implemented AS archiving, and a
single retention policy governs reclamation.

## Consequences

- gc must scan `.archive/` (currently skipped as a dotfile dir) for retention
  reaping, while still never treating it as a live `refs/*` worktree.
- mr takes a dependency on the `.archive/` store convention owned by the external
  worktree tool; the convention should be documented as part of the store layout
  so the two tools stay aligned.
- Reaping an archive must still honor the cross-megarepo live-set veto (an
  archived path should never be in any live set, but check rather than assume)
  and capture nothing further (archiving already captured it).
- Retention TTL is a tuning parameter (open question); archives carry a timestamp
  in their name/metadata to drive age.
