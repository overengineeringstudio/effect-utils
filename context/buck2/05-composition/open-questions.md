# Composition Open Questions

## Open 2026-09-12: is cross-repository cell composition worth its shape?

Composed cells exist for vision criterion 6 (a consumer builds producer
targets from the shared cache with source-granular invalidation). The cost is
the decision-0020 workspace shape and mr's mount pipeline (up to ~13–14k LOC
by attribution), paid today by effect-utils alone: no repository authors an
`effect_utils//` label and Phase 6 has not started. The only Buck2-native
alternative, git external cells, is rejected
([decision 0030](../.decisions/0030-external-cells-are-not-a-composition-mechanism.md)).
The first artifact-composition proposal (merged by mistake as a PR-local
record via #1271; removed 2026-09-14) ran its falsification spikes in PR #1282:
URL tarball closure, digest refusal, and a root-owned capability cell passed;
the consumer boundary failed (publisher rejected scoped names; a single URL
artifact could not coexist with workspace consumers under the consumer's pnpm
policy). The architecture bakeoff (PR #1287,
`.experiments/2026-09-13-composition-bakeoff.md`, proposed decision
`.decisions/.proposed/composition-architecture.md` on that branch) provisionally
selects artifact-default composition. Johannes (q22/q23, 2026-09-13) adopted
that direction with **no registry**: the durable origin is the existing
content-addressed buck2-products release layout, the CAS is an accelerator, and
consumers pin tarball URL + integrity in their lockfile. The one-edge proof
(PR #1289: `@overeng/utils` published, dotfiles notion-scan consuming by URL,
typecheck + 28 tests green) succeeded; its net (+482) is judged by the
reconciliation trajectory (decision 0031 Amendment 1). Composed-by-default
(decision 0027) stays paused until the proposal is promoted or rejected.
Remaining blocker: the constitutional edits (vision criterion 6, BUCK-R05/R06,
COMP-R01/R02) are Johannes', and pnpm's injected-workspace pruning must be
shown to be a strict no-op on the second install.

## Resolved 2026-09-17: root-owned capability cell

The composition root declares `capabilities = .buck2/capabilities`, and hub
toolchains load `capabilities//:defs.bzl` plus generation-keyed labels from that
cell. Nix is the sole producer: `packages.<system>.buck2-capabilities` derives
the projection from the tracked member manifest and the same flake package
outputs that the resolver consumes. The devenv shell links that store output
for a standalone root. `mr apply` verifies the same output and atomically links
it into the composition root. The shared TypeScript renderer defines the
projection bytes and generation identity for both paths. This removes the
per-mount write requirement while retaining strict manifest, platform,
executable, closure, and generation checks. Decision 0028 Amendment 1 records
the ownership change.

## Resolved 2026-08-30: consumers share the hub's toolchain pins

The platform hub is the sole authority for Bun, pnpm, tsgo, and subsequent
toolchain instances. Member manifests declare typed toolchain requirements but
cannot select an instance or repeat Nix package, executable, or pin identity.
Composition resolves each requirement to the hub and fails before publication
on unknown or duplicate kinds, a non-hub authority declaration, or an attempted
member-owned override. A different consumer pin now requires an explicit
architecture change backed by a demonstrated incompatibility; it is not an
implicit per-member escape hatch.
