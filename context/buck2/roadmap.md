# Buck2 Adoption Roadmap

This roadmap derives rollout order from the Buck2 VRS: sequencing, entry conditions, and dissolution targets,
not migration state. Current authority, residual producers, transfers, measurements, and repository closes
come only from `buck2-ledger.json` in the private `schickling/megarepo-all` composition root, under the
[Authority Ledger contract](./spec.md#authority-ledger).

## Sequencing principle

Whole-repository exclusivity is the endgame (BUCK-R01); admission order is by value: expensive,
high-leverage operations first, cheap operations only when migrating them provably pays. Every authority
transfer carries its ledger row and deletes the superseded producer in the same change. Each repository
closes only when its residual list is empty and the BUCK-R15 net-complexity fold passes.

## Phase 0 — shared cache foundation

**Entry conditions:** A cache-only REAPI service is reachable inside its trust boundary; clients use the
canonical digest mode and cache namespace; outage and cross-worktree canaries satisfy BUCK-R06.

**Sequence:** Establish cache service and client configuration before admitting operations that depend on
cross-context reuse. Preserve Buck-native evidence for local versus cached execution.

**Dissolution target:** Remove per-command cache bypasses and temporary single-worktree evidence paths once
the shared-cache contract is the admitted path.

## Phase 1 — first TypeScript vertical slice

**Entry conditions:** The selected operation has a hermetic TypeScript rule, declared dependency surface,
deterministic projection, independent product bridge where applicable, and measurements within BUCK-R07.

**Sequence:** Transfer one high-leverage package operation end to end before widening the graph. Prove relevant
and irrelevant invalidation, hostile environment behavior, strict task ordering, and second-context reuse.

**Dissolution target:** Delete that package's root TypeScript producer entries,
dependent project-reference edges, package task edges, and any synthetic
evidence producer superseded by Buck-native evidence.

## Phase 2 — one-writable-member workspaces

**Entry conditions:** A synthesized workspace makes the store worktree its
root; every repository is a canonical member cell; exactly one owned member is
writable; other members are protected copies with atomic advance and the R6
post-condition.

**Sequence:** Land refusal guards before materialization and advance. Then
project canonical cells and capabilities, prove standalone/composed key
stability, and move consumers to the owned-member authoring surface.

**Dissolution target:** Retire legacy symlink mounts, shared branch attachments,
in-mount writes, member-local Buck roots, and cache-upload exceptions as their
consumers pass these proofs:

| Consumer class                                  | Retirement change                                                                                                   | Admission proof                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| CLI executed from another member's source mount | Execute the already-packaged Nix CLI; move each consumer's mount execution to that package                          | Command succeeds with the source mount protected and unchanged                           |
| Dependency task that writes another member      | Move the producer into that member's owned workspace; consume only committed source plus declared artifact overlays | Mutation sentinel remains clean across apply, task execution, and teardown               |
| Live cross-workspace branch sharing             | Commit upstream in its owned workspace, advance the consumer lock, then re-apply                                    | No non-owned mount is branch-attached; the lock advance alone changes the consumer input |

## Phase 2b — declared dependency closure

**Entry conditions:** Lockfile translation can derive hash-pinned fetch,
offline extraction, and per-importer assembly targets with deterministic
freshness and platform selection.

**Sequence:** Put the declared closure behind admitted packages before making
it the common dependency surface. Re-measure cold bootstrap against BUCK-R07.

**Dissolution target:** Delete the ambient store input, install and deploy
normalizers, install descriptors, transitional materializer, and CI store-cache
lane. A missing or mismatched package must fail rather than fall back.

## Phase 3 — TypeScript surface widening

**Entry conditions:** The package's dependencies are already available through
admitted source or dist edges, its package-local projection is deterministic,
and its authority-transfer evidence is complete.

**Sequence:** Admit package operations in dependency order, grouped into
reviewable dependency layers. Each package keeps an independent authority flip,
ledger row, evidence record, and measured budget.

**Dissolution target:** Per package, remove both root TypeScript producer
entries, obsolete project-reference edges, package-specific devenv or pnpm
build paths, and source aliases replaced by admitted dist edges.

## Phase 4 — dependency-surface authority transfer

**Entry conditions:** Every required editor, test, Storybook, Genie, lint, and
package-bin consumer has a Buck-owned view with freshness checks, correct
source/dist sibling behavior, and an atomic read-only publication path.

**Sequence:** Widen materialized editor views until no required consumer depends
on the root install, while keeping manifests and the lockfile as the sole
authored dependency authority.

**Dissolution target:** Delete the root install, its task graph edges,
package-manager mutation paths, and the remaining legacy package-bin
resolution paths.

## Phase 5 — Rust operations and products

- The complete five-member Rust workspace now compiles through Buck: otelite,
  otel-scrape, archive-tool, core, and product. Cargo manifests and the root
  lock remain request and resolution authority; generated first-party rules and
  the strict Reindeer graph project that authority without a second lock.
- Third-party Rust sources are Buck-fetched per
  [decision 0023](./.decisions/0023-buck-fetched-rust-crates.md): Reindeer uses
  `vendor = false`, 126 `http_archive` targets take their sha256 from the
  authoritative lock, and build/buildscript actions remain offline. The former
  Nix vendor realization, vendor symlink task, and vendored Cargo config are
  gone.
- `otelite` and `otel-scrape` emit strict `buck-build-product/v1` products for
  x86_64 Linux glibc, aarch64 Linux glibc, and aarch64 Darwin. Every tuple was
  executed natively, published under an immutable payload-addressed release,
  and independently imported through Nix with descriptor, digest, archive,
  runtime, entrypoint, and ad-hoc-signature validation.
- Flake packages/apps, devenv, and the reusable observability module now consume
  only the reviewed native-product manifest. The two
  `rustPlatform.buildRustPackage` product derivations, their shared narrow-source
  helper, and the direct Cargo release build are deleted. The independently
  realized Nix providers for stage-zero archive/product tools remain the
  intentional cycle-breaking boundary admitted by
  [decision 0010](./.decisions/0010-admit-rust-stage-zero-support-tools.md).
- The CI `cargo` operation remains outside Buck by policy: it aggregates the
  workspace contract, Cargo tests, Clippy, and rustfmt. Buck owns Rust
  compilation and shipped products; the operation ledger does not claim that
  the broader source-quality lane moved with them.
- Zero repository JavaScript pnpm-deps FOD producers remain. The last one,
  `oxc-config`, now emits its first-party plugin and StyleX upstream namespace
  shim as two explicit Buck module products; Nix imports their reviewed,
  content-addressed artifacts without rebuilding package sources. The
  repository CLI products remain on the same manifest-pinned import boundary.

## Phase 5b — distribution layer (decision 0037)

**Entry conditions:** Reconstruction is proven for one product (the
`from-source` derivation) and the public and private binary caches are
provisioned on every builder.

**Status:** Public effect-utils products use Cachix manifest v2; the
GitHub-release product importer and mixed-schema manifest are retired. Native
Rust products still use their separately reviewed immutable releases.

**Sequence:** Generate a sandboxed Buck-invoking derivation per product and
package (genie owns it; no hand-written recipes); publish through Cachix
(push, digest-named pin, provenance, anonymous post-publish verification for
public products); move private-shared products onto the private cache and
prove the Nix-realized tarball path for one pnpm consumer; repin existing
consumer edges from release URLs to cache URLs through the manifest.

**Dissolution target:** Delete the GitHub product publisher, the JavaScript
release-asset import path, and every consumer FOD that existed only to stage
producer sources. Keep the Cachix publisher and native-product import path.
Remote execution is not on this path (02-execution).

## Phase 6 — consumer adoption

**Entry conditions:** The producer repository is closed or exposes the required
admitted targets from merged authority; the consumer has a composed workspace,
stable cross-member labels, and trust-appropriate cache access.

**Sequence:** Adopt consumers in dependency order, beginning only from merged
producer authority. A consumer enters when its contributor and lifecycle
contracts are settled; dormant consumers enter only after resuming. Concrete
repository identities, order, and status live only in the private ledger.

**Dissolution target:** Delete each consumer's source-mount CLI execution,
cross-member dependency writers, live branch sharing, duplicate build
producers, and composition exceptions. At repository close, its residual list
is empty and both repository and cumulative net-complexity sums are negative.

## Phase 7 — action-level remote execution (BUCK-R17)

**Entry conditions:** DELTA-001 (second-context key instability) is closed;
the 0037 distribution layer is in use; an x86_64-linux worker host with
headroom exists.

**Sequence:** Define the worker image contract (02-execution open question);
stand up NativeLink cache + scheduler + one worker beside bazel-remote; prove
miss -> remote execution -> AC hit on real typecheck, emit, and test actions
with local execution disabled; then decide the bazel-remote replacement in a
decision record and retire it. Public/private trust tiers (0033) are preserved
by separate processes.

**Dissolution target:** bazel-remote and its service module once NativeLink
carries both tiers; no second cache backend is kept indefinitely.

## Cross-phase gates

- One authority transfer, ledger row, and deletion entry form the review unit.
- Transfer evidence proves hermeticity, causality, native evidence, and
  independent import where a product crosses into Nix.
- Shared rules and schemas remain free of consumer-private facts (BUCK-R14).
- Unit-test operations enter package by package after their hermetic runner and
  resource contracts are proved; integration and live-effect lanes remain
  outside Buck until separately bounded.
- Local check orchestration and public-runner cache topology remain governed by
  [open questions](./open-questions.md); sequencing does not pre-empt them.
