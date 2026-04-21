# Genie Requirements

## Context

Genie is the shared repository-configuration generator used across the
`effect-utils` ecosystem and downstream megarepos. It must serve both
standalone repositories and composed megarepo workspaces, while remaining
usable in fresh-checkout and CI bootstrap paths where JavaScript dependencies
may not yet be installed.

## Assumptions

- **A01 Vision anchor:** These requirements serve the
  [vision](./vision.md).
- **A02 Package context:** The package-level README and build/runtime READMEs
  describe the current package surface and module boundaries; these
  requirements constrain that subsystem rather than redefining unrelated Nix or
  repository policy.
- **A03 Typed source model:** Repository configuration is authored in
  colocated `.genie.ts` source files and rendered into adjacent generated
  artifacts.

## Acceptable Tradeoffs

- **T01 Generated artifacts remain checked in:** Repositories may continue to
  commit generated outputs when downstream tooling expects real files, as long
  as those outputs remain mechanically derived from `.genie.ts` sources.
- **T02 Watch mode may be less complete than full batch mode:** Interactive
  watch flows may prioritize fast incremental regeneration as long as strict
  batch generation and check mode remain authoritative.
- **T03 Runtime constraints over convenience:** Runtime helpers may reject
  normal npm dependency patterns if that restriction is required to keep Genie
  bootstrap-safe and composable.

## Requirements

### Must preserve a single source of truth

- **R01 Colocated source:** Every generated artifact must have one canonical
  colocated `.genie.ts` source from which its target path is derived
  mechanically.
- **R02 Drift detection:** Genie must provide a strict check mode that fails
  when a generated artifact does not match the content implied by its
  `.genie.ts` source.
- **R03 Deterministic output:** For the same repository state, CLI options, and
  referenced generator inputs, Genie must produce byte-stable output.
- **R04 Direct-edit discouragement:** The default generation path must preserve
  a clear signal that generated artifacts are derived outputs rather than
  primary editable files.

### Must be bootstrap-safe

- **R05 Pre-install availability:** Repositories must be able to invoke Genie
  before `pnpm install` or equivalent JavaScript dependency materialization.
- **R06 Runtime independence:** Code imported directly by `.genie.ts` files
  must remain usable without depending on an already-installed npm dependency
  graph.
- **R07 Fresh-checkout safety:** A fresh checkout must be able to run Genie
  successfully once its declared non-JS prerequisites are available, without
  requiring a pre-existing generated state.

### Must support repository and megarepo composition

- **R08 Shared helper reuse:** `.genie.ts` files must be able to reuse shared
  runtime factories and helper modules across package and repository
  boundaries.
- **R09 Lock-pinned member resolution:** When a `.genie.ts` source imports from
  a megarepo member, resolution must respect the locked member identity instead
  of drifting to unrelated branch heads or ambient global state.
- **R10 Local iteration compatibility:** Cross-repo reuse must still allow
  local source iteration against the active composed worktree rather than
  forcing copy-paste or publish-and-upgrade loops.

### Must validate and fail clearly

- **R11 Duplicate-target rejection:** Genie must reject configurations where
  multiple sources claim the same generated target.
- **R12 Repository validation:** Genie must run repository-level validation so
  cross-file invariants are checked before reporting a successful run.
- **R13 Root-cause reporting:** Import cycles, TDZ failures, catalog conflicts,
  and comparable configuration errors must surface actionable diagnostics
  instead of opaque incidental stack traces.
- **R14 File-level reporting:** Batch runs must report per-file outcomes and an
  aggregate summary suitable for both local use and CI.

### Must support the main operating modes

- **R15 Generate mode:** Genie must write generated targets to disk for normal
  repository authoring workflows.
- **R16 Check mode:** Genie must verify up-to-date state without mutating
  targets.
- **R17 Dry-run mode:** Genie must support previewing prospective changes
  without writing files.
- **R18 Watch mode:** Genie must support an interactive mode that reacts to
  `.genie.ts` source changes and regenerates the affected output set.

### Must preserve output quality

- **R19 Supported formatting:** Generated outputs must respect the repository's
  supported formatting conventions so repeated generation does not create
  formatting churn.
- **R20 Stable metadata channel:** Composition metadata required by other
  generators must flow through an explicit structured channel rather than being
  reconstructed from rendered artifact text.
- **R21 Multi-artifact coverage:** The system must remain capable of generating
  the major repository artifact classes it already serves, including package
  manifests, TypeScript configuration, formatter/linter config, and GitHub
  workflow artifacts.
