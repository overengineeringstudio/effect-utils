# 0010 — macOS process observation exactness is Endpoint Security-gated

**Status:** Accepted.

**Context:** Phase 3 requires exact descendant process-tree evidence on supported release platforms before claiming release-grade process fidelity. macOS exposes useful direct-child process notifications through `kqueue`/`EVFILT_PROC`, but that API requires already-known process IDs and cannot reliably discover unknown short-lived descendants launched by package managers, shells, compilers, or test runners.

Endpoint Security can observe process events at the system boundary, but it has real product constraints: entitlement, installation/approval mechanics, event-loss handling, and validation on macOS ARM runner classes.

**Decision:** The first macOS backend remains `direct-child` and explicitly degraded unless an Endpoint Security-backed helper, or an equivalently exact mechanism, is available and validated.

`kqueue`/`EVFILT_PROC` may be used only for direct-child/degraded evidence. It must not be described as exact descendant process-tree support.

**Consequences:**

- macOS exact support is deferred until the helper installation, entitlement, approval, and event-loss model are designed and tested.
- Summary and OTLP output must keep macOS process evidence marked as degraded when only direct-child observation is available.
- The validation gate for exact macOS support is the same as Linux: a fixture that launches known descendants, including short-lived descendants, and proves observed parent/child links and exits without raw argv or path leakage.
- Release notes and support matrices must distinguish degraded direct-child process evidence from exact descendant process-tree spans.
