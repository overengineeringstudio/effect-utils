# Rust musl Platform Prototype

## Status

Completed on 2026-08-12 for `x86_64-linux`. This is platform and tool-delivery
evidence, not admission of `otel-scrape`, Cargo/Reindeer, remote execution, or
another architecture.

## Question

Can a Buck action consume a repository-pinned Nix Rust cross-toolchain while
separating its execution platform from a static-musl target and producing a
self-contained ELF without ambient `PATH`?

## Method

The prototype introduced distinct glibc-dynamic and musl-static target labels,
plus an x86_64 Linux local-store execution constraint and platform. Nix's
flake-pinned `pkgsCross.musl64` supplies the linker, while nixpkgs' matching
prebuilt musl Rust bootstrap archive supplies `rustc` and its target standard
library without rebuilding them from source on an uncached runner. Nix supplies
the exact tool store paths, semantic platform claims, and their joined identity
through one immutable Buck configuration. The action ran with
`PATH=/nonexistent`. The task retains a temporary Nix out-link for that config
through all three Buck invocations, so concurrent garbage collection cannot
invalidate the config or its transitive compiler and linker closure. Its
signal-safe cleanup removes the root after Buck has stopped.

The probe compiled one dependency-free Rust program. Controls inspected ELF
headers and strings, executed the binary with an empty environment, selected
the wrong glibc target, changed only source mtime, and changed source content.
Remote execution and remote caches remained disabled.

## Result

| Control                         | Result                                                   |
| ------------------------------- | -------------------------------------------------------- |
| First fresh-daemon build        | 0.900 s; one local action                                |
| Warm build                      | 0.142 s; zero actions                                    |
| Source mtime only               | 0.044 s; zero actions                                    |
| Relevant source content         | 0.579 s; one local action                                |
| glibc target for musl-only rule | rejected during analysis; musl constraint unsatisfied    |
| Prelude default exec platform   | rejected; exact local-store exec constraint unsatisfied  |
| Mismatched Nix target metadata  | rejected during toolchain analysis                       |
| Output                          | 488,064-byte x86-64 static PIE                           |
| Runtime dependencies            | no `PT_INTERP`, no `DT_NEEDED`, `ldd`: statically linked |
| Nix-store leakage               | no `/nix/store` string in the output                     |
| Empty-environment execution     | printed `buck2-rust-musl-ok`                             |

The measured output SHA-256 was
`502b79c30d8c92cb5cb6b970a5e4ef47fa8c852ef8f03afe88e366d1d2a2a098`.
The exact digest is evidence for this build, not a committed product pin.

## Design Findings

The existing portable-tool archive is not the right compiler delivery
mechanism: a Rust compiler is a large Nix closure that legitimately retains
store references. The smaller boundary is:

```text
flake-pinned Nix prebuilt musl rustc plus cross linker
  -> exact local-store execution-tool identities
  -> Buck compile/link action
  -> self-contained musl target product
```

The store paths participate in the action command and therefore its identity.
The Nix/devenv-owned projection emits those paths, the contract version,
execution platform, target platform, target triple, and their SHA-256 identity
atomically. Buck validates the semantic fields and separately requires the
selected execution and target constraints. `buck2:rust-musl:check` keeps the two
negative controls and real compile probe executable on x86_64 Linux. Buck
actions do not invoke Nix, and committed BUCK files do not pin ephemeral store
paths.

The target needs both ABI and linkage constraints. A `musl` constraint alone
does not establish static linkage. `static` versus `dynamic` is therefore an
independent target-platform dimension.

## No-Verdict Boundaries

- No aarch64 or Darwin compiler/product ran; cross-architecture support remains
  no-verdict.
- No remote worker consumed the Nix toolchain; delivery remains local-only.
- The probe has no third-party dependencies, proc macros, build scripts, Cargo
  profile semantics, or Reindeer graph.
- `env -i` plus ELF inspection proves absence of declared runtime dependencies,
  but this run did not execute inside a separate filesystem namespace.
- Independent rebuild reproducibility was not measured.

## Conclusion

The flake-pinned Nix musl toolchain reaches Buck through exact local-store
identities with correct invalidation (mtime-only edits run zero actions) and
fail-closed platform mismatches; the produced static PIE is self-contained
with no store leakage. Static-musl products are viable on x86_64 Linux;
cross-architecture, Darwin, and remote delivery remain no-verdict.

## VRS Impact

Confirms the existing one-way Nix-to-Buck local-store contract, independent
target/execution platforms, fail-closed compatibility, and a static-musl first
Rust product direction. Refines the platform vocabulary with an independent
runtime-linkage dimension. It does not change requirements or admit a product.
