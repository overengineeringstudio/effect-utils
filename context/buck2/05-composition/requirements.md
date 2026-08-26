# Composition Requirements

This subsystem owns megarepo cell composition: how members form one Buck graph
and how action identity stays stable across composition shapes. It refines
BUCK-R05 and BUCK-R14. Architecture:
[decision 0014](../.decisions/0014-megarepo-cell-composition.md); evidence:
[.experiments/2026-08-25-cell-composition-key-stability.md](./.experiments/2026-08-25-cell-composition-key-stability.md).

## Assumptions

- **COMP-A01 Megarepo ownership:** Megarepo owns member materialization and
  the store-liveness accounting derived from it. (Its original form — "members
  are materialized as real directories" — was falsified on 2026-08-26: mr
  materializes absolute symlinks today; see COMP-R10 and
  [.experiments/2026-08-26-composition-root-real-repos.md](./.experiments/2026-08-26-composition-root-real-repos.md).)
- **COMP-A02 Identity mechanics:** Source paths render project-relative in
  action command lines, and outputs render under
  `buck-out/<isolation>/…/<cell>/<config-hash>/…`; mount path, cell name,
  platform label, and isolation dir therefore enter action identity.

## Acceptable Tradeoffs

- **COMP-T01 External namespaces:** An external consumer building a public
  member standalone uses the same synthesized root shape but inhabits its own
  cache namespace; no attempt is made to share keys outside the fleet.

## Requirements

- **COMP-R01 Synthesized root everywhere:** Every build — composed, single-repo
  CI, and standalone — runs from a synthesized composition root. A bare
  checkout as its own project root is a cache island and is not a supported
  build shape.
- **COMP-R02 Canonical mounts:** Each member has one canonical mount path
  (`repos/<name>`), identical in every composition and at every nesting level.
- **COMP-R03 Canonical cell names:** Each member has one canonical cell name,
  identical everywhere; a member's checked-in `[cell_aliases]` must agree with
  it (nested `[cells]` is ignored, nested `[cell_aliases]` is honored).
- **COMP-R04 Root-only declarations:** Cells, the prelude
  (`external_cells: bundled`), execution platforms, and
  `target_platform_detector_spec` are declared in the composition root's
  `.buckconfig` only, and the detector spec covers every cell — a cell reached
  only through a dependency edge must not resolve to a different configuration
  than the same target built directly.
- **COMP-R05 Shared platform labels:** Platform targets live in one canonical
  hub cell present in every composition; the same labels resolve everywhere
  (the label, not its content, enters the configuration hash).
- **COMP-R06 No member `.buckroot`:** Members ship no `.buckroot`; the
  composition root owns it. A cwd inside a member must not silently become its
  own project root with a second `buck-out`.
- **COMP-R07 Fixed isolation dir:** One isolation dir across all shapes; it is
  part of output paths and therefore of action identity. Per-invocation
  isolation dirs are forbidden.
- **COMP-R08 Real directories and admissible links:** Member mounts are real
  directories. Symlinks in inputs are either relative or target `/nix/store`
  paths (content-addressed, host-identical, and already carried in the digest
  via the capability closure identity); any other absolute symlink splits keys
  silently and is forbidden. Dereferencing `/nix/store` links is not a
  substitute — the capability contract requires store-resolved executables.
- **COMP-R09 Projection ownership:** The composition-root generator lives in
  megarepo (mr) and consumes per-member facts (canonical cell name, mount,
  ignore contributions) from a genie-projected member manifest; the discipline
  above is enforced by generation, not by developer memory (GRAPH-R07).
  Projected member targets declare cross-cell visibility — a member target
  without it is unreachable from consumers.
- **COMP-R10 Real-directory materialization:** mr materializes member mounts
  as real directories. Today's absolute-symlink materialization builds
  successfully but silently splits the cache namespace, so no shared-cache
  claim holds until this lands; store-liveness accounting must move with it.
