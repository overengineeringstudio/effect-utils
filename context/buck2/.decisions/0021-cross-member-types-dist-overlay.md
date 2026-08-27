# 0021 Cross-Member Types via Dist Overlay in Mounts

Status: accepted

## Context

Decision [0020](./0020-one-writable-mount-workspaces.md) left cross-member
TypeScript consumption as an owned open question: member mounts carry tracked
sources only (`dist` is gitignored, so it is absent from content-real mounts
by construction), the Phase-1 consumption mechanism (`exports` types →
`./dist/…`) resolves inside the package root, and member editor views cannot
publish into read-only mounts.

## Evidence and Argument

Today's cross-repo consumption is source aliasing into the mount — the
pattern the Phase-1 partition retired in-repo because it re-checks member
source in every consumer and bypasses the Buck2 boundary
([../02-execution/.experiments/2026-08-26-check-surface-partition.md](../02-execution/.experiments/2026-08-26-check-surface-partition.md)).
The mount-ignore audit already requires `**/dist` in the composition root's
`[project] ignore` (untracked-drift findings), which makes dist content
inside a mount digest-neutral: build inputs stay pure tracked sources while
the consumption surface rides along. The shared cache holds the member's
built dist at the locked revision (criterion-6 round trip proven), so the
materializer can pull rather than build in the common case.

## Options

| Option                             | Tradeoff                                                                              | Outcome  |
| ---------------------------------- | ------------------------------------------------------------------------------------- | -------- |
| Dist overlay in mounts             | One consumption mechanism in-repo and cross-member; materializer gains a pull step    | Accepted |
| Workspace-level types view         | Byte-pure mounts; second resolution mechanism (tsconfig paths) diverging from exports | Rejected |
| Keep source aliasing until Phase 6 | Zero work; 5x re-checking, no Buck2 boundary, deferral re-poses with sunk cost        | Rejected |

## Decision

Mount materialization produces tracked sources plus the member's Buck2-built
dist artifacts at the locked revision — pulled from the shared cache, built
locally on miss — with `dist` covered by the composition root's `[project]
ignore` so action digests remain pure-source. The Phase-1 `exports`
types→dist mechanism thereby works unchanged for editors, typecheck actions,
and test runners across members. Each member's genie projection declares its
dist surface (which targets constitute the overlay) so the materializer works
from a manifest, not a glob.

## Consequences

- Cross-member consumption gets the same drift posture as in-repo: the
  overlay is content-keyed to the locked revision; a stale overlay is
  impossible by construction (regenerated with the mount).
- The mount pipeline gains a cache dependency for the common path; a cold
  cache degrades to local builds of member dist targets, not to source
  aliasing.
- Source aliasing across members is retired as consumption once the overlay
  lands (deletion-ledger entry at that change).
