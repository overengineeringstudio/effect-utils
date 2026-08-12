# 0003 One effect-utils Rust Resolution Domain

Status: accepted

## Context

`otelite` and `otel-scrape` currently have separate manifests and lockfiles but
share dependency requests, package policy, and update concerns. A native Cargo
workspace can compose those facts and select one topology. Whole-lock keying,
however, would make unrelated member changes invalidate otherwise unchanged
Buck or Nix work.

## Evidence and Argument

The native-workspace experiment preserved normalized member semantics, built
and packaged both members, and reduced warm metadata observation from a 42 ms
median for two standalone calls to 24 ms for one workspace call. Adding a
dependency reachable only from `otelite` changed the shared lockfile while the
`otel-scrape` reachable closure remained 33 nodes with the same digest.

The existing member-only Nix source shape failed after workspace inheritance
because it omitted the workspace root. This makes the Nix bridge a required
atomic part of the migration rather than follow-up cleanup.

## Options

| Option | Result | Tradeoff |
| --- | --- | --- |
| One effect-utils workspace and lock, gated by a closure-local Nix bridge | Selected | Maximizes native reuse while requiring a proved packaging bridge |
| Separate locks with shared validation policy | Rejected | Preserves current isolation but retains duplicate selected topology |

## Decision

Treat `otelite` and `otel-scrape` as one Cargo resolution and compatibility
domain. Use one native virtual workspace and one lockfile. Buck action identity
is the normalized reachable operation closure, not whole-lock bytes.

Land the shared lock through stock workspace-aware `buildRustPackage`, with each
package's source code narrowly filtered. Accept complete-lock vendoring as a
temporary coarse Nix system-packaging boundary: experiments proved stock Nix
cannot preserve package-local vendor identity after an unrelated lock change.
Do not build a handwritten projected-lock resolver. Buck retains normalized
reachable closures as its fine-grained action identity, and digest-pinned Buck
products are the intended long-term Nix input after portability admission.

## Consequences

- Cargo workspace composition and the stock Nix bridge migrate atomically.
- The repository gains one selected Rust topology without a generated manifest
  authority.
- Nix consumes the shared lock and required member manifests but must not use
  whole-repository source filtering.
- Coarse Nix invalidation is visible and benchmarked; it does not weaken Buck's
  closure-local identity or trigger a second resolver implementation.
