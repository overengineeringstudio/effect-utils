# 0003 Per-Platform Proof and Measured Rust Convergence

Status: accepted; the conditional repository-helper conclusion is superseded
by [decision 0010](./0010-admit-rust-stage-zero-support-tools.md)

## Context

Build authority, cache reuse, and remote execution are platform-specific.
Prototype Rust replacements for current Python helpers demonstrated feasibility
and startup gains but did not satisfy parity, portability, or complexity gates.
The later shared root Cargo workspace removed the prototype's second-lock
authority objection. At the time of this decision it did not by itself prove
behavioral parity or earn replacement admission.

## Evidence and Argument

The platform investigation established that the authority-grade pilot covered
only x86_64-linux and that a wrong-architecture Nix tool can pass Buck analysis
before failing at execution. This rules out treating a declared platform matrix
as proof and supports admission per target/execution-platform tuple.

The retained Rust helper experiment
([evidence](../.experiments/2026-08-12-rust-helper-prototypes.md)) found a
byte-identical hybrid packager sample at 30.716 ms versus 44.149 ms for Python,
and tiny Rust executors around 1.4 ms versus 61.7 ms for the sampled Python
process. It also found that the candidates added a second Cargo/lock authority,
lacked parity and multi-platform proof, or increased the implementation surface.
Startup speed alone therefore does not justify admission. Stable semantic and
tool-binding contracts must precede any executor-language replacement.

## Options

| Dimension          | Option                                              | Tradeoff                                                                                        | Outcome                      |
| ------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------- |
| Platform admission | Per target/execution-platform tuple                 | Mixed rollout is explicit, but each proven platform can converge independently                  | Accepted                     |
| Platform admission | All platforms atomically                            | Simpler support statement, but retains dual authority until the slowest platform is ready       | Rejected                     |
| Helper convergence | Fine-grained Rust after contraction and foundations | Ends with native, isolated action executors without admitting the failed prototype architecture | Accepted                     |
| Helper convergence | TypeScript/Rust hybrid                              | Lower foundation cost, but retains two repository action-helper ecosystems                      | Rejected as the target state |
| Helper convergence | Keep irreducible Python                             | Lowest immediate risk, but retains the complexity the convergence is intended to remove         | Rejected as the target state |

## Decision

Admit authority independently for each target/execution-platform tuple with
deterministic proof and immediate legacy retirement for the exact slice. Keep
Python removal as a measured implementation delta, not a language-purity rule.
Converge repository-owned action executors toward separate Rust binaries only
after the semantic graph and canonical tool-binding foundation exist and the
replacement wins parity, invalidation, portability, and complexity gates.
External workflow orchestration remains TypeScript; Prelude Python is a
separate on-demand toolchain boundary. Rust convergence removes the
repository-owned consumers first; deleting the unused Prelude CPython bootstrap
does not require an immediate Prelude fork.

## Consequences

- Declared platform vocabulary does not imply platform support.
- Small independent helpers preserve leaf-level invalidation unless benchmarks
  justify a shared binary.
- A faster prototype is not admitted when it adds another lockfile, bootstrap
  cycle, duplicated schema, or unsupported platform claim.
- The shared workspace reopened the Rust candidate under one Cargo authority.
  The follow-up experiment subsequently passed the parity, adversarial,
  invalidation, platform, and deletion gates and is admitted by decision 0010.
