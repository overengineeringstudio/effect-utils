# otelite is effect-utils' first Rust package

otelite lives in effect-utils as `packages/@overeng/otelite`, making it the
first Rust crate in a repo that is otherwise TS/Bun/genie. It is exposed as both
a flake package and a `nix run` app so downstream repos (and the Effect/TS test
harness) consume it via Nix.

## Why

- The issue explicitly targets effect-utils; the tool is a general-purpose
  public test utility depending only on public OTel crates — nothing private.
- Aligns with "upstream into effect-utils" — starting in a downstream private
  workspace would force a later migration.
- An established `rustPlatform.buildRustPackage` pattern (`cargoLock.lockFile` +
  `fileset.toSource`) is a ready template to copy.

## Consequence (one-time bootstrap)

effect-utils gains a Rust lane: a rust toolchain in devenv, a
`rustPlatform.buildRustPackage` Nix build, and CI for `cargo build/test/clippy`.
This opens the repo to future small Rust tools. Genie emits a nix-only package
entry (no npm publish).

## Rejected

- **A downstream private Rust workspace**: zero bootstrap and sits beside
  existing shared OTel crates, but private — it would couple a public tool to
  private infra and contradict the alignment philosophy.
