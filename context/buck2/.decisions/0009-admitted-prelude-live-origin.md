# 0009 Admit the Prelude Live-Origin Bootstrap Boundary

Status: accepted

## Context

Prelude currently requires a CPython live-origin tree while Buck loads its rule
implementation. Ignoring that input because it is upstream or replacing Python
solely for language purity would both evade the actual bootstrap dependency.
Fetching a mutable origin during analysis would also place network and upstream
state outside the declared execution-platform contract.

## Evidence and Argument

The platform and helper experiments already established that every executable
input needs exact per-platform identity and that faster Rust replacements do not
earn admission without parity and bootstrap proof. The same reasoning applies
to Prelude's runtime tree: its bytes and interpreter closure affect rule loading
before ordinary actions exist. That makes it stage-0 input even if it is not a
repository-authored helper.

Keeping an ambient or mutable live origin is simpler initially but prevents
reproducible offline analysis. Forking or rewriting Prelude immediately adds a
large independent maintenance surface without first proving system benefit. An
immutable Nix realization, with optional digest-addressed retrieval from
untrusted OCI storage, contracts the dependency without creating that fork or a
reverse dependency on the Buck-product importer.

## Options

| Option                                                     | Tradeoff                                                                    | Outcome  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- | -------- |
| Admitted Nix realization with optional OCI source transport | Declares the real dependency and preserves upstream Prelude                 | Accepted |
| Mutable upstream or ambient CPython live origin             | Minimal setup, but undeclared network/runtime state enters analysis         | Rejected |
| Immediate Prelude fork or Rust rewrite                      | Removes Python eventually, but adds unsupported bootstrap complexity        | Rejected |

## Decision

Treat Prelude's CPython live-origin closure as stage-0 execution-platform input.
Nix owns its reviewed source expectation, recipe, runtime closure, per-platform
realization, and exported descriptor. Buck consumes only the exact verified
descriptor and bytes. Nix may retrieve the expected source by digest from
self-hosted OCI storage, but that neutral transport does not use the
Buck-product importer or make registry state authoritative. Removal or
replacement remains a separate measured delta.

## Consequences

- Rule loading can be reproduced without mutable upstream access.
- A Prelude-origin change invalidates only rule-loading and declared consumers.
- The public contract states identities and verification, not private storage
  topology.
- Execution platforms do not acquire a reverse dependency on the Buck-to-Nix
  product bridge.
- Python removal does not block initial Buck adoption, but undeclared Python is
  no longer accepted as harmless bootstrap state.
