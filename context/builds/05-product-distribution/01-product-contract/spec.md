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
