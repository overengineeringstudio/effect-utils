# Changelog

## Unreleased

### Added

- Declared Darwin Swift app-bundle Buck products with deterministic bundle
  packaging and independent per-executable Mach-O inspection during Nix import.

### Fixed

- Swift source products select bundle-aware runtime inspection during Nix import.
- Build-product imports defer read-only directory permissions until all archive
  children have been extracted.
- TypeScript Buck projections resolve source labels through the nearest declared
  package boundary, including workspace manifests nested under the consuming package.
- The trusted fresh-root Buck2 cache proof reads the latest command's event log
  with zero-based history and checks the pinned release's numeric action and
  upload enums.

### Changed

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

Buck product imports, CLI wrappers, immutable dependency archives, shared build
identity, and live pnpm install policy and source-input algebra remain supported.
