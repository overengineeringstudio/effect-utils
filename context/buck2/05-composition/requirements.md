# Composition Requirements

This subsystem owns megarepo cell composition: how members form one Buck graph
and how action identity stays stable across composition shapes. It refines
BUCK-R05 and BUCK-R14. Architecture:
[decision 0014](../.decisions/0014-megarepo-cell-composition.md); evidence:
[.experiments/2026-08-25-cell-composition-key-stability.md](./.experiments/2026-08-25-cell-composition-key-stability.md).

## Assumptions

- **COMP-A01 Megarepo materialization:** Megarepo materializes member sources
  as real directories in composed worktrees.
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
- **COMP-R08 Real directories and relative links:** Member mounts are real
  directories. Absolute symlinks anywhere in inputs split keys silently;
  relative symlinks are the only permitted link form.
- **COMP-R09 Projection ownership:** Genie projects the composition root and
  megarepo materializes it; the discipline above is enforced by generation,
  not by developer memory (GRAPH-R07).
