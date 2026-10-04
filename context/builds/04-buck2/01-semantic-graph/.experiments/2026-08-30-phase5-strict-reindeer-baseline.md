# Phase 5 Strict Reindeer Baseline

## Question

What is the smallest fail-closed Cargo-to-Buck dependency graph that can precede the first real `otel-scrape` BuildProduct?

## Method

Ran nixpkgs-pinned Reindeer against the authoritative five-member `rust/Cargo.toml` and `rust/Cargo.lock` with `unresolved_fixup_error = true`, Cargo 1.95.0, rustc 1.95.0, no vendored output, and the stock Prelude Cargo macros. The probe used a disposable output directory and generated no committed graph. A first control with `include_top_level = true` was rejected because the workspace manifest is virtual; the dependency-only probe then ran with top-level targets disabled. A second control generated a Nix-store projection that changed only `workspace.members` to `otel-scrape`, copied the exact package manifest and authoritative lock, and supplied empty source placeholders for Cargo metadata. Reindeer invoked Cargo with `--locked` so the control could not mutate the projected lock.

## Result

Strict generation rejected 17 packages whose build-script policy is unresolved:

- `anyhow` 1.0.104
- `crc32fast` 1.5.0
- `getrandom` 0.4.3
- `httparse` 1.10.1
- `indexmap` 1.9.3
- `libc` 0.2.186
- `proc-macro2` 1.0.107
- `quote` 1.0.47
- `rustversion` 1.0.23
- `serde` 1.0.229
- `serde_core` 1.0.229
- `serde_json` 1.0.151
- `thiserror` 1.0.69
- `windows_x86_64_gnu` 0.52.6
- `windows_x86_64_msvc` 0.52.6
- `zerocopy` 0.8.56
- `zmij` 1.0.23

The virtual workspace caused Reindeer to resolve both product closures. This reproduces the earlier whole-workspace measurement instead of the intended 33-package `otel-scrape` slice. Reindeer cannot emit the first-party workspace targets from a virtual manifest, so those targets still require handwritten repository adapters after the selected third-party graph exists. The scoped projection built deterministically, but Cargo rejected it under `--locked`: changing workspace membership requires rewriting `Cargo.lock`. Without `--locked`, Cargo attempted to modify the Nix-store lock and failed read-only. The projection was removed rather than introducing a second lock identity.

## Conclusion

Do not disable strict fixup enforcement and do not admit the 224-package `otelite` closure merely to start `otel-scrape`. A members-only workspace projection cannot preserve the authoritative lock byte-for-byte. The next design boundary must therefore decide between a whole-workspace selected graph and an explicitly derived scoped lock whose identity and freshness remain tied to `rust/Cargo.lock`. Hand-authoring or silently updating a second lock is not admissible. After that boundary is decided, each reachable build script needs an explicit measured `run = true` or `run = false` fixup before the graph is admissible.

## VRS Impact

No requirement or decision changes. The result confirms decision 0017's bounded Cargo-manifest binding and the existing strict unresolved-fixup gate, but exposes an unresolved tension with Cargo's workspace-level lock semantics. Phase 5 cannot claim an `otel-scrape`-only selected topology until that lock-identity boundary is specified.
