# 0009 Admit the On-Demand Prelude CPython Bootstrap Boundary

Status: accepted

## Context

Prelude's Python action toolchain currently obtains a CPython live-origin tree
when a target uses Prelude Python rules. Buck does not need that tree merely to
parse and evaluate the repository's Starlark rules. Ignoring the on-demand input
because it is upstream, however, would still evade an executable dependency of
the affected actions. Fetching a mutable origin while constructing that
toolchain also places network and upstream state outside the declared
execution-platform contract.

## Evidence and Argument

The platform and helper experiments already established that every executable
input needs exact per-platform identity and that faster Rust replacements do not
earn admission without parity and bootstrap proof. The same reasoning applies
to Prelude's runtime tree: its bytes and interpreter closure affect every action
that consumes the Python toolchain. That makes it stage-0 execution-platform
input for those actions even though it is not a repository-authored helper.

Keeping an ambient or mutable live origin is simpler initially but prevents
reproducible offline analysis. Forking or rewriting Prelude immediately adds a
large independent maintenance surface without first proving system benefit. An
immutable Nix realization, with optional digest-addressed retrieval from
untrusted OCI storage, contracts the dependency without creating that fork or a
reverse dependency on the Buck-product importer.

## Options

| Option                                                      | Tradeoff                                                             | Outcome  |
| ----------------------------------------------------------- | -------------------------------------------------------------------- | -------- |
| Admitted Nix realization with optional OCI source transport | Declares the on-demand dependency while Python actions remain        | Accepted |
| Mutable upstream or ambient CPython live origin             | Minimal setup, but undeclared network/runtime state enters analysis  | Rejected |
| Immediate Prelude fork or Rust rewrite                      | Removes Python eventually, but adds unsupported bootstrap complexity | Rejected |

## Decision

While Prelude Python actions remain, treat their CPython live-origin closure as
stage-0 execution-platform input. Nix owns its reviewed source expectation,
recipe, runtime closure, per-platform realization, and exported descriptor.
Buck consumes only the exact verified descriptor and bytes. Nix may retrieve
the expected source by digest from self-hosted OCI storage, but that neutral
transport does not use the Buck-product importer or make registry state
authoritative. Repository-owned support tools converge separately to Rust;
once no declared Python action consumes the Prelude toolchain, remove this live
origin rather than preserving it as permanent foundation machinery.

## Consequences

- Python-toolchain actions can be reproduced without mutable upstream access.
- A Prelude-origin change invalidates only declared Python-toolchain consumers.
- The public contract states identities and verification, not private storage
  topology.
- Execution platforms do not acquire a reverse dependency on the Buck-to-Nix
  product bridge.
- Rust helper convergence does not require a Prelude fork: it deletes the
  repository-owned Python consumers and then the now-unused bootstrap boundary.
