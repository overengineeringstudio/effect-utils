# Megarepo Vision

## The Problem

1. **Multi-repo work is fragmented:** Repositories that are developed together
   must be cloned, placed, and held at compatible revisions by hand; every
   workspace re-derives the same arrangement, and no two derive it identically.
2. **Cleanup loses work:** Ad-hoc checkout sprawl makes disk reclamation either
   unsafe — deleting a worktree that held the only copy of something — or
   perpetually deferred, so it never happens.
3. **Composition needs state no repository owns:** A composed build reads
   mounts, overlays, and tool capabilities in an exact locked shape.
   Hand-maintained workspace state drifts silently, and a half-updated
   workspace looks like a working one.
4. **Coupling would ruin the members:** Submodules and vendoring make a
   repository aware it is being composed, which taxes every standalone
   consumer to serve the composed one.

## The Vision

- A composed environment is declared once: `megarepo.kdl` carries hand-written
  intent, `megarepo.lock` carries tool-resolved state, and a workspace is
  reproducible from the lock plus the store — disposable by construction.
- One host-global store holds one bare repo per remote and one worktree per
  ref, shared by every megarepo on the machine; arrangement work is done once
  per host, not once per workspace.
- Members stay self-contained and unaware: a member works standalone,
  unchanged, and never carries composition metadata.
- A workspace is observably at the lock or observably refused — mounts,
  overlays, and capabilities apply atomically, and build authority is
  published last.
- Destruction demands positive evidence: nothing in the store is deleted while
  any workspace uses it, nothing irreplaceable is deleted at all, and every
  reclamation is recoverable before it is final.
- The composed workspace is the canonical development context for admitted
  repositories; standalone worktrees are the declared exception.

## What This Is Not

- It is not a package manager or dependency resolver: members are
  repositories arranged on disk, not versioned artifacts to solve over.
- It is not a build system, and it does not define composed-build
  correctness: the composition contract (`COMP-R*`) is owned by the buck2
  tree; `mr` implements it.
- It is not a sync or publishing tool: it never edits intent, and it never
  pushes member history anywhere.
- It is not git-hosting infrastructure: members remain ordinary clones that
  every git tool understands.

## Success Criteria

1. Two workspaces built from the same `megarepo.kdl` and `megarepo.lock` on
   any host have identical arrangement for every locked remote member: each is
   at its locked revision, and every corresponding mount matches its verified
   content identity. Local-path members are host-local inputs and are outside
   this cross-host criterion.
2. `mr apply` completes with the workspace exactly at the lock or fails
   naming the drift; no consumer ever observes an intermediate state.
3. No store operation deletes work that is not recoverable: every deletion
   passes the liveness veto, staleness, and lossless-floor gates, and is
   archived before it is reaped.
4. Store maintenance runs in bounded memory and bounded concurrency over a
   store of any size, and its safety gates are testable deterministically.
5. A member repository is untouched by composition: standalone use requires
   no changes, and the same member builds with identical action identities
   standalone and composed.
6. Development and agent worktrees for admitted repositories are composed
   workspaces by default, with standalone as a declared exception.
