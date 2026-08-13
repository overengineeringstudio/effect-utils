# Megarepo Product Prototype Evidence

Date: 2026-08-13

Target: `//packages/@overeng/megarepo:mr`

## Verified

- The repository-owned action helper is Rust; the product path adds no Python
  executable or Python source edge.
- Generated role closures recursively compose runtime workspace dependencies
  from the package Genie SSOT and project references from the tsconfig Genie
  SSOT. The same tsconfig facets derive every project file set, including
  `tui-react` tests and examples. One shared workspace registry pairs both
  facets, so package names are not maintained in independent generators;
  unknown first-party edges fail generation. No generator reads ambient
  `node_modules` or hashes whole lockfiles.
- Workspace filegroups are expanded to individual source artifacts with stable
  staging prefixes. The `mr` product has no edge to the typecheck marker;
  `mr_quality` is the explicit aggregate that joins both sibling targets.
- Git revision, commit timestamp, dirty state, invocation ID, and action
  evidence do not enter the executable bytes or semantic descriptor.
- `buck2-typescript-product` unit tests, Cargo check, and Clippy with warnings
  denied passed; the generated-file check reported 103 of 103 files current.

## No Verdict

- The host had approximately 41 GB free, below the 200 GB heavy-build policy
  floor, so no new Nix realization, full Buck product build, runtime smoke,
  invalidation run, or benchmark was admitted.
- Buck target analysis and dependency queries passed after starting the pinned
  Watchman. They prove `mr_quality` joins `mr`, `typecheck`, and the recursive
  project closure. The E2E task builds that aggregate and includes an actual
  included-test-file type-error RED/GREEN control before import, then asserts
  independent platform, payload-digest, and observed-runtime RED seams. The
  full product action and these executable controls were not executed.
- The benchmark distinguishes two formerly conflated boundaries. A
  role-excluded test mutation must execute zero product actions. A dedicated
  production-declared but entrypoint-unreachable source mutation must execute
  at least one action, explicitly exposing the current package-level closure as
  coarse. Relevant entrypoint-reachable mutations must also execute at least
  one action; warm and mtime-only observations must execute zero. No benchmark
  was admitted on this host, and the package-level production boundary remains
  unadmitted rather than being mislabeled dependency-closure granularity.
- The emitted strict `buck-build-product/v1` descriptor has an implemented Nix
  import path. Its `elf-dynamic/v1` runtime inspector validates loader,
  dependency, symbol-version, runpath, and store-reference facts against the
  descriptor. Execution of that path remains no-verdict on this host.
