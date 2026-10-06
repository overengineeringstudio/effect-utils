# Changelog

## Unreleased

### Added

- Deterministic, contained Vitest Buck lanes publish cacheable passing verdict
  artifacts with normalized reports and a `buck2 test` adapter. Failed suites
  exit nonzero and are never uploaded; `cacheable: false` lanes stay uncached.
- `@overeng/outline` provides theme-free outline hierarchy, measured reading-edge
  selection, fixed-pitch tick geometry, and React Aria navigation. Callers retain
  document discovery, scroll coordinates, and adapter subscription lifetimes.
  The nonmodal rail disclosure retains hover and focus, supports Escape with
  deliberate re-entry, and preserves native alternate anchor activation.
  Its focused test task publishes only the outline editor dependency view.
- Declared Darwin Swift app-bundle Buck products with deterministic bundle
  packaging and independent per-executable Mach-O inspection during Nix import.
- `@overeng/genie-smalltalk` agent declarations support the bare `handles-faults`
  flag and `rollout "manual"` policy. Omitting rollout preserves automatic rollout.
- Raw wasm32 guest Buck products with a declared host harness, module import
  descriptors, and independent Nix runtime inspection.

### Fixed

- The cached Genie CLI emits comment-free strict JSON for `.watchmanconfig`,
  matching its source-side generator and Watchman's runtime parser.
- Pipeline-report deadline coverage verifies bounded completion and retained results
  without requiring an incidental retry-attempt count or sub-100ms local HTTP service.
- Negative Buck artifact-import fixtures capture remote Nix builder logs, so
  expected rejection diagnostics are checked instead of generic build failures.
- Cache-less pinned Buck invocations select local-only posture before validating
  trusted archive metadata. Fixed-source Nix builds accept unused consumer-root
  placeholders while keeping remote uploads and archive-origin fetching disabled.
- The Vite build-identity dev plugin watches only its worktree's HEAD, current
  branch ref and index. Git snapshots are asynchronous, debounced and
  single-flight, and dirty checks exclude untracked files.
- Direct invocations of the shipped pinned `buck2` apply bounded cache admission:
  unreachable read-only REAPI endpoints fall back to local execution, and
  unreachable trusted archive origins fall back to the registry, with warnings.
  Healthy invocations cache admission briefly for warm loops; writer REAPI
  outages remain fail-closed. A successful probe is a reachability snapshot,
  not a guarantee against subsequent native transport failures.
  Launcher compilation isolates its working directory from Nix's temporary root
  so Darwin's read-only Bun clone cannot collide with the compiler's copy fallback.
- Genie bootstrap discovery excludes Buck output trees, so copied generator files
  in build artifacts do not enter source-tree closure checks.
- JavaScript product descriptor actions use the audited hermetic cache lane, so
  independent roots reuse their byte-identical descriptors instead of executing
  one default-denied local action.
- Buck remote-cache uploads reserve protobuf headroom below the backend's 4 MiB
  gRPC limit, including in generated consumer roots, so large React Aria
  dependency outputs upload and reuse across independent roots.
- TypeScript Git fixtures preserve the caller's environment while removing
  hook-local repository and index selectors, so temporary commits cannot alter
  the repository running the hook.
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
- Pipeline-report baseline deadline tests use a synchronized virtual clock,
  so host scheduling and HTTP latency cannot consume their deadline budgets.
- Vitest collection explicitly disables static parsing unless a package admits it,
  preserving runtime-generated test inventories with Vitest 5's changed default.
- pnpm lock mutation uses matching bytewise collation throughout its executable
  metadata preservation guard, regardless of the caller's locale.

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
