# 0010 Admit Rust Stage-Zero Support Tools

Status: accepted

## Context

Decision 0003 accepted Rust as the convergence direction for repository-owned
action helpers but withheld admission until a candidate passed parity,
security, invalidation, platform, bootstrap, and contraction gates. The first
prototype failed those gates and introduced a second Cargo and lock authority.
The shared-workspace candidate instead uses the repository root Cargo workspace
and independently realized Nix providers.

## Evidence and Argument

The [shared-workspace contraction experiment](../.experiments/2026-08-12-shared-workspace-rust-foundation-contraction.md)
passed golden-output and failure parity, hostile archive controls, ambient
Python absence, leaf invalidation, non-cyclic Nix bootstrap, native Linux and
Darwin execution, performance, and deletion gates. It also removed the Python
helpers, their tests and targets, the live CPython archive, and the empty legacy
package. The earlier
[prototype rejection](../.experiments/2026-08-12-rust-helper-prototypes.md)
remains valid evidence about the rejected second-workspace architecture, not
about this candidate.

## Options

| Option                                                                          | Tradeoff                                                                                                   | Outcome                                |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Four Rust leaf tools in the root Cargo workspace, independently realized by Nix | Preserves narrow action invalidation and one dependency authority; repeats a small amount of binary wiring | Accepted                               |
| One multi-command Rust binary                                                   | Reduces realization count but couples unrelated action invalidation and transfer                           | Rejected without contrary measurements |
| Retain repository-owned Python helpers                                          | Avoids migration but preserves ambient runtime and larger closure costs after parity is proved             | Rejected                               |
| Build the bootstrap tools through the Buck graph they enable                    | Removes external realization but creates a stage-zero dependency cycle                                     | Rejected                               |

## Decision

Admit `buck2-archive-tool`, `buck2-closure-tool`,
`buck2-package-evidence`, and `buck2-product` as the repository-owned
stage-zero support tools for the admitted `x86_64-linux`, `aarch64-linux`, and
`aarch64-darwin` execution platforms. They are separate Rust leaf binaries in
the root Cargo workspace, share only identical validation semantics through
`buck2-tool-core`, and are independently realized by Nix from exact source and
lock inputs. Buck consumes their immutable capability providers; no action may
discover a Python or host fallback.

This decision supersedes decision 0003's conditional helper-convergence state
and the earlier prototype experiment's then-current rejection. It does not
supersede decision 0003's per-platform admission rule or decision 0009's
separate boundary for upstream Prelude Python actions.

## Consequences

- The removed repository Python helpers and CPython archive are not supported
  fallback paths.
- A leaf tool changes only the actions that consume its provider identity.
- The root Cargo manifests and lock remain dependency authority; a generated
  stage-zero closure may optimize realization only if it remains derived.
- A graph-built successor may replace a Nix stage-zero provider only after it
  proves the same contract without depending on itself.
