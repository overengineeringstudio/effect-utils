# Experiment 0004 - macOS Endpoint Security feasibility

## Question

Should macOS ARM exact descendant process observation use Endpoint Security, or
an equivalently exact supported event source, rather than `kqueue`/`EVFILT_PROC`
or shell-level inference?

## Method

Ran read-only and temporary compile/probe checks on an Apple Silicon Darwin
runner environment:

- Confirmed the SDK exposes Endpoint Security headers and process lifecycle event types for fork, exec, and exit.
- Confirmed Endpoint Security messages expose per-client sequence counters that can be used to detect dropped events.
- Compiled an Endpoint Security header-only object probe.
- Built and ran a temporary unentitled Endpoint Security client probe through the Darwin ARM task runner using `-lEndpointSecurity`.
- Compiled and ran a `kqueue`/`EVFILT_PROC` probe that watched one direct child while that child forked a short-lived grandchild.
- Checked the Darwin task runner environment and captured its current process-observation fidelity.

## Result

- Endpoint Security is present as a C API, and the SDK documents entitlement and Full Disk Access/TCC approval requirements for `es_new_client`.
- Endpoint Security exposes `ES_EVENT_TYPE_NOTIFY_FORK`, `ES_EVENT_TYPE_NOTIFY_EXEC`, and `ES_EVENT_TYPE_NOTIFY_EXIT`, plus `seq_num` and `global_seq_num` fields for event-loss detection.
- The header-only Endpoint Security object probe compiled.
- A normal unentitled runner process can compile and link a minimal Endpoint Security client with `-lEndpointSecurity`, but `es_new_client` returns `ES_NEW_CLIENT_RESULT_ERR_NOT_PRIVILEGED`. This confirms that ordinary wrapper execution is not an exact macOS process-observation path.
- The `kqueue` probe observed only the direct watched child. It did not discover the short-lived grandchild without already knowing that grandchild PID, so it cannot satisfy exact unknown-descendant observation.
- The Darwin task runner's current process-observation sample is best-effort, not exact. CI/namespace-runner validation therefore proves the current degraded baseline and remains a separate gate for any future signed/entitled helper rollout.

Additional macOS ARM runner-class probes on 2026-06-30:

- A first runner probe completed on the macOS ARM runner class and reported a best-effort Darwin process-tree timeline. The temporary `kqueue` fixture again observed the watched direct child and did not prove unknown-grandchild discovery.
- A second probe found Endpoint Security headers through the runner toolchain, but plain C compilation failed on Objective-C block syntax.
- A third probe compiled the Endpoint Security include path successfully with `/usr/bin/clang -x objective-c -fblocks`.
- A fourth probe compiled and linked a minimal
  Objective-C Endpoint Security client on the macOS ARM runner class, then ran
  it as the ordinary task process. `es_new_client` returned
  `ES_NEW_CLIENT_RESULT_ERR_NOT_PRIVILEGED` and did not create a client.
- These runner probes validate SDK/toolchain availability and the degraded
  baseline. They also prove that ordinary wrapper/task execution is not a
  viable exact macOS backend. They do not validate entitlement, approval,
  event subscription, event-loss handling, or helper supervision.

## Conclusion

macOS exactness remains capability-gated. `kqueue`/`EVFILT_PROC` is suitable
only for degraded direct-child evidence. Endpoint Security remains the
principled candidate because it can observe fork/exec/exit and expose loss
counters, but exact support requires a dotfiles-owned signed/entitled helper
rollout with approval/install evidence and CI/runner-class validation. The
macOS ARM runner definitively rejects the unprivileged wrapper path through
`ES_NEW_CLIENT_RESULT_ERR_NOT_PRIVILEGED`, so there is no intermediate
unprivileged exact backend to pursue. Until the helper exists, macOS ARM support
must be documented as degraded.

## VRS Impact

- `requirements.md` treats release-grade exactness as platform/backend-specific.
- `spec.md` keeps macOS ARM degraded until Endpoint Security or an equivalent
  mechanism is validated on the runner class and target host class.
- `.decisions/0010-macos-process-observation.md` remains the owning macOS
  decision record.
