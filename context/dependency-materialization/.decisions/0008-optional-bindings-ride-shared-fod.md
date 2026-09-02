# 0008 Optional Bindings Ride The Shared FOD Via Per-Root Opt-In

Status: accepted

## Context

Some install roots must carry platform native bindings (a bundler, a CSS
transformer) so a downstream cross-platform build can load them. Three shapes
were available: include optional bindings globally for every consumer, add a
separate binding-only FOD beside the prepared-deps FOD, or make binding
inclusion a per-install-root opt-in on the existing prepared-deps artifact.

## Evidence and Argument

- The shared prepared-deps FOD stays the single dependency boundary
  (`DMP.NIX-R05`). Bindings resolve from a family's own isolated `.pnpm` subtree,
  so they belong to that root's dependency data, not to a top-level graft.
- Host-invariance holds because inclusion is all-declared-triples: pnpm
  materializes the same union of platform bindings on any building host, so the
  shared hash stays sound (`DMP.NIX.FOD-R03`; see `0009`).
- The hash change is absorbed by the existing FOD hash-repair-target contract
  (`0005`), which already exposes the direct prepared-deps derivation as
  evaluated metadata and resolves through a nested-flake consumer boundary. No
  new repair surface is required.

## Options

| Option                                                    | Tradeoff                                                                                                                                              | Outcome  |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Per-install-root opt-in on the existing prepared-deps FOD | Keeps one dependency boundary and one hash class; requires an atomic opt-in plus hash refresh per root                                                | Accepted |
| Global-on for every consumer                              | Bloats every consumer's artifact with bindings it never loads and moves every hash                                                                    | Rejected |
| Separate binding-only FOD beside the prepared-deps FOD    | A rolldown/oxc/lightningcss version bump is a lockfile-driven change that _should_ move the prepared-deps hash; a parallel artifact adds a second boundary and hash class for no benefit | Rejected |

## Decision

Make optional binding inclusion a per-install-root opt-in (`DMP.NIX-R11`) that
materializes the bindings into the _existing_ prepared-deps FOD, gated by
all-declared-triples completeness (`0009`). Default off.

## Consequences

- Turning on inclusion for a root is a one-field change plus a hash refresh on
  that root; it must land atomically with the refreshed hash, because the hash
  change is not forward-compatible.
- The opt-in field is forward-compatible on un-repinned consumers: the entry
  validator ignores it until the consumer opts in.
- `nix-grafted` families keep using the top-level `nativeNodePackages` graft;
  this opt-in governs only `pure-package-artifact` families.
