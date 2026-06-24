# Dependency Materialization Glossary

**Dependency materialization:** The process of realizing declared dependency
inputs into dependency data, projection state, native integrations, and
evidence that tools can execute against.

**Dependency data:** Package files linked or restored without running package
lifecycle code. Prepared dependency FODs contain dependency data, not live
package-manager state.

**Projection state:** Deterministic files derived after dependency data exists,
such as `node_modules/.bin` entries and profile-owned workspace links.

**Dependency materialization profile:** Versioned evidence that names the
topology, package-manager policy, toolchain inputs, store trait, authorities,
and semantic inputs for one materialization root.

**Store trait:** The declared storage and sharing strategy for a profile, such
as `ciJobLocal`, `darwinSplitCas`, `linuxSharedHardlink`, `isolated`,
`nixPreparedDeps`, or `frozenSeed`.

**Shared content pool:** A package-content store used by multiple profiles.
Pruning or garbage-collecting it requires root-set authority.

**Prepared dependency artifact:** A Nix fixed-output dependency data tree
created from declared inputs and restored into downstream builds.

**Native graft:** A platform-specific native package output supplied by Nix or
an explicit wrapper after prepared dependency data is restored.

**Pure package artifact:** Package contents accepted as dependency data without
running lifecycle scripts, downloads, source compilation, or generated native
build output.

**Buck2 evidence:** A declared dependency-profile fact consumed by Buck2 without
granting Buck2 authority over live pnpm install or shared-store repair.
