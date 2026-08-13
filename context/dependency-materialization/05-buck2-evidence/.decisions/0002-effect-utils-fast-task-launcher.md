# 0002 Effect Utils Fast Task Launcher

Status: accepted

## Context

Decision 0001 makes Buck the build authority for migrated repo artifacts while
Nix remains system authority. The repo-local hot path still needs a canonical
command that preserves Buck daemon latency and makes observability the default.

## Evidence and Argument

- Warm direct Buck no-op invocations measured 0.010-0.012 seconds in the local
  prototype.
- Invoking the same realized Buck through `nix shell` measured 0.470-0.562
  seconds.
- Warm `devenv tasks run ts:check --mode single` measured 16.700 and 16.723
  seconds, while direct whole-workspace compiler no-op invocations measured
  0.235-0.280 seconds.
- Devenv remains necessary for shell/bootstrap, setup, services, secrets, and
  system/deployment orchestration. Those concerns do not require placing fresh
  devenv evaluation in front of every Buck request.
- The user selected a thin launcher in q2 and constrained its first ownership
  boundary to effect-utils. A later move into a consumer repository should follow observed
  cross-repo reuse rather than precede it.

## Options

| Option                             | Tradeoffs                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A. Effect-utils fast task launcher | Provides one ergonomic, observable cross-target command without fresh environment evaluation; adds a small wrapper protocol.               |
| B. Direct Buck CLI                 | Minimizes implementation and exposes all Buck features, but leaves naming, evidence retention, tracing, and mixed workflows to convention. |

## Decision

Choose A and implement it in effect-utils first.

The launcher resolves human-facing task names or generated aliases to Buck
labels, invokes an already-realized pinned Buck binary directly, requests and
retains build reports and event evidence, correlates traces, and renders why an
action ran, was reused, or materialized. It must expose the exact underlying
Buck invocation and remain bypassable for diagnosis.

The launcher must not own package edges, source sets, action definitions,
execution policy, or another aggregate task DAG. Those remain generated Buck
targets and providers. Existing devenv task names may act as compatibility
delegates, while performance-sensitive users and CI use the fast launcher.

## Consequences

- A launcher benchmark includes startup, alias resolution, report persistence,
  and trace correlation, not only Buck execution.
- Wrapper/Buck parity tests cover target selection, arguments, environment,
  signals, exit status, stdout/stderr, and evidence paths.
- The initial launcher is repo-owned. Consumer-local or shared ownership is a later
  refactor only after at least one additional megarepo demonstrates the same
  stable contract.
- Devenv continues to own lifecycle/setup/system tasks and may expose
  compatibility aliases without becoming the performance-critical transport.

## Amendment 1: Immediate Shared Placement Remains Eligible

The initial effect-utils ownership is a default, not a prohibition. The
launcher may instead begin in a consumer repository or another shared surface when a current
comparison proves that placement materially improves dependency direction,
avoids a bootstrap cycle, reuses an existing task-system implementation,
protects the public/private boundary, or reduces rollout and release cost.

The comparison must use current source and measured or structurally provable
effects. Anticipated future reuse alone is insufficient. Regardless of
placement, effect-utils target semantics stay repo-owned and the launcher stays
free of private topology or policy data.

## Amendment 2: Ownership Comparison Result

The current comparison retains effect-utils as the generic implementation
owner and makes a downstream system repository an early consumer:

- consumers may already depend on effect-utils for shared Nix/devenv tooling,
  while effect-utils must not acquire a reverse dependency;
- effect-utils explicitly exports reusable helpers to downstream repositories;
- consumer-specific Home Manager selection, fleet policy, endpoints, target
  aliases, and activation remain consumer-owned;
- the second-repository adoption is the point where ownership should be
  reconsidered using measured maintenance and reuse evidence.

This result may be revisited if a prototype proves the launcher intrinsically
requires consumer-private fleet or activation semantics, or if the portable
effect-utils core proves to be a trivial pass-through with no reusable contract.
