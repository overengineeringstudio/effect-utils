# 0001: effect-utils owns dependency materialization VRS

Status: accepted

## Context

Reusable pnpm/Nix dependency tooling lives in effect-utils while its largest
fleet consumer and earlier research lived in dotfiles. Without one intent owner,
the same materialization behavior accumulated competing terminology, profiles,
and repair policies in both repositories.

## Evidence and Argument

The implementation and reusable public API live in effect-utils. Keeping the
VRS in dotfiles would make private orchestration policy the source of truth for
public dependency tooling and would leave downstream repos with two competing
contracts.

The hierarchy also matches the system shape better than two flat documents:
one root contract defines identity and authority vocabulary, while child VRS
nodes refine each realization.

## Options

| Option | Tradeoffs |
| --- | --- |
| effect-utils owns reusable DMP intent | Co-locates contract and implementation; downstream fleet docs must reference rather than restate it. |
| dotfiles owns DMP intent | Keeps the original research location but makes private orchestration authoritative for reusable tooling. |
| duplicate synchronized VRS roots | Local convenience at the cost of inevitable drift and ambiguous authority. |

## Decision

effect-utils owns the reusable dependency materialization VRS hierarchy. The
canonical docs live under `context/dependency-materialization/` and cover live
pnpm materialization, projection, Nix prepared dependencies, store authority,
Buck2 evidence, and producer observability.

dotfiles keeps fleet orchestration, local runner policy, and repo-alignment
guidance. It does not keep parallel VRS roots for reusable pnpm/Nix dependency
contracts.

## Consequences

- effect-utils specs must stay current with implementation changes to pnpm
  task helpers and Nix prepared-deps builders.
- dotfiles docs may reference the effect-utils-owned contract, but must not
  redefine it.
- New dependency materialization mechanisms enter as child VRS nodes
  only when they refine the shared DMP profile and authority model.
