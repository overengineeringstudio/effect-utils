# 0011 - Linux exact process observation starts as opt-in ptrace

**Status:** Accepted.

**Context:** Exact descendant process-tree evidence requires observing process
creation, exec, and exit events instead of sampling `/proc` after the fact.
Linux exposes those lifecycle events through `ptrace` for a traced child tree,
including short-lived descendants. `ptrace` also changes process execution
semantics enough that it should not silently become the default backend for
build and development commands.

**Decision:** `otel-scrape` supports an explicit Linux-only
`ptrace-experimental` process backend. The default backend remains
`direct-child`.

`ptrace-experimental` may emit `fidelity = "exact"` only when validation proves
the observed process DAG, including immediate-exit descendants and nested
descendants. The backend name stays experimental until perturbation, privilege,
namespace, and operational behavior are validated beyond the fixture.

**Consequences:**

- Linux can prove exact descendant spans without introducing a privileged helper
  in the first slice.
- Users must opt in through `--process-backend ptrace-experimental` or
  `OTEL_SCRAPE_PROCESS_BACKEND=ptrace-experimental`.
- Unsupported platforms and default runs remain explicitly degraded/direct-child
  unless an exact backend is selected and validated.
- A future default Linux backend decision must consider ptrace perturbation
  against helper-based mechanisms such as eBPF or process connector style event
  sources.
