Please implement the follow-up work for the now-locked cross-repo pnpm boundary spec.

The upstream spec has already been clarified and pushed. Treat that spec wording as authoritative.

## Core conclusion already locked in

Under the current Megarepo realization model:

- crossing a repo boundary happens via composition-local `link:` dependencies
- imported packages reachable under `repos/<repo>/...` do **not** become aggregate-root workspace importers merely because they are visible there
- if imported packages are ever meant to be true aggregate-root workspace importers, Megarepo must materialize them as real directories from pnpm’s perspective rather than through a symlinked repo-root boundary

So the current implementation must catch up to that.

## Problem to fix

Today the upstream Genie projection model still projects imported foreign repo members into aggregate root workspace membership under paths like:

- `repos/diffstream/packages/utils`
- `repos/effect-utils/packages/@overeng/utils`
- `repos/livestore/packages/@livestore/common`

That is currently produced through helpers such as:

- `packages/@overeng/genie/src/runtime/workspace-graph.ts`
- `packages/@overeng/genie/src/runtime/package-json/mod.ts`
- `packages/@overeng/genie/src/runtime/pnpm-workspace/mod.ts`

But downstream Megarepo realization still materializes `repos/<repo>` as a symlinked repo root.

That combination is structurally incompatible with root lockfile importer ownership, as validated by the isolated experiments and the real overeng failure.

## What to change upstream

### 1. Change aggregate root workspace projection to stop at the repo boundary

For aggregate root projection under the current Megarepo model:

- include local repo members as aggregate-root workspace members
- do **not** include imported foreign repo members under `repos/*` as aggregate-root workspace members

Cross-repo participation should instead continue through:

- generated `link:` dependencies
- aggregate dependency closure
- convergence/validation logic

Important files to inspect/update:

- `packages/@overeng/genie/src/runtime/workspace-graph.ts`
- `packages/@overeng/genie/src/runtime/package-json/mod.ts`
- `packages/@overeng/genie/src/runtime/pnpm-workspace/mod.ts`
- any unit tests that currently encode the old imported-member-as-root-workspace behavior

### 2. Keep the intended cross-repo local resolution model

Do **not** regress the desired model that:

- standalone repos still work standalone
- composed repos still work composed
- cross-repo local packages resolve through `repos/*`
- aggregate roots still own the composed install state

The fix is not to trim paths ad hoc downstream.
It is to make the upstream aggregate projection respect the locked boundary.

### 3. Add validation / regression coverage

Please add or update tests/validation so the new boundary is explicit and protected.

We want coverage for:

- local repo package seeds still become aggregate-root workspace members
- imported foreign repo packages do not become aggregate-root workspace members under the current model
- cross-repo local package edges still resolve through generated `link:` dependencies
- if there is a natural guardrail, it should fail explicitly when a symlinked imported repo root is being treated as a root workspace importer

## Downstream propagation

After upstream changes are in place, propagate the change down through the active worktrees.

Relevant worktrees:

- `/home/schickling/.megarepo/github.com/livestorejs/livestore/refs/heads/schickling/2026-03-10-livestore-megarepo-followup`
- `/home/schickling/.megarepo/github.com/schickling/dotfiles/refs/heads/schickling/2026-03-10-dotfiles-415-finish`
- `/home/schickling/.megarepo/github.com/overengineeringstudio/overeng/refs/heads/schickling/2026-03-10-adopt-effect-utils-353`
- `/home/schickling/.megarepo/github.com/schickling/schickling.dev/refs/heads/schickling/2026-03-10-adopt-368`
- `/home/schickling/.megarepo/github.com/schickling/schickling-stiftung/refs/heads/schickling/2026-03-10-adopt-368`
- `/home/schickling/.megarepo/github.com/overengineeringstudio/private-shared/refs/heads/schickling/2026-03-12-genie-alignment`

What to do downstream:

1. Regenerate/update aggregate root `package.json` and `pnpm-workspace.yaml` so imported `repos/*` package members are no longer listed as root workspace members under the current model.
2. Refresh lockfiles accordingly.
3. Re-run the previously failing frozen install cases where relevant, especially in:
   - `/home/schickling/.megarepo/github.com/overengineeringstudio/overeng/refs/heads/schickling/2026-03-10-adopt-effect-utils-353`
4. Do not add downstream hacks that trim `repos/` manually or special-case a single repo.

## Topological propagation order

Use a sane propagation order:

1. upstream `effect-utils`
2. repos that mainly validate/adopt the new projection model
3. finally the concrete failing downstream consumer (`overeng`)

Be explicit about the order you choose and why.

## Commits and pushes

Work in semantic milestones.

At each meaningful milestone:

- make a semantic commit
- push it
- then propagate the changes to the next dependent repo

Examples:

- upstream runtime/test change
- first downstream validation repo
- remaining downstream propagation
- final overeng frozen-lockfile verification

Do not leave the stack only locally updated.

## Validation target

The concrete downstream failure to fix is:

- repo:
  - `/home/schickling/.megarepo/github.com/overengineeringstudio/overeng/refs/heads/schickling/2026-03-10-adopt-effect-utils-353`
- failing commands:
  - `CI=1 devenv tasks run pnpm:install --mode before`
  - `pnpm install --frozen-lockfile`
- failing imported member:
  - `repos/diffstream/packages/utils/package.json`

The fix should make that model coherent, not merely make the error disappear.

## What I want back

Please report:

1. findings first
2. upstream changes
3. downstream propagation order and changes by repo
4. semantic milestone commits/pushes
5. validation results
6. any residual blockers or follow-ups
