# Changelog

## Unreleased

### Added

- Deterministic, contained Vitest Buck lanes publish cacheable passing verdict
  artifacts with normalized reports and a `buck2 test` adapter. Failed suites
  exit nonzero and are never uploaded; `cacheable: false` lanes stay uncached.
- Declared Darwin Swift app-bundle Buck products with deterministic bundle
  packaging and independent per-executable Mach-O inspection during Nix import.
- `@overeng/genie-smalltalk` agent declarations support the bare `handles-faults`
  flag and `rollout "manual"` policy. Omitting rollout preserves automatic rollout.
- Raw wasm32 guest Buck products with a declared host harness, module import
  descriptors, and independent Nix runtime inspection.

### Fixed

- The Vite build-identity dev plugin watches only its worktree's HEAD, current
  branch ref and index. Git snapshots are asynchronous, debounced and
  single-flight, and dirty checks exclude untracked files.
- The distributed Buck rules cell includes the verdict runtime, and Vitest rules
  own hermetic execution admission through the shared rules-cell constraint.
- The rules-product inventory test again verifies complete distribution sources
  and tool exports, including the Swift, wasm, hermetic and verdict additions.
- Repository-context rejection tests no longer assume the runner's temporary
  directory is outside the repository, preserving hermetic test containment.
- The JavaScript product-import contract task declares OpenSSL instead of relying
  on an ambient executable for its integrity fixture.
- Swift source products select bundle-aware runtime inspection during Nix import.
- Build-product imports defer read-only directory permissions until all archive
  children have been extracted.
- TypeScript Buck projections resolve source labels through the nearest declared
  package boundary, including workspace manifests nested under the consuming package.
- The trusted fresh-root Buck2 cache proof reads the latest command's event log
  with zero-based history and checks the pinned release's numeric action and
  upload enums.
- The Buck Git-archive hardlink regression constructs its physical fixture in the
  test sandbox, so source substitution and store optimization cannot invalidate
  its inode precondition.
- Buck action rules reject unaudited cache-platform requests using resolved
  constraint identities; relative labels and cell aliases cannot bypass
  `cacheable = False` or rule-owned cache eligibility.

### Changed

- Shared Buck cache reads and writes now require an audited hermetic execution
  platform; unadmitted actions default to no shared reuse. Admitted JavaScript,
  materialization, TypeScript and static-check actions start under projected
  native `env -i` before any interpreter. Bun startup uses an empty declared
  config and disables dotenv discovery and implicit installation. Arbitrary
  package check/build scripts are scrubbed but remain uncached.
- Tailnet host writers use per-host private-tier credentials and an explicit
  private endpoint; public read-only posture wins over credentials and selected
  writer outages fail closed.
- Browser Vite consumers reuse the canonical CLI build-identity formatter through
  `createBuildIdentityPlugin`, including immutable Nix metadata, worktree/HMR
  revisions, and runtime deployment identity injection.
  Source identities refresh on Git revision/index changes, source creation/deletion,
  and production watch rebuilds; embedded Nix identities remain immutable.
  The dev server exposes the same canonical JSON at `/build-identity.json` with
  no-cache headers and the complete source revision for exact served-source checks.
- Consumer Buck roots can map nested checkout patch paths to their exporting
  cells; the published rules cell exports the shared pnpm patches without loading
  standalone package declarations.
- Consumer roots render the trusted archive URL required by the shared cache
  posture reconciler; RE client configuration must precede daemon startup.
- Buck2 pipeline telemetry uses `vcs.provider.name`,
  `cicd.pipeline.task.run.result`, and `buck2.vcs.change.is_fork` in place of
  vendor provider, status, and fork keys. Job outcomes use the OpenTelemetry
  v1.44.0 result vocabulary; trace IDs and export admission are unchanged.

### Removed

- Retired the legacy pnpm CLI compiler, prepared-install dependency builders,
  workspace-install FOD hash registry, source-support package exports, and
  aggregate manifest alignment passthrough.
- Removed the obsolete prepared-install regression lane and builder-contract
  guard. Shared native dependency policy auditing remains a required CI lane.
- Removed the Buck test-lane declaration snapshot that compared authored exclusions
  with normalized ordering; lane partition and collection invariants remain covered.

Buck product imports, CLI wrappers, immutable dependency archives, shared build
identity, and live pnpm install policy and source-input algebra remain supported.
