# Buck2 Observability Open Questions

These are the lane's open design questions. Each links to the spec section or
child that owns it. Questions exit this file into the specs (as decisions) or
experiments (as tested hypotheses).

## OQ1: What does delivering both views cost in the selected backend? — open

- Blocks: production volume tuning of [05 OTLP delivery](./05-otlp-delivery/spec.md);
  the BUILD.BUCK.OBS-T02 tradeoff.
- Both critical and full views are exported as separately identified traces
  (q24). A measured full CI run is ~67 k spans / ~61 MB OTLP JSON;
  the critical view is ~6 k spans/run. Consumers supply sizing run volume.
- Measure collector traffic, selected-backend storage growth, compaction, trace
  fetch/query latency and stability on representative cold, warm, and
  fork-shaped runs. If both views strain consumer-selected retention, compare critical
  view only or a lower full-view cadence. On-demand re-derivation is possible
  only while a local spool remains.

## OQ2: Will upstream accept daemon-wait attribution? — open, not gating

- The upstream dice-hook track (issue + ~200–350-line PR injecting an event
  hook at the shared-task await) is filed in parallel
  ([03-event-log-adapter decision 0003](./03-event-log-adapter/.decisions/0003-daemon-wait-at-ingest.md)).
  Acceptance odds are low-to-moderate with months of lag; the producer design
  works without it. The busy-waiter blind spot (lane starvation on a busy
  command leaves no silent gap) is fixed only upstream. Revisit if upstream
  merges or if >10% of true waits sit on busy waiters.

## OQ3: How long must a local retry spool persist? — open, not gating

- [05 OTLP delivery](./05-otlp-delivery/spec.md) owns bounded retry after
  collector or export-admission failure. The retention/cleanup policy must be measured
  against outages: deleting the spool permanently removes the ability to
  regenerate or resend derived traces. It does not imply a raw archive.

## OQ4: When do the `ci.*` vendor keys migrate to OTel CICD attributes? — resolved

- The lane uses the official v1.44.0 registry in one cutover, without dual
  emission: provider provenance is `vcs.provider.name`, the job outcome is
  `cicd.pipeline.task.run.result`, and fork provenance is the repository-owned
  boolean `buck2.vcs.change.is_fork` because the CICD/VCS registry has no fork
  flag. [01 run identity](./01-run-identity/spec.md) defines the status mapping;
  [05 OTLP delivery](./05-otlp-delivery/spec.md) defines the attribute contract.
- No effect-utils consumer or dotfiles Grafana dashboard reads the removed
  keys. Trace links use trace IDs, so the cutover changes neither identity nor
  link calculation. Historical retained traces keep their original attributes.

## OQ5: Collector access — resolved

