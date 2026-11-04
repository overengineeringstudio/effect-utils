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
a declared host `harness`, sorted `module.name` imports, and required
`runtime.exports`: the complete export list of exact `{ name, kind }` objects
observed by `WebAssembly.Module.exports`, sorted by UTF-8 export name bytes.
Export names are unique; kinds are `function`, `table`, `memory`, `global`, or
`tag` (the exception-handling export kind supported by Node's WebAssembly API).
Both export names and kinds are bound into descriptor identity. Their platform
is `{ os: "wasm", architecture: "wasm32", abi: "unknown" }`; it does not claim a
native host platform. `rust_wasm_guest` reuses the declared wasm Rust toolchain
without wasm-bindgen generation. Packaging compiles the module once and records
its imports and exports; the Nix inspector independently compiles the module
and compares both complete lists with the descriptor. Missing, extra, renamed,
or differently typed exports fail admission. Each consumer proves its declared
host harness. The payload uses USTAR name/prefix fields without truncation;
paths that cannot fit their 100/155-byte UTF-8 limits fail before artifact output.

### Rust Compilation-Input Libraries

`buck-rust-library-product/v1` is a sibling exact schema, not an executable runtime (BUILD.DIST.PRODUCT-R01–R04):

```text
{
  schema: "buck-rust-library-product/v1", kind: "library", name,
  payload: { file: "artifact.tar", format: "tar", sizeBytes,
             digest: { algorithm: "sha256", sri } },
  platform: { os, architecture, abi },
  library: {
    language: "rust", crateName, primary: "lib/lib<crateName>.rlib",
    dependencyDirectory: "lib", targetTriple, hostTriple, panicStrategy,
    rustc: { compilerStorePath, verboseVersion, sysroot, darwinWrapperEvidence },
    artifacts: [{ path, role, sha256 }]
  },
  semanticProvenance: { target, recipe, toolchain }
}
```

All objects reject missing or unknown fields. `name` matches
`[A-Za-z0-9._+-]+`; provenance values are nonempty strings. `sizeBytes` is a
positive integer; `sri` is canonical padded RFC 4648 SHA-256 SRI. `crateName`
matches `[A-Za-z_][A-Za-z0-9_]*` and records the resolved Rust library target
name, not the product/package name. `panicStrategy` is `unwind` or `abort`.
The target platform is `x86_64` or `aarch64`, with `(os, abi)` equal to
`(linux, glibc)`, `(linux, musl)`, or `(darwin, darwin)`. The corresponding
target triple suffix is `unknown-linux-gnu`, `unknown-linux-musl`, or
`apple-darwin`. `hostTriple` independently uses one of those architectures
and suffixes; host proc macros are not target libraries.

Inventory paths are normalized safe relative paths directly under `lib/`,
without empty, dot, parent, backslash, or control-character components. Paths
are unique and strictly sorted by UTF-8 bytes. Each entry has exactly `path`,
`role`, and lowercase 64-hex `sha256`. Roles pair with extensions: `rlib`
with `.rlib`, `rmeta` with `.rmeta`, and `proc-macro` with `.so` on Linux
hosts or `.dylib` on Darwin hosts. The primary occurs exactly once with role
`rlib`; no second hashed primary alias is installed. Inventory names retain
producer disambiguators. The archive contains exactly the declared artifact
files (and their directory), preserving their bytes; native `.a`/`.o`,
build-script trees, and copied compiler sysroots are outside this schema.

`build_product(artifact = ...)` dispatches the tagged product provider. Library packaging consumes the adapter's normalized directory and compiler metadata, hashes every file, and reuses executable packaging's deterministic USTAR encoding without executable runtime inspection.

`compilerStorePath` is the sole authoritative compiler build identity: the
underlying rustc output store path, compared byte-for-byte with the consumer's
declared compiler output, never the Darwin wrapper. Both it and `sysroot`
are canonical absolute `/nix/store/<32-character Nix hash>-<output name>`
paths without subpaths. `sysroot` is captured from `rustc --print sysroot`,
resolved to its canonical path with the command's trailing newline removed.
`verboseVersion` captures the entire UTF-8 `rustc -vV` output: normalize CRLF
to LF, remove trailing LF bytes, then append exactly one LF; retain all
lines, including exactly one rustc banner, release, commit-hash, commit-date,
host, and LLVM version. Its host equals `hostTriple`. Consumers independently
capture and normalize the declared underlying compiler's evidence and compare
both `verboseVersion` and canonical `sysroot` exactly. These are consistency
evidence, not alternate identities or undefined content/closure hashes.
`darwinWrapperEvidence` is required: empty when absent, otherwise an absolute
store `bin/rustc` path on Darwin. It is provenance only and never compared
for compiler equality. Mismatches fail; no release-only or alternate-compiler
fallback is permitted.
The `package-library` command rejects malformed compiler evidence before emitting
the archive descriptor; it shares deterministic USTAR encoding with executable packaging.

Payload inspection independently verifies inventory, host macro architecture,
target library/compiler and effective panic compatibility; schema acceptance alone
does not prove usability. If target-cpu, ABI-changing target features, or custom
target specifications are admitted, their effective values must be bound into
a versioned descriptor before acceptance. The library schema has no `entrypoints`
or `runtime` fields; executable v1 bytes/readers remain unchanged and decode to the executable arm.

## Namespace and Compatibility

`buck-build-product/v1` and `buck-rust-library-product/v1` are repository-owned
schema identifiers, not registered URI schemes. Strings are exact and
case-sensitive; unknown versions fail closed. `schema` selects wire format;
library `kind` selects payload usability and must be `library`. A mismatched
schema/kind pair is invalid. Executable `runtime.kind` selects its runtime
contract, not a transport or trust tier. Unsupported kinds never permit fallback.
The sample above is interoperable only with an importer admitting its runtime;
unknown fields, absolute entrypoints, and `../` entrypoints are invalid.

## Requirement Trace

BUILD.DIST.PRODUCT-R01–R04 govern descriptor encoding, byte binding,
compatibility, and exclusion of live state.
