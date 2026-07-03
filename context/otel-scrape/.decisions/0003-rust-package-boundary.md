# 0003 — Dedicated Rust package boundary

**Status:** Accepted.

**Context:** `otel-scrape` is a process wrapper whose correctness depends on subprocess lifecycle, signal handling, passthrough I/O, context propagation, and platform-specific process-tree observation. The existing repository precedent for this kind of command-line infrastructure is `packages/@overeng/otelite`: a standalone Rust package with `rustPlatform.buildRustPackage`, flake package/app outputs, and devenv integration.

**Decision:** Implement `otel-scrape` as a dedicated Rust package under `packages/@overeng/otel-scrape`, producing a CLI binary named `otel-scrape`.

The package is a sibling of `packages/@overeng/otelite`, not an entry inside `@overeng/utils` or `@overeng/utils-dev`.

**Consequences:**

- Process lifecycle, passthrough I/O, signal handling, and process-tree fidelity live in a runtime with direct OS APIs.
- Nix/devenv integration follows the `otelite` pattern: committed Cargo metadata, package-local `nix/build.nix`, flake package/app outputs, and local checks wired through the repo's quality gates.
- TypeScript packages remain the source of public telemetry and content-addressing contracts where they already own them; Rust must conform to the same semantic conventions rather than inventing a second schema.
- Any cross-language contract surface needed by Rust and TypeScript must be generated or explicitly mirrored from the VRS/contract owner before broad adapter expansion.
