# 0013 - Default exact process observation requires a helper boundary

Status: accepted

## Context

Linux `ptrace-experimental` proves that exact descendant process observation is
possible for a traced child tree, including short-lived descendants. It is still
a poor default for ordinary build and development commands because ptrace can
perturb execution, interacts with privileges and namespaces, and changes the
process relationship enough that default adoption would be a product decision,
not just an implementation detail.

Linux also exposes process lifecycle facts through helper-style mechanisms such
as eBPF tracepoints or connector-style event sources. Those mechanisms keep the
wrapped command less entangled with tracing, but they introduce helper
installation, privilege, event-loss, namespace, and correlation responsibilities.

## Evidence and Argument

Exact process observation must prove fork or equivalent process creation, exec
or equivalent command identity changes, and exit for every included descendant.
Snapshot polling cannot satisfy that contract because short-lived descendants
can start and exit between samples. Ptrace can satisfy the fixture, but the act
of tracing is itself a behavior change for the wrapped workload.

A helper-style backend moves the privileged observation boundary out of the
wrapped command path. That is the better long-term default if it can prove event
loss, namespace scoping, and run correlation. The same shape also matches the
macOS Endpoint Security direction.

## Options

| Option                                                                        | Consequence                                                                                                                |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Keep `direct-child` as default and require a helper for exact default support | Preserves transparency today and keeps exactness as an evidence-backed release claim.                                      |
| Make `ptrace-experimental` the default Linux exact backend                    | Proves process DAGs now, but silently introduces ptrace perturbation and privilege/namespace caveats into ordinary builds. |
| Add sampled `/proc` snapshots as exact support                                | Cheap to implement, but misses short-lived descendants and would redefine exactness downward.                              |

## Decision

The default backend remains `direct-child` until an exact backend can observe
descendant fork/exec/exit without perturbing the wrapped process. For Linux, the
preferred default-exact path is a separate privileged helper boundary that
streams lifecycle events to `otel-scrape`; `ptrace-experimental` remains an
opt-in validation and development backend.

The helper contract must prove:

- fork/clone, exec, and exit ordering for the wrapped process tree,
- event-loss detection and downgrade behavior,
- namespace/cgroup/session correlation rules that prevent cross-run leakage,
- least-privilege installation and activation mechanics,
- public-safe process identity hashing before events enter summaries or OTLP,
- validation with the same compiled process-DAG fixture used by the ptrace
  backend.

## Consequences

- `ptrace-experimental` can continue to harden the observation model without
  becoming the default release claim.
- Linux exact-by-default support is blocked on a helper design and validation
  evidence, not on sampling `/proc` snapshots.
- Sampled process snapshots may be added only as explicitly degraded diagnostic
  evidence, because they can miss short-lived descendants.
- macOS keeps the same shape through Endpoint Security or an equivalent exact
  helper.
