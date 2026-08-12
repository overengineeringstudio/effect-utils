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

Do not land the shared lock migration until a workspace-aware Nix bridge proves
that each package source remains narrowly filtered and that an unrelated member
change does not alter the unaffected package closure identity.

## Consequences

- Cargo workspace composition and the Nix bridge migrate atomically.
- The repository gains one selected Rust topology without a generated manifest
  authority.
- Nix may consume workspace-level files but must not consume unrelated member
  sources or use whole-repository source filtering.
- A failed locality control blocks the migration and triggers bridge redesign;
  it does not silently weaken the cache boundary.
