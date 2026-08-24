# 0010 Select Buck2 As Repo-Local Build Authority

Status: accepted

## Context

DMP-R11 requires one declared authority for repo-local compilation, generation,
tests, bundles, and dependency/product artifacts. The repository needs one
hermetic graph rather than permanent overlapping pnpm, Nix, and task-runner
build graphs.

## Decision

Select Buck2 as the repo-local build authority. Buck2 actions own repo-local
compilation, generation, tests, bundles, and immutable dependency/product
artifacts for consumers in their declared scope.

Nix remains the authority for host tooling, activation, deployment, services,
secrets, and explicit system wrappers. Nix consumes declared immutable Buck2
artifacts at that boundary. pnpm remains a package-authoring and live-development
surface where required; it is not a second repo-local build authority.

The current implementation divergence and its exact resolution conditions are
tracked by
[DELTA-003](../.delta/DELTA-003-buck2-single-build-authority.md).

## Non-Goals

- Reproduce every existing pnpm or Nix adapter abstraction inside Buck2.
- Make Buck2 responsible for host activation, deployment, services, secrets, or
  system package management.
- Run Buck2 against a mutable checkout during Nix activation or deployment.
- Preserve a second build authority as a permanent fallback.

## Consequences

- Each Buck2 scope must name its consumers and artifact contracts explicitly.
- Nix/Buck integration is an immutable artifact handoff, not nested build
  orchestration.
- Temporary implementation overlap is tracked as a delta and removed when its
  scoped resolution signals hold.
