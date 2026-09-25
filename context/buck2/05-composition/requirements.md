# Composition Requirements

This subsystem owns how repositories relate to Buck project roots: every
repository is its own standalone Buck root, and cross-repository composition is
limited to megarepo source mounts, which never form a Buck graph. It refines
BUCK-R05 and BUCK-R14. The composed Buck root of
[decision 0014](../.decisions/0014-megarepo-cell-composition.md) is retired
(principal q5, 2026-09-25); cross-repository consumption goes through published
artifacts and Nix outputs
([decision 0034](../.decisions/0034-artifact-default-composition-no-registry.md),
[decision 0037](../.decisions/0037-nix-substitution-is-the-distribution-layer.md)).

## Assumptions

- **COMP-A01 Megarepo ownership:** Megarepo owns member source mounts and the
  store-liveness accounting derived from them.
- **COMP-A02 Identity mechanics:** Source paths render project-relative in
  action command lines, and outputs render under
  `buck-out/<isolation>/…/<cell>/<config-hash>/…`; cell name, platform label,
  and isolation dir therefore enter action identity.

## Acceptable Tradeoffs

- **COMP-T01 Trust-tier namespaces:** External consumers and single-repository
  CI build public members from their tracked standalone repository roots. A
  trust tier may select a separate cache namespace; sharing action keys across
  trust tiers is not required.

## Requirements

- **COMP-R01 Standalone root only:** The tracked repository checkout is the
  only Buck project root, for development and CI alike. No tool synthesizes a
  cross-repository Buck root. Git external cells are not a composition
  mechanism
  ([decision 0030](../.decisions/0030-external-cells-are-not-a-composition-mechanism.md)).
- **COMP-R02 Source mounts are not cells:** A megarepo member mount
  (`repos/<name>`) is a source checkout for reading and editing. No Buck cell,
  target, or `load()` may reference a member mount; a repository consumes
  another repository only through published artifacts or Nix outputs.
- **COMP-R03 Canonical cell names:** Each repository has one canonical cell
  name, identical everywhere; its standalone root maps that name to `.`, and
  its checked-in `[cell_aliases]` must agree with it.
- **COMP-R04 Root-only declarations:** Cells, the prelude
  (`external_cells: bundled`), execution platforms, and
  `target_platform_detector_spec` are declared in the standalone root's
  `.buckconfig` only, and the detector spec covers every cell — a cell reached
  only through a dependency edge must not resolve to a different configuration
  than the same target built directly.
- **COMP-R05 Shared platform labels:** Platform targets live in one canonical
  package owned by effect-utils; every root that uses the shared rules resolves
  the same labels (the label, not its content, enters the configuration hash).
- **COMP-R06 Project-root markers:** A standalone repository ships `.buckroot`
  at its project root, so Buck never discovers an outer project.
- **COMP-R07 Fixed isolation per root:** Each standalone root has one fixed
  isolation dir, which is part of output paths and action identity.
  Per-invocation isolation dirs are forbidden.
- **COMP-R08 Content-reachable sources and admissible links:** Source bytes
  must be reachable inside the project root without traversing an absolute
  symlink, and any relative symlink must normalize to a path inside the project
  root. This is a correctness requirement, not a key-hygiene rule: Buck2
  collapses an absolute-symlink component into an opaque leaf whose only hashed
  payload is the target path string — the content behind it is NOT an input,
  edits do not invalidate, and one key serves stale artifacts (cache poisoning;
  see
  [.experiments/2026-08-27-symlink-content-blindness.md](./.experiments/2026-08-27-symlink-content-blindness.md)).
  The one admissible absolute-symlink class is `/nix/store` targets
  (content-addressed, host-identical, carried in the digest via the capability
  closure identity); dereferencing them is not a substitute — the capability
  contract requires store-resolved executables.
- **COMP-R09 Projection ownership:** Retired with the composed Buck root
  (principal q5, 2026-09-25).
- **COMP-R10 Content-real materialization:** Retired with the composed Buck
  root (principal q5, 2026-09-25).
- **COMP-R11 One writable mount per workspace:** Retired with the composed Buck
  root (principal q5, 2026-09-25).