- Consumer-admitted same-repo PR jobs, main pushes and local runs export OTLP
  to the configured collector after build work ends. CI establishes any needed
  collector connectivity immediately before export (#1477). Forks and runs
  without collector access or admission retain a local spool without export.
  Consumer profiles own collector deployment, export admission and retention.

## OQ6: Adjacent work tracked elsewhere — not this lane's scope

- **CI-coupling audit (q15):** a read-only inventory of every CI-provider
  touchpoint in the generated CI workflow (essential / replaceable /
  accidental) and the target "CI = `devenv tasks run check:*` + environment"
  shape; filed as a separate epic. This lane already applies the principle
  (BUILD.BUCK.OBS-R03).
- **buck2-tools Rust rewrite (q17):** stopped after slice 1 (#1401).
  Existing TS support tools remain TS; further ports are parked and
  trigger-based in
  [issue #1522](https://github.com/overengineeringstudio/effect-utils/issues/1522),
  superseding the closed full-rewrite plan #1394. See the
  [rebaseline experiment](../../.experiments/2026-09-30-buck2-tools-rust-rebaseline.md)
  for measurements, tradeoffs and reopen triggers.
- **Findings for other owners (q8):** serial `tsgo_emit` chain and 8-slot
  contention ([02-execution](../05-execution/open-questions.md)), uncached
  editor bootstrap and the publish tail
  ([03-materialization](../04-materialization/open-questions.md)), cache
  service upload/materialization latency
  ([04-reuse](../06-reuse-client/open-questions.md)). Recorded there; this lane owns
  only their measurement.

## OQ7: How can task-level PR reads be isolated? — open, not gating

- Blocks: task duration, action critical path, and per-task seven-run baselines
  in [06 trace access](./06-trace-access/spec.md). The
  [roadmap](./roadmap.md) already records an isolated build-telemetry read scope and
  authenticated read proxy. Resolve the writer/Grafana cutover and proxy
  policy that binds CI identity to this repository's run/attempt and
  allowlisted aggregates, forbids arbitrary TraceQL and caller-supplied
  tenant headers, and measures complete matching task spans from seven
  successful main runs before changing the PR report.

## OQ8: Is Tempo readback complete across spaced bursts? — open upstream, not gating

- Blocks: relying on readback across spaced writes in
  [05 OTLP delivery](./05-otlp-delivery/spec.md). Tempo 3.0.3 can lose tail
  spans when bursts are read between writes
  ([grafana/tempo#8002](https://github.com/grafana/tempo/issues/8002)).
  The single job-end export burst mitigates the observed pattern.
- Live Tempo 3.1.0 measurement (2026-10-07T22:10–22:16Z): three independent
  traces, each replaying upstream's 2,013 + 2,023 + 2,219 spans in chunks
  of at most 1,000, with 20-second idle gaps. OTLP/HTTP used
  `service.name=o11y-oq8-probe` (outside `st` tail sampling); all pushes
  succeeded without OTLP partial success. Trace-by-ID and TraceQL search
  ran between bursts, with 27 additional by-ID reads per trace during the
  second gap (200 ms pauses between requests). No restart or configuration
  change was made.
- All three repeats returned 2,013/2,013 spans before burst 2,
  4,036/4,036 before burst 3, and 6,255/6,255 at 30 seconds, 2 minutes,
  and 5 minutes after the final burst. TraceQL found none of the three
  traces at the first inter-burst read, but found all three at the second
  inter-burst read and every final read. No by-ID span loss was observed
  in this bounded replay; early search visibility was incomplete.
- Upstream #8002 remains open. Keep this question open rather than treating
  complete by-ID counts in three synthetic traces as upstream resolution
  or a guarantee of immediate search visibility.

## OQ9: Does Tempo 3.1 shut down cleanly after sustained uptime? — open

- Blocks: reliable switches that restart the Tempo service owned outside
  this lane. Tempo 3.0.3 can hang on SIGTERM when live-store complete
  queues stop. The 2026-10-07 switch reproduced
  [grafana/tempo#7983](https://github.com/grafana/tempo/issues/7983):
  PID 2420410 started at 21:39:51Z and received SIGTERM at 22:05:01Z
  (~25 minutes uptime); at 22:05:31Z, `live_store_background.go:176`
  logged `failed to requeue block for flushing ... complete queues are stopped`.
  At 22:06:31Z, systemd logged `State 'stop-sigterm' timed out. Killing.`
  and sent SIGKILL after `TimeoutStopSec=90s`.
- Upstream #7983 is closed (2026-09-23), with the fix in v3.1.0-rc.1.
  Tempo 3.1.0 has been live since 2026-10-07T22:06:31Z, but its shutdown
  after at least one hour of uptime has not been measured. The deployer
  is asked to record stop duration and switch outcome at the next switch;
  this question stays open pending that measurement. Consumers selecting
  Tempo own upgrade evaluation and sustained-uptime shutdown verification.

## OQ10: What policy admits labeled forks to export? — open

- Blocks: extending the fork spool-only policy in
  [05 OTLP delivery](./05-otlp-delivery/spec.md). Resolve who can apply or
  remove the gating label, how the job verifies that decision without trusting
  fork-controlled input, and what network permission a labeled fork receives
  before allowing any collector export.

## OQ11: How can local hosts export by default? — open

- Blocks: default local export in
  [05 OTLP delivery](./05-otlp-delivery/spec.md). Local runs currently
  export only when `OTEL_EXPORTER_OTLP_ENDPOINT` is configured. Resolve
  endpoint discovery and safe behavior for hosts without collector access,
  without routing local telemetry to an unintended endpoint.
