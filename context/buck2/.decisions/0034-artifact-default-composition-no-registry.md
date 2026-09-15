# 0034 Artifact-Default Cross-Repository Composition Without a Registry

Status: accepted

Promoted 2026-09-15 from the PR #1287 proposal after its acceptance gate was
met (q22, q23, q29). What changed between proposal and decision:

- **No registry.** The durable origin is the existing buck2-products
  content-addressed release layout (`nix/buck2-products/`), the shared CAS is a
  transport accelerator, and a consumer pins the producer package by tarball
  URL plus SHA-512 integrity in its lockfile. The proposal's "package registry
  as durable origin" is replaced by this; every other clause stands.
- **Proof.** PR #1289 published `@overeng/utils` and its three-package runtime
  closure as immutable release assets through the extended publisher and made
  dotfiles `apps/notion-scan` consume it by URL with its `link:` edge,
  `tsconfig` `paths` shim, and source-closure entry deleted; typecheck and 28
  unit tests pass. Edge net +482 (retained composition machinery counted in
  full), judged by the reconciliation trajectory (decision 0031 Amendment 1).
- **Residues carried as requirements, not blockers.** A consumer's second
  frozen install must be a strict no-op (pnpm injected-workspace pruning is
  observed today); peer contracts (Effect release candidates) must align per
  consumer before its edge migrates.
- **Pin derivation.** A consumer's URL and integrity derive from its
  `megarepo.lock` member commit through the producer's checked-in manifest, so
  the practiced repin flow is the version-resolution step; genie owns the
  derivation.
- Constitutional edits made in the same change: vision criterion 6 and problem
  4, BUCK-R05/R06, COMP-R01/R02, MR-R11, and amendments to decisions 0014,
  0020, 0027.

## Context

Decisions 0014, 0020, and 0027 selected composed Buck2 cells so a consumer can build producer targets with source-granular invalidation and shared action-cache reuse. That capability is real. It also requires a distinct composition root, one writable owned mount, replicated read-only mounts, generation/lock coordination, capability projection, and dist overlays. The production TypeScript directly under `packages/@overeng/megarepo/src/composition/` is 14,408 lines across 19 non-test files on 2026-09-13. No downstream repository on `main` authors an `effect_utils//` target label.

The [composition bakeoff](../../05-composition/.experiments/2026-09-13-composition-bakeoff.md) compares this contract against package artifacts and a hybrid. The [prior-art record](../../05-composition/.reference/2026-09-13-cross-repo-reuse-prior-art.md) shows that build-system cells, package releases, task caches, Nix outputs, and Git checkouts have different identities. No external tool makes cross-repository source composition free.

## Decision

If accepted:

1. **Use immutable package artifacts for ordinary cross-repository TypeScript library edges.** The identity is npm scope/name/version plus registry integrity in the consumer lock. The producer publishes Buck-built declarations and JavaScript through a package manifest transformed by `pnpm pack`; unresolved `workspace:` or local-path runtime dependencies are a publication error.
2. **Use the package registry as durable origin.** The registry must enforce immutable scope/name/version and retain every version referenced by a supported lockfile. The shared CAS may accelerate transfer, but it is not the only origin. This replaces the superseded proposal's direct GitHub Release URL because pnpm's default `blockExoticSubdeps` rejects transitive exotic sources and a direct URL does not supply package-version resolution.
3. **Let each consumer choose source or artifact per dependency edge.** A root-owned, parent-specific pnpm override selects the artifact for one consumer while the existing broad source override keeps other consumers on source. During migration, the generated package manifest remains the source of dependency names; the consumer lock is the resolved artifact source of truth. Remove the override after that consumer's manifest directly declares the registry version.
4. **Keep source composition outside Buck2 for active fork co-development and generator-source imports.** `mr` L1 worktree fleet and L2 `megarepo.kdl`/lock/member arrangement remain. An active fork can retain a source mount and ordinary package-manager/editor edges. It does not justify adding the producer repository to every consumer's Buck action graph.
5. **Retire cross-repository Buck2 cell composition after artifact adoption.** A repository's Buck graph contains that repository's source and installed dependency artifacts. No new downstream composed-cell rollout starts. Existing composed roots remain supported only during the migration and are removed after the last recorded consumer edge leaves them.
6. **Use Nix package outputs only for Nix-native executable/product edges.** Nix flakes are a good immutable identity and distribution path for products already consumed by Nix. They do not replace TypeScript package metadata, editor resolution, or pnpm lock identity.

