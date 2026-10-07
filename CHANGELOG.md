# Changelog

## Unreleased

### Added

- Every Buck cache-enabled CI job retains complete sanitized gzip JSONL action
  identities beside its existing compact evidence summary. The warm99 evaluator
  joins prior successful uploads against fresh-root readers per lane and rejects
  missing evidence, requiring two consecutive observations at or above 99%.
- pnpm development installs can opt into the graph-hashed global virtual store;
  default and CI installs retain root-local projections.
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

- Browser and workerd delivery smokes run the shared scheduler-panic scenarios
  through the explicit `browserWorker` and `workerd` runtime constructors.
- Cold recursive megarepo apply can materialize nested mounts in commit worktrees
  created by that invocation, without authorizing canonical source or lock writes.
- The pnpm task smoke test checks the stable Effect 4.0.0 cohort override rather
  than the superseded release-candidate pin.
- Buck capability projections and shipped rules use narrowly declared Nix
  source filesets, preserving store identities across unrelated checkout changes.
  Source-boundary test fixtures resolve physical temporary paths so macOS
  symlinked temporary directories remain valid Nix source inputs.
- Cheap Buck dependency extraction/store assembly and package-tree projections
  bypass remote-cache reads and uploads: rebuilding locally avoids downloading
  hundreds of MiB for inexpensive filesystem work. Cache evidence and warm99
  report these actions separately as `local-materialization-policy` exclusions;
  compute and deterministic verdict actions retain remote-cache reuse.
- `build-products` stays credential-free: its sandboxed Nix product builds do not
  upload Buck actions, so they no longer receive an ineffective cache writer secret.
- Buck cache admission gives concurrent REAPI and archive-origin probes 2500 ms
  per attempt with one immediate retry (5000 ms total per endpoint), covering
  measured Namespace TLS stalls and permitting lost-SYN recovery before selecting
  the existing warning and fallback policy. Required writers remain fail-closed
  after both failures;
  Watchman's 900 ms deadline is unchanged. Cache-evidence summaries retain
  per-invocation `admissionInvocations` and endpoint-wise `admissionFallbacks` /
  `admissionRetrySuccesses`, including writer refusals without native logs.
- Buck REAPI preflight diagnostics distinguish DNS, TCP, TLS, and response phases
  with elapsed time, deadline, and socket address families. Public IPs are visible;
  private addresses, endpoint names, and credentials remain redacted.
- The Buck rules distribution inventory regression covers the generated Effect/Rust
  service helpers alongside the existing interop package helper.
- Generated Effect/Rust services keep inline input and output codecs distinct and
  reject conflicting synthetic names or collisions with Rust contract definitions.
- Effect/Rust Worker handlers own request-local scopes, releasing resources before
  successful responses and cancellation acknowledgments.
- Async wasm scheduler traps poison their lexical generation, defect pending calls,
  and unblock interrupted orphaned promises without affecting another instance.
- Scalar integer wasm/native arguments reject nonfinite, fractional, out-of-width
  and negative-zero inputs before backend ABI narrowing.
- Cache evidence preserves finalized job timestamps on failure, grants freshness
  to the first action-bearing invocation rather than preceding audits, and
  retains nondigest local-action-cache reuse as excluded nonfresh evidence.
  Cargo and ref-policy jobs are explicitly outside native remote-cache lanes.
- Main-push tested-tree reuse judges successful required queue checks from the
  current attempt, without waiting for optional jobs or rejecting their failures.
- Native dependency policy CI runs its Bun tests by explicit source paths instead
  of matching duplicate test files inside Buck validation outputs.
- Protected-main merge-group gates opportunistically populate the public Buck
  cache without exposing credentials to PR runs. Main pushes skip heavy gates
  only after matching their tree to successful required queue checks; publishers
  and empirical/cache proofs keep running. Optional tree-lookup failures retain
  alignment dispatch after successful fallback quality and publication.
- Fixed-source Nix products bound Buck execution, Tokio workers, and blocking
  threads to the Nix core budget, with unset/zero budgets normalized to one.
  Worker configuration follows the `build` subcommand so Buck accepts the flags.
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
- Native Effect/Rust panic retirement cancels sibling abortable futures and waits
  for settle-only futures before releasing or replacing the generation.
- Portable regex end anchors respect backslash parity in both compiler directions;
  escaped literal dollars are rejected while anchored literal backslashes work.
- Native scalar `f32` admission checks finiteness after binary32 rounding, matching
  wasm at the maximum finite boundary.
- Buck roots use Watchman with output-directory exclusions and idle watch reaping.
  This prevents daemon startup from recursively traversing ignored build outputs
  and dependency symlinks; warm commands no longer need a full-file hash crawl.
  The packaged entrypoint admits the actual service before native startup, with
  a bounded probe and short-lived environment-scoped cache. Unavailable Watchman
  warns and falls back to notify; explicit local providers remain authoritative.
  Immutable Nix source products retain their service-free `fs_hash_crawler`
  override because Watchman's state initialization is forbidden in the sandbox.
- The distributed Buck rules cell includes the verdict runtime, and Vitest rules
  own hermetic execution admission through the shared rules-cell constraint.
- Rules-product inventory tests verify the exact declared source list, shipped
  dependency closure, and realized distribution contents.
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
- Effect/Rust object transports normalize safe integral JavaScript doubles before
  decoding integer contracts, including bounded numbers. JSON-text admission
  still rejects noncanonical integer spellings such as `1.0`.
- Effect/Rust fixture test executables resolve Node-API symbols dynamically;
  native addon products retain real host-symbol lookup.
- Effect/Rust workspace packages participate in the root TypeScript project
  registry, and the distributed Buck rules include the service-packaging tool.
- PTY client tests pair runtime module mocks with runtime cleanup on Vitest 5.

### Changed

- Storybook preview builds select Storybook package inputs and their generated
  transitive workspace dependency closure. Unrelated pull requests avoid preview
  build and deploy runners; required Storybook plays execute on the native merge
  queue head rather than consuming runners on individual pull requests.

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
- The Effect runtime and every runtime `@effect/*` package use the stable
  4.0.0 cohort. Consumers require matching stable versions and Vitest 5.
- Consumer Buck roots can map nested checkout patch paths to their exporting
  cells; the published rules cell exports the shared pnpm patches without loading
  standalone package declarations.
- Consumer roots render the trusted archive URL required by the shared cache
  posture reconciler; RE client configuration must precede daemon startup.
- Buck2 pipeline telemetry uses `vcs.provider.name`,
  `cicd.pipeline.task.run.result`, and `buck2.vcs.change.is_fork` in place of
  vendor provider, status, and fork keys. Job outcomes use the OpenTelemetry
  v1.44.0 result vocabulary; trace IDs and export admission are unchanged.
- Effect-rust wasm browser/default entries now fetch an emitted `.wasm` asset
  and instantiate it through pinned wasm-bindgen streaming glue. Explicit inline
  entries remain no-fetch, Node retains CJS glue, and Bun retains inline delivery.
- Split effect-rust Wasm runtime constructors and generated statics into
  `browserWorker` (external asset) and `workerd` (precompiled Module), replacing
  the ambiguous `worker` loader.

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
