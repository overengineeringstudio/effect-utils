# 0001 Buck Artifact With Nix Import

Status: accepted

## Context

The build-system direction assigns fine-grained repo-local actions and caching
to Buck2 while preserving Nix, Home Manager, NixOS, and nix-darwin as system
composition, activation, verification, and rollback authority. The remaining
authority question was whether Nix should rebuild deployable repo artifacts
from source or verify and import Buck-produced artifacts.

## Evidence and Argument

- The user selected the Buck-export/Nix-import option in q1 on 2026-08-11 and
  reiterated that the system must maximize cache precision and observability.
- Buck's configured action graph and remote-execution protocol content-address
  declared commands and inputs. Nix's store and binary cache use a different
  identity and distribution protocol, so their cache entries cannot be treated
  as interchangeable.
- Current effect-utils Nix packaging proves the system-composition boundary but
  recompiles repo artifacts independently from any future Buck cache.
- The local pnpm adapter experiment rejected an ambient mutable dependency
  bridge before artifact admission. A deployable handoff therefore needs a
  normalized artifact, provenance, digest, and platform identity rather than a
  path into live developer state.

## Options

| Option                                    | Tradeoffs                                                                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Buck artifact, Nix fixed-output import | Reuses the fine-grained Buck build and gives one compiler/bundler authority; requires publication, provenance, relocatability, platform identity, and freshness contracts. |
| B. Independent Nix source rebuild         | Preserves today's direct source-to-closure model but permanently duplicates build graphs, compilation, caches, and equivalence verification.                               |

## Decision

Choose A as the steady state for migrated repo artifacts.

Buck2 is the compiler and bundler authority for each migrated repo artifact. It
must emit a normalized per-platform artifact with a content digest, provenance,
toolchain identity, and enough evidence to reproduce and explain its action
closure. Nix verifies and imports that immutable artifact, adds runtime and
system dependencies and wrappers, and owns system or user convergence.

Source-based Nix builders remain temporary shadow fallbacks during migration.
They may be removed per artifact only after output/behavior equivalence,
relocatability, failed-digest, unavailable-artifact, activation, verification,
and rollback controls pass.

## Consequences

- A normal Nix or Home Manager build must not invoke a live Buck daemon or build
  from a mutable checkout during activation.
- Dirty local iteration needs a separate narrow development activation path and
  cannot claim to be a reproducible Nix generation.
- Buck and Nix cache metrics remain separate. The artifact digest and provenance
  record are the explicit bridge between their identities.
- Artifact publication becomes an input to Nix convergence. Unavailable or
  mismatched artifacts fail closed rather than triggering an undeclared rebuild.
- Fine-grained target/code generation and observability requirements apply
  upstream of the published artifact so a digest is explainable, not merely
  reproducible by accident.
