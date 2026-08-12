# 0001 Exclusive Buck Authority with a Directional Nix Boundary

Status: accepted

## Context

Keeping Nix, package-manager tasks, and Buck as equivalent terminal build
authorities would preserve fallback comfort at the cost of drift, duplicated
work, and unexplainable cache invalidation.

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
