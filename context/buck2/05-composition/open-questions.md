# Composition Open Questions

## Open 2026-09-13: accept artifact-default composition?

The [composition architecture bakeoff](./.experiments/2026-09-13-composition-bakeoff.md)
provisionally selects immutable package artifacts for ordinary
cross-repository TypeScript library edges. It narrows source mounts to named
fork/generator exceptions and proposes retiring cross-repository Buck2 cells
after adoption. The
[decision 0034](../.decisions/0034-artifact-default-composition-no-registry.md)
records the criterion-by-criterion winners, concrete deletion ledger, and VRS
changes that require principal confirmation. The earlier
[artifact proposal](../.decisions/.superseded/artifact-composition.md) was
never accepted and is superseded by this bakeoff.

Blocked on: Johannes' architecture decision; a BUCK-R15 net-complexity ledger
that counts permanent artifact machinery and retains all L3 cost during
coexistence; and a real scoped-package publication proof that closes
package-manifest transformation, runtime closure, immutable origin/retention,
and provenance.

## Open 2026-09-12: root-owned capability cell

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
