# Portable Product Contract Spec

This document specifies portable product descriptors. It builds on
[requirements.md](./requirements.md).

## Status

Active.

## Scope

Owns byte, compatibility, and semantic provenance binding.
[Nix import](../02-nix-bridge/spec.md) independently validates this contract.

## Descriptor

```json
{
  "schema": "buck-build-product/v1",
  "name": "fixture-tool",
  "entrypoints": ["bin/fixture-tool"],
  "payload": {
    "file": "artifact.tar",
    "format": "tar",
    "sizeBytes": 123,
    "digest": { "algorithm": "sha256", "sri": "sha256-...=" }
  },
  "platform": { "os": "linux", "architecture": "x86_64", "abi": "musl" },
  "runtime": { "kind": "self-contained", "inspectionContract": "elf-static/v1" },
  "semanticProvenance": {
    "target": "//fixtures:tool",
    "recipe": "fixture-tool/v1",
    "toolchain": "rust-linux-musl/v1"
  }
}
```

Every object uses exact fields. Descriptor identity is SHA-256 over canonical
JSON. Entry points and payload paths are normalized safe relative paths.
Runtime is a tagged union whose fields and inspection contract depend on
`kind`; acceptance of a descriptor kind does not imply an importer exists for
it.

### Darwin App Bundles

```text
Swift sources + declared compiler/SDK
  -> Mach-O executables + bundle resources
  -> artifact.tar + buck-build-product/v1 descriptor
  -> independent per-executable Mach-O inspection
```

`mach-o-app-bundle` selects `mach-o-app-bundle/v1` on Darwin. Its exact
runtime fields are `kind`, `inspectionContract`, `bundleRoot`, `mainExecutable`,
`executables`, `installNamePolicy`, and `rpathPolicy`. `executables` is sorted
by unique safe `path`; each entry carries exactly `path`, `architecture`,
`dylibs`, `minimumOs`, and `signingPolicy`, observed from the executable.
Entry points equal those paths; every path is inside `bundleRoot`, and
`mainExecutable` names one of them. Architecture agrees with the product
platform. `system-only/v1` install names and `empty/v1` RPATH policy reuse
the native Mach-O contract.

The deterministic tar preserves executable modes and includes
`Contents/Info.plist`, declared resources, and the optional build stamp at
`Contents/Resources/nix-build-stamp.json` beneath the bundle root. Import
checks each executable through the canonical Mach-O inspector without
rewriting the payload. Mutable application installation or signing is not
part of the product.

### Raw Wasm Guests

Raw wasm guests use `runtime.kind = "wasm-guest"` with
`inspectionContract = "wasm32-unknown-unknown/v1"`, the exact target triple,
a declared host `harness`, and sorted `module.name` imports. Their platform is
`{ os: "wasm", architecture: "wasm32", abi: "unknown" }`; it does not claim a
native host platform. `rust_wasm_guest` reuses the declared wasm Rust toolchain
without wasm-bindgen generation. Packaging validates the module and records
its imports; the Nix inspector validates the module and independently compares
imports with the descriptor. Each consumer proves its declared host harness.

## Namespace and Compatibility

`buck-build-product/v1` is the existing repository-owned schema identifier,
not a registered URI scheme. The schema string is exact and case-sensitive;
unknown versions fail closed. `runtime.kind` selects a runtime contract, not a
transport or trust tier. Adding an unsupported kind never permits fallback.
The sample above is interoperable only with an importer admitting its runtime;
unknown fields, absolute entrypoints, and `../` entrypoints are invalid.

## Requirement Trace

BUILD.DIST.PRODUCT-R01–R04 govern descriptor encoding, byte binding,
compatibility, and exclusion of live state.
