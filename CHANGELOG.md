# Changelog

## Unreleased

### Changed

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

Buck product imports, CLI wrappers, immutable dependency archives, shared build
identity, and live pnpm install policy and source-input algebra remain supported.
