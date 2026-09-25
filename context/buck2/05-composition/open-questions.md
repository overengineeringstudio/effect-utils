# Composition Open Questions

## Resolved 2026-09-25: the composed Buck root is retired (principal q5)

No consumer used the paused composed shape (`mr store worktree new --compose`,
the composition root and publisher, dist overlays, the per-workspace
capability resolver, and `cp -a` member mounts). All of it is deleted from mr
and from effect-utils' own declaration. Composition is now limited to source
mounts, which are never Buck cells (COMP-R02); COMP-R09 to COMP-R11 are
retired. The capability projection survives as the Nix
`buck2-capabilities` output for standalone roots.

## Resolved 2026-09-22: effect-utils CI uses the standalone checkout root

Decision q58 made the tracked standalone repository root normative for
ordinary development and single-repository CI. Effect-utils CI runs every lane
from the actions checkout; the trusted remote-cache proof compares a second
plain checkout at the same revision. CI no longer prepares or cleans a
composition root.

Decisions 0020 Amendment 4 and 0027 Amendment 1 recorded the paused composed
shape as the only exception; the 2026-09-25 retirement above removed it. The
public trust-tier deployment gates the live cache proof, not the root-shape
contract.

## Resolved 2026-09-15: accept artifact-default composition? — decision 0034; composition machinery is on the deletion path (q47, 2026-09-19)

Composed cells exist for vision criterion 6 as originally ratified (a consumer
builds producer targets from the shared cache with source-granular
invalidation). The cost is the decision-0020 workspace shape and mr's mount
pipeline (14,408 production lines by measurement), paid by effect-utils alone:
no repository authors an `effect_utils//` label. Git external cells are
rejected
([decision 0030](../.decisions/0030-external-cells-are-not-a-composition-mechanism.md)).
The first artifact-composition proposal (merged by mistake as a PR-local record
via #1271) ran its falsification spikes in PR #1282: URL tarball closure, digest
refusal, and a root-owned capability cell passed; the consumer boundary failed.
The [composition architecture bakeoff](./.experiments/2026-09-13-composition-bakeoff.md)
(PR #1287) then compared composed cells, artifact-default libraries, a narrowed
hybrid, and Nix outputs on the same edge, and the no-registry publication proof
(PR #1289: `@overeng/utils` published as a release asset, dotfiles notion-scan
consuming by URL, typecheck + 28 tests green) met the proposal's gate.

## Resolved 2026-09-17: root-owned capability cell (the composed half retired 2026-09-25; standalone roots take capabilities as a Nix output per 0037)

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

## Resolved 2026-08-30: consumers share the hub's toolchain pins (requirement resolution retired 2026-09-25 with the composed root; consumers take the pins through the shipped rules and capability outputs)

The platform hub is the sole authority for Bun, pnpm, tsgo, and subsequent
toolchain instances. Member manifests declare typed toolchain requirements but
cannot select an instance or repeat Nix package, executable, or pin identity.
Composition resolves each requirement to the hub and fails before publication
on unknown or duplicate kinds, a non-hub authority declaration, or an attempted
member-owned override. A different consumer pin now requires an explicit
architecture change backed by a demonstrated incompatibility; it is not an
implicit per-member escape hatch.
