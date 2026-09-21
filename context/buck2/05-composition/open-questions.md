# Composition Open Questions

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

**Resolved 2026-09-15 by
[decision 0034](../.decisions/0034-artifact-default-composition-no-registry.md)**
(q22/q23/q29): artifact-default cross-repository composition with no registry;
composed-by-default reverted; the composed shape stays on `main`, paused, as
the fallback until the last consumer edge leaves it. Remaining follow-ups,
carried as requirements in 0034: a strict second-install no-op per consumer
(pnpm injected-workspace pruning), peer-contract alignment per consumer, and
the L3 retirement ledger rows.

## Open 2026-09-12: root-owned capability cell (superseded for consumers by 0037 - a standalone root takes capabilities as a Nix output; remains only for the composed development root until L3 cut 2)

The hub loads the per-host capability projection from inside its own cell
(`buck2/toolchains/BUCK:1`, `configured.bzl:5,59`:
`//.buck2/capabilities/…`), so mr must write the projection into every mount
and no fetched or read-only hub can carry it
([2026-09-12-hub-as-external-cell](./.experiments/2026-09-12-hub-as-external-cell.md)).
Moving it to a root-provided `capabilities//` cell (declared by the root
generator, referenced by cross-cell labels) is the right ownership boundary in
every option on the table and is a precondition for rules-only external-cell
distribution of the hub. Blocked on: deciding the cell's contract (visibility,
generation identity checks) and the mr change that declares it.

## Resolved 2026-08-30: consumers share the hub's toolchain pins

The platform hub is the sole authority for Bun, pnpm, tsgo, and subsequent
toolchain instances. Member manifests declare typed toolchain requirements but
cannot select an instance or repeat Nix package, executable, or pin identity.
Composition resolves each requirement to the hub and fails before publication
on unknown or duplicate kinds, a non-hub authority declaration, or an attempted
member-owned override. A different consumer pin now requires an explicit
architecture change backed by a demonstrated incompatibility; it is not an
implicit per-member escape hatch.
