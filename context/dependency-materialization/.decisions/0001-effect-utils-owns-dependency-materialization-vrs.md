# 0001: effect-utils owns dependency materialization VRS

## Decision

effect-utils owns the reusable dependency materialization VRS hierarchy. The
canonical docs live under `context/dependency-materialization/` and cover live
pnpm materialization, projection, Nix prepared dependencies, store authority,
Buck2 evidence, and producer observability.

dotfiles keeps fleet orchestration, local runner policy, and repo-alignment
guidance. It does not keep parallel VRS roots for reusable pnpm/Nix dependency
contracts.

## Rationale

The implementation and reusable public API live in effect-utils. Keeping the
VRS in dotfiles would make private orchestration policy the source of truth for
public dependency tooling and would leave downstream repos with two competing
contracts.

The hierarchy also matches the system shape better than two flat documents:
one root contract defines identity and authority vocabulary, while child VRS
nodes refine each realization.

## Consequences

- effect-utils specs must stay current with implementation changes to pnpm
  task helpers and Nix prepared-deps builders.
- dotfiles docs may reference the effect-utils-owned contract, but must not
  redefine it.
- New dependency materialization mechanisms enter as child VRS nodes
  only when they refine the shared DMP profile and authority model.
