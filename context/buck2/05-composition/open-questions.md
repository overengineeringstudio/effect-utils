# Composition Open Questions

## Resolved 2026-08-30: consumers share the hub's toolchain pins

The platform hub is the sole authority for Bun, pnpm, tsgo, and subsequent
toolchain instances. Member manifests declare typed toolchain requirements but
cannot select an instance or repeat Nix package, executable, or pin identity.
Composition resolves each requirement to the hub and fails before publication
on unknown or duplicate kinds, a non-hub authority declaration, or an attempted
member-owned override. A different consumer pin now requires an explicit
architecture change backed by a demonstrated incompatibility; it is not an
implicit per-member escape hatch.
