# 0001 Exclusive Buck Authority with a Directional Nix Boundary

Status: accepted

## Context

Keeping Nix, package-manager tasks, and Buck as equivalent terminal build
authorities would preserve fallback comfort at the cost of drift, duplicated
work, and unexplainable cache invalidation.

## Evidence and Argument

The recorded repository census found 36 TypeScript package manifests and two
canonical Rust packages, while only two tools had real Buck builds. Exact-head
pilot measurements showed that a relevant Rust edit executed two actions and
that mtime-only and unrelated edits executed none. The same investigation found
that Nix still owns Home Manager or NixOS generations, runtime closures,
activation, and rollback; replacing that authority was neither prototyped nor
part of the repo-local caching problem.

Those facts support a directional boundary. Buck can own admitted repo-local
actions without duplicating Nix's system role. Permanent fallback build routes
would keep two dependency and producer graphs live, while deleting every
fallback before parity would outrun the available platform and activation
evidence. The accepted answer therefore combines exclusive terminal authority
with bounded proof before each transfer.

## Options

| Option                                         | Tradeoff                                                                                                  | Outcome                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Buck default with explicit fallback            | Easier incremental adoption, but named fallbacks can preserve a second producer indefinitely              | Rejected as the steady state |
| Buck exclusive for admitted repo-local actions | Smallest steady-state producer surface and strongest cache authority; requires gated, reversible cutovers | Accepted                     |
| Buck only for selected expensive targets       | Lowest migration cost, but preserves overlapping build authorities and their drift                        | Rejected                     |

## Decision

For each admitted semantic slice and platform, Buck is the sole terminal
authority for repository-local build, check, test, generation required by an
action, and packaging. Nix remains authoritative for tool recipes, system
runtime composition, verified import, activation, and rollback. Candidate proof
may coexist before admission; authority transfer and legacy-route deletion are
atomic.

## Consequences

- Nix-to-Buck tools and Buck-to-Nix products are directional contracts.
- Missing proof fails closed instead of selecting a hidden source-build path.
- Rollback restores a coherent prior authority state, not two live producers.
