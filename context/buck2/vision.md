# Buck2 Repository Build Vision

## The Problem

1. **Repository work is too coarse:** Compilation, checking, testing, and
   packaging invalidate or execute more work than their semantic inputs
   require, and results are not reused across worktrees or machines.
2. **Build authority overlaps:** Nix, package managers, ecosystem tools, and
   wrappers can independently produce or gate the same repository-local result,
   and dependency state drifts silently between them.
3. **Nix is too slow for repository-local tools:** Packaging repo-local tools
   through Nix rebuilds sources and churns fixed-output hashes; the repair cost
   recurs on every dependency change.
4. **Composition does not compound:** Megarepo members share sources, but each
   repository rebuilds shared work from scratch; a producer's built output does
   not reach dotfiles or other members as an immutable, pinnable product.

## The Vision

- Bounded deterministic repository-local operations are declared once and
  produced by Buck with identities that follow their result-affecting inputs.
- One shared cache serves every worktree, machine, and composed repository:
  identical work executes once anywhere and is reused everywhere.
- Dependency state is a Buck-produced, verified artifact — including the
  editor surface — with no hand-maintained install step and no silent drift.
- Cross-repository reuse is artifact-granular: a producer publishes immutable,
  content-addressed products of its Buck graph, and a consumer pins them by
  digest in its own lockfile. No consumer carries a producer's action graph;
  source-granular reuse stays inside one repository.
- Nix supplies immutable inputs and independently verifies and imports portable
  Buck products into the Nix store; repo-local tools cross into system closures
  without source rebuilds or fixed-output churn.
- Every authority transfer deletes the producer it replaces; the system gets
  smaller as Buck's surface grows.

## What This Is Not

- It is not a replacement for Nix input, store, or system-realization authority.
- It is not a deployment, activation, rollback, or runtime-health framework.
- It is not a universal package-manager or dependency resolver.
- It is not a launcher or a second task graph around Buck.
- It is not an up-front portable kernel: sharing mechanics are extracted when a
  second consumer adopts, not designed ahead of one.

## Success Criteria

1. An irrelevant mutation executes no action for an unaffected admitted target;
   a relevant mutation executes exactly the affected closure.
2. A second same-platform context — another worktree or another machine — at an
   identical revision re-executes zero actions for unchanged admitted targets.
3. A warm no-op check of the whole admitted surface completes in at most 5
   seconds; a fresh context with a warm shared cache reaches green on the
   admitted surface in at most 3 minutes. Admission widening that breaks either
   budget is a regression to fix before widening further.
4. Each admitted operation has Buck as its only producer in normal development
   and CI, and the change that admits it deletes the superseded producer. The
   deletion ledger never carries an admitted slice with a surviving legacy path.
5. Admitted repository-local tools reach Nix consumers through product import
   with zero fixed-output hash repairs attributable to their dependencies.
6. A consuming repository (dotfiles first) installs a producer's Buck-built
   package by immutable digest from the shared product origin, with no source
   mount, path shim, or producer checkout, and a second install of the same
   pins is a strict no-op.
7. An independent Nix evaluation rejects a malformed or mismatched product and
   imports a valid product without rebuilding repository sources.
8. Dependency drift is impossible silently: a stale dependency surface fails
   loudly before it can produce a wrong green result.
9. Identical materialized bytes on one machine are stored once where the
   filesystem permits: assembled and materialized trees share storage through
   copy-on-write, and full duplication is confined to filesystems that cannot
   express it.