## Why

Decision 0031 makes standing complexity a hard gate. Composed cells win source-granular invalidation, action-level reuse, and the shortest edit-to-test loop. The 14,408 production composition lines establish a gross deletion opportunity, not a passing net ledger: registry, publisher, provenance, package-closure, migration, and temporarily retained L3 machinery remain uncounted. This proposal therefore recommends a direction but cannot be accepted until BUCK-R15 proves the net result.

Artifact-default composition gives up source-granular invalidation across the repository boundary. It makes the boundary explicit: producer bytes change only when a new immutable package is published and the consumer lock changes. That package-granular invalidation is coarser but easier to inspect, reproduce, retain, and use from an editor or standalone clone. Breaking refactors become staged compatibility changes rather than an apparent atomic filesystem change followed by separate Git commits.

The hybrid is not the default because it retains both permanent mechanisms. Source mounts remain only for named active fork/generator exceptions; they do not imply Buck cell composition.

## Criterion Winners

| Criterion                              | Winner                                                            | Reason                                                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standing machinery                     | Artifact default, provisional                                     | Reuses package-manager and registry contracts and enables deletion of L3, but the complete net ledger is still an acceptance gate.                       |
| End-to-end incremental delta           | Composed cells                                                    | A source edit immediately reaches the consumer graph without publish and lock-update steps.                                                              |
| Correctness of invalidation            | Composed cells                                                    | Declared source bytes participate directly in the action input root. Artifact mode invalidates at the package identity.                                  |
| Shared-cache efficiency                | Composed cells                                                    | Unchanged producer actions can hit the shared action cache; artifact mode reuses whole package downloads and consumer actions only.                      |
| Cross-repository breaking refactor     | Composed cells for one-shot testing; artifact default for rollout | A composed root can test both source edits together. Immutable versions provide a safer staggered compatibility rollout across independent repositories. |
| Durability and provenance              | Artifact default                                                  | A write-once package version plus lock integrity is a durable dependency origin. Remote build caches are evictable acceleration.                         |
| Local editor and standalone ergonomics | Artifact default                                                  | Installed declarations work without a coordinated producer checkout or cross-root path shim.                                                             |
| Multi-agent / multi-worktree behavior  | Artifact default                                                  | Independent repositories and immutable versions avoid a shared writable composition state.                                                               |
| Operational observability and recovery | Artifact default                                                  | Publish/install/lock states use standard package identities; composed-cell failures span mount generation, lock, daemon, overlay, and cache state.       |
| Nix-native executable delivery         | Nix output                                                        | Flake lock plus store/substituter identity is already the native contract for this narrow edge.                                                          |

**Provisional overall winner: artifact-default composition.** This is a complexity-first recommendation, not a claim that artifacts beat cells on every criterion. Acceptance remains blocked on the complete net-complexity ledger below.

## Required Publication Contract

Before the first consumer migrates, the artifact lane must prove all of these conditions:

- `@overeng/utils` is published under its actual scoped name; transport slugs are separate fields.
- The package contains Buck-built `dist` JavaScript and declarations, and all `exports` resolve inside the archive.
- `pnpm pack` or its library contract rewrites `workspace:`/`catalog:` dependencies to ordinary versions. The publisher rejects remaining `workspace:`, `link:`, `file:`, or undeclared runtime closure edges.
- Scope/name/version is immutable, the lock records integrity, and the durable origin has a stated retention rule.
- A source edit that changes the public artifact cannot reuse the old package identity. Rebuilding identical package bytes either reuses the existing publication or proves byte equality.
- Publication emits provenance mapping producer commit, Buck target/action metadata, package identity, and archive digest.
- A BUCK-R15 ledger counts every permanent artifact-lane addition and every concrete deletion. During coexistence, it counts retained L3 in full. Artifact default is rejected if the net gate does not pass.

