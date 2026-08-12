# 0003 Per-Platform Proof and Measured Rust Convergence

Status: accepted

## Context

Build authority, cache reuse, and remote execution are platform-specific.
Prototype Rust replacements for current Python helpers demonstrated feasibility
and startup gains but did not satisfy parity, portability, or complexity gates.

## Decision

Admit authority independently for each target/execution-platform tuple with
deterministic proof and immediate legacy retirement for the exact slice. Keep
Python removal as a measured implementation delta, not a language-purity rule.
Converge repository-owned action executors toward separate Rust binaries only
after the semantic graph and canonical tool-binding foundation exist and the
replacement wins parity, invalidation, portability, and complexity gates.
External workflow orchestration remains TypeScript; Prelude Python is a
separate upstream or overlay decision.

## Consequences

- Declared platform vocabulary does not imply platform support.
- Small independent helpers preserve leaf-level invalidation unless benchmarks
  justify a shared binary.
- A faster prototype is not admitted when it adds another lockfile, bootstrap
  cycle, duplicated schema, or unsupported platform claim.
