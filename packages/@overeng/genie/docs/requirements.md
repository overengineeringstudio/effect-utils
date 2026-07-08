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
- **T02 Runtime constraints over convenience:** Code imported directly by
  `.genie.ts` sources may reject otherwise-convenient npm dependency patterns
  when those patterns would require an already-installed `node_modules`,
  generated workspace state, or other post-bootstrap JavaScript environment.
  Helpers that need that richer environment may need to live in the CLI/build
  layer rather than the runtime layer. This tradeoff is acceptable because
  bootstrap safety and cross-repo composability matter more than making every
  helper usable from the runtime surface.
- **T03 Domain-owned heavy validation:** A domain generator may own node-side
  validation helpers for checks that need dependency-backed tooling, but Genie
  core must remain a generic validation runner. Domain-specific validation
  state should flow through an explicit extension point rather than hardcoding
  that domain into core.

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
- **R06 Runtime independence (bootstrap phase):** Every module in the
  _transitive_ runtime import closure of a **bootstrap-phase** `.genie.ts` (R31) —
  not only its direct imports — must remain usable without depending on an
  already-installed npm dependency graph. In particular, a bootstrap-phase source
  must not reach a runtime-only package through an intermediate helper or a wide
  barrel that `export *`s runtime code. Design-time generators are exempt (they run
  after install, R31/R32).
- **R07 Fresh-checkout safety:** A fresh checkout must be able to run Genie's
  bootstrap-phase generators successfully once its declared non-JS prerequisites
  are available, without requiring a pre-existing generated state.
- **R30 Bootstrap-closure enforcement (fast-feedback gate):** Genie must provide a
  static check that detects, before generation, any **bootstrap-phase** `.genie.ts`
  whose transitive runtime import closure reaches a package unavailable before
  install, reporting each violation as a contract violation carrying the importer
  chain (not an incidental package-resolution error); type-only edges are excluded.
  This gate is fast local feedback for R32's ordering, scoped to bootstrap-phase
  generators; it is not the sole authority.
- **R31 Generator phase:** Each generator has a phase — `bootstrap` (runs before
  package-manager install; must satisfy R06) or `design-time` (runs after install;
  may depend on the runtime graph). The phase must be declarable and discoverable
  **statically**, without importing the generator (importing a design-time
  generator would itself require the runtime graph). `design-time` is the default;
  `bootstrap` is opt-in.
- **R32 Empirical bootstrap verification:** The pre-install requirement must be
  _demonstrated_, not only statically asserted: the bootstrap-phase generators must
  be verified to actually run before install in a fresh, no-`node_modules`
  environment (using a self-contained runner) and to produce a state install
  accepts. A bootstrap-phase generator that reaches a runtime-only package must fail
  that cold run. This empirical check is the authority; the static closure gate (R30)
  is fast feedback. No hardcoded catalog of "install-input" artifacts is permitted.
  (Making install itself the completeness arbiter — failing on a missing generated
  input — is out of scope: it is infeasible here because generated outputs are
  committed (T01) and the runner is built from them. Consequently, whether every
  install-input generator carries the bootstrap declaration is not structurally
  enforced; see decision 0004's accepted residual.)

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
- **R11 Explicit composition layer:** Reusable cross-artifact composition must
  live behind explicit helper APIs or package subpath exports rather than hidden
  inference inside artifact-specific generators.
- **R12 Generator boundary preservation:** Artifact-specific generators must
  remain principled abstractions over their own target artifact or domain. A
  generator must not require knowledge of unrelated generators to understand
  its emitted output.
- **R13 Project-policy locality:** Project-specific catalogs, defaults, patch
  sets, Nix/FOD closure policy, and comparable local conventions must live in
  repository-local Genie helper modules unless they satisfy the reusable
  composition admission rule.
- **R14 Composition subpath semantics:** The canonical `@overeng/genie` export
  must remain the thin runtime API for artifact builders and shared primitives.
  More opinionated reusable composition helpers must be exposed through
  semantically named package subpaths such as `@overeng/genie/composition`.

### Must validate and fail clearly

- **R15 Duplicate-target rejection:** Genie must reject configurations where
  multiple sources claim the same generated target.
- **R16 Repository validation:** Genie must run repository-level validation so
  cross-file invariants are checked before reporting a successful run.
- **R17 Root-cause reporting:** Import cycles, TDZ failures, catalog conflicts,
  and comparable configuration errors must surface actionable diagnostics
  instead of opaque incidental stack traces.
- **R18 File-level reporting:** Batch runs must report per-file outcomes and an
  aggregate summary suitable for both local use and CI.
- **R19 Repository-bounded discovery:** Recursive discovery must respect the
  repository's ignore rules so ignored local state, nested agent worktrees, and
  other non-source scratch directories cannot become ambient generation input.
  Untracked but non-ignored `.genie.ts` sources must still be discovered.
- **R15a Domain validation extensions:** Genie validation context may carry an
  opaque extension registry for domain-owned validators. The registry must not
  make core depend on the domain's schema, runtime, or external tooling.

### Must support the main operating modes

- **R20 Generate mode:** Genie must write generated targets to disk for normal
  repository authoring workflows.
- **R21 Check mode:** Genie must verify up-to-date state without mutating
  targets.
- **R22 Dry-run mode:** Genie must support previewing prospective changes
  without writing files.
- **R23 Watch mode:** Genie must support an interactive mode that reacts to
  `.genie.ts` source changes and regenerates the affected output set.

### Must preserve output quality

- **R24 Supported formatting:** Generated outputs must respect the repository's
  supported formatting conventions so repeated generation does not create
  formatting churn.
- **R25 Stable metadata channel:** Composition metadata required by other
  generators must flow through an explicit structured channel rather than being
  reconstructed from rendered artifact text.
- **R26 Semantic metadata:** `GenieOutput.meta` must carry stable semantic facts
  such as identities, relationships, declared capabilities, and normalized
  authoring intent. Target-location-dependent projection values such as
  relative paths should be computed by projection helpers from metadata and
  render context instead of stored as producer metadata.
- **R27 Multi-artifact coverage:** The system must remain capable of generating
  the major repository artifact classes it already serves, including package
  manifests, TypeScript configuration, formatter/linter config, and GitHub
  workflow artifacts.
- **R23 Package export environment contracts:** Package manifest generation
  must allow a package export to declare the JavaScript environment it conforms
  to while emitting ordinary package.json exports.
- **R24 Package-json-owned export validation:** JavaScript export environment
  validation must be owned by the package-json generator. Genie core must not
  grow JavaScript-specific export, runtime, or TypeScript proof semantics.
- **R25 Constrained-environment coverage:** Export environment contracts must
  be able to represent constrained JavaScript targets including at least
  isomorphic ES, Node, Bun, browser, Web Worker, Cloudflare Workers/workerd, and
  React Native.
- **R26 Fast-path validation:** Export environment validation must avoid turning
  `genie --check` into a bottleneck. Cheap source/import checks may run
  normally; strict TypeScript proofs must be opt-in and cacheable.
- **R27 Conditional and patterned export coverage:** Export environment
  contracts must support conditional exports that need more than one
  environment proof, and package export patterns whose source target expands to
  multiple files.
- **R28 Source-only export contracts:** Package exports that exist for local
  source consumers but are intentionally absent from `publishConfig.exports`
  must remain contractable without forcing them into the published package
  surface.
- **R29 Export contract migration policy:** Package manifest generation must be
  able to suggest or require export environment contracts for every package
  export without making that policy mandatory for all repositories. The policy
  must support warning and error modes plus explicit ignores so downstream
  repositories can stage adoption while preserving a single validation surface.