PR #1282 branch `schickling-assistant/2026-09-12-artifact-spikes` is the spike source. Its package packer and publisher changes are not duplicated here. That draft found two current blockers: the product publisher rejects scoped package identities, and the first `@overeng/utils` archive retained two `workspace:^` runtime dependencies. The bakeoff's locally transformed archive demonstrates the consumer resolution shape only; it is not a publishable implementation.

## Migration and Concrete Deletions

Migration is package-by-package:

1. Make one producer package publishable and prove its archive/closure.
2. Publish an immutable candidate version.
3. Give one consumer a parent-specific artifact override; regenerate/freeze its lock; typecheck and run its existing unit test.
4. Change that consumer's generated manifest to the registry dependency. Delete its source `link:`/`file:` edge, `tsconfig` path shim, and source-input closure entry.
5. Repeat. Keep source mode for an explicitly recorded fork/generator edge only.
6. After the final cross-cell label/overlay user is absent, delete the L3 implementation and amend decisions 0014, 0020, and 0027.

The final retirement ledger must name at least these deletion groups:

- `packages/@overeng/megarepo/src/composition/acquisition/`
- `packages/@overeng/megarepo/src/composition/apply/`
- `packages/@overeng/megarepo/src/composition/capabilities/`
- `packages/@overeng/megarepo/src/composition/mounts/`
- `packages/@overeng/megarepo/src/composition/overlays/`
- `packages/@overeng/megarepo/src/composition/root/`
- composition-only paths in `packages/@overeng/megarepo/src/cli/commands/composition.ts`, `check.ts`, `engine.ts`, `pin.ts`, and `status.ts`, with their composition tests
- composition-only configuration in `packages/@overeng/megarepo/src/core/config.ts` and the generated configuration schema
- composition-root exports in `packages/@overeng/megarepo/src/buck2-manifest.ts`
- composition-only workspace setup, mount, overlay, capability-projection, daemon-isolation, and root-publication task/script declarations
- each consumer's `generators.composition`, `.buckconfig` cross-cell mapping, dist-overlay declaration, source `link:`/`file:` edge, source-input closure entry, and TypeScript path shim after its artifact migration

The exact deletion count is intentionally not predicted. The 14,408-line measurement is a gross baseline, not a promised net deletion. Before acceptance, BUCK-R15 must count registry, publisher, provenance, package-closure, migration, and coexistence code against deletions. Retained L3 counts in full until it is actually removed.

## Rejected or Narrowed Alternatives

- **Composed cells as default:** retains the best incremental/cache behavior. It remains the fallback if the artifact lane cannot pass the net standing-complexity gate.
- **Hybrid cells for forks plus artifacts for libraries:** narrowed. Forks may retain L2 source mounts, but not permanent cross-repository Buck cells. Otherwise the hybrid retains both L3 and publication machinery.
- **Buck2 Git external cells:** decision 0030 remains valid; root-only, non-transitive pins do not supply package resolution or cross-root action-key stability.
- **Bazel Bzlmod:** useful prior art for module identity and root overrides, but replacing Buck2 is not part of this decision and would not remove the need to publish consumable TypeScript packages.
- **Nx/Turborepo cache:** task-result transport, not a durable dependency origin.
- **Nix-only library composition:** cannot provide the pnpm/editor package contract for ordinary TypeScript consumers.
- **Git submodules, worktrees, or Josh:** source checkout/history mechanisms, not immutable package publication across independent origins.

## Consequences and VRS Changes If Accepted

Acceptance requires explicit principal confirmation before constitutional edits. Then:

- Rewrite vision criterion 6 from producer-action reuse to immutable cross-repository product reuse, while keeping source-granular reuse inside one repository.
- Amend BUCK-R05/R06 and COMP-R01/R02 so cross-repository cells are not required.
- Amend decisions 0014, 0020, and 0027; keep their evidence but mark the superseded default/shape outcomes.
- Preserve decision 0030 and decision 0031.
- Add artifact-origin immutability, retention, provenance, and publication-closure requirements.
- Replace the downstream composed-root roadmap with package-by-package adoption and the deletion ledger above.

Until acceptance, all existing requirements and accepted decisions remain in force.
