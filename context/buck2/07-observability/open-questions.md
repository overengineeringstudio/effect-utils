# Buck2 Observability Open Questions

These are the lane's open design questions. Each links to the spec section or
child that owns it. Questions exit this file into the specs (as decisions) or
experiments (as tested hypotheses).

## OQ1: What does delivering both views cost in Tempo? — open

- Blocks: production volume tuning of [05 OTLP delivery](./05-otlp-delivery/spec.md);
  the BUCK.OBS-T02 tradeoff.
- Both critical and full views are exported as separately identified traces
  (q24). A full CI run is ~67 k spans / ~61 MB OTLP JSON at the planning
  volume of ~90 runs/day; the critical view is ~6 k spans/run.
- Measure collector traffic, Tempo block growth, compaction, trace fetch,
  TraceQL latency and querier stability on representative cold, warm, and
  fork-shaped runs. If both views strain the 30-day corridor, compare critical
  view only or a lower full-view cadence. On-demand re-derivation is possible
  only while a local spool remains.

## OQ2: Will upstream accept daemon-wait attribution? — open, not gating

- The upstream dice-hook track (issue + ~200–350-line PR injecting an event
  hook at the shared-task await) is filed in parallel
  ([03-event-log-adapter decision 0003](./03-event-log-adapter/.decisions/0003-daemon-wait-at-ingest.md)).
  Acceptance odds are low-to-moderate with months of lag; the fleet design
  works without it. The busy-waiter blind spot (lane starvation on a busy
  command leaves no silent gap) is fixed only upstream. Revisit if upstream
  merges or if >10% of true waits sit on busy waiters.

## OQ3: How long must a local retry spool persist? — open, not gating

- [05 OTLP delivery](./05-otlp-delivery/spec.md) owns bounded retry after
  collector or tailnet failure. The retention/cleanup policy must be measured
  against outages: deleting the spool permanently removes the ability to
  regenerate or resend derived traces. It does not imply a raw archive.

## OQ4: When do the `ci.*` vendor keys migrate to OTel CICD attributes? — open

- The ontology (q19) adopts `cicd.pipeline.*`, `cicd.worker.*`, and `vcs.*`
  for local _and_ CI runs; today's `ci.*` keys (`ci.provider`,
  `ci.pr.fork`, and the run/job identity keys) and the `devenv.task.exec`
  naming predate that. Migration timing depends on the otel-scrape semconv
  pin (v1.37.0) catching up to the now-RC CICD set and on a coordinated
  rename across the spool, exporter, and dashboards. The build path must
  not carry two schemes indefinitely.
- Blocks: replacement of the remaining `ci.*` keys in
  [05 OTLP delivery](./05-otlp-delivery/spec.md) and downstream dashboards.
  The [roadmap](./roadmap.md) tracks the coordinated migration.

## OQ5: Collector access — resolved

- Same-repo PR jobs and main pushes export OTLP directly to dev3 Alloy on
  port 4318 after build work ends; local runs use the same path. The CI
  runner joins the tailnet immediately before export (#1477), with access
  controlled by a tailnet ACL grant. Fork jobs do not export; they leave a
  local spool. Dotfiles owns the collector grant and Tempo retention.

## OQ6: Adjacent work tracked elsewhere — not this lane's scope

- **CI-coupling audit (q15):** a read-only inventory of every CI-provider
  touchpoint in the generated CI workflow (essential / replaceable /
  accidental) and the target "CI = `devenv tasks run check:*` + environment"
  shape; filed as a separate epic. This lane already applies the principle
  (BUCK.OBS-R03).
- **buck2-tools Rust rewrite (q17):** decided as a full rewrite except the
  genie Buck2 generators — tracked in
  [issue #1394](https://github.com/overengineeringstudio/effect-utils/issues/1394)
  with the study's evidence; the event-log adapter crate lands in the same
  Rust workspace.
- The [roadmap](./roadmap.md) tracks the remaining rewrite slices; issue
  #1394 owns implementation scope rather than a design decision in this lane.
- **Findings for other owners (q8):** serial `tsgo_emit` chain and 8-slot
  contention ([02-execution](../02-execution/open-questions.md)), uncached
  editor bootstrap and the publish tail
  ([03-materialization](../03-materialization/open-questions.md)), cache
  service upload/materialization latency
  ([04-reuse](../04-reuse/open-questions.md)). Recorded there; this lane owns
  only their measurement.

## OQ7: How can task-level PR reads be isolated? — open, not gating

- Blocks: task duration, action critical path, and per-task seven-run baselines
  in [06 trace access](./06-trace-access/spec.md). The
  [roadmap](./roadmap.md) already records the separate Tempo buck2 tenant and
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
  The single job-end export burst mitigates the observed pattern; upstream
  resolution and a spaced-burst readback measurement would close the question.

## OQ9: Does Tempo 3.1 shut down cleanly after sustained uptime? — open

- Blocks: reliable switches that restart the Tempo service owned outside
  this lane. Tempo 3.0.3 can hang on SIGTERM after roughly an hour when
  live-store complete queues stop, causing a switch to fail and roll back.
  [grafana/tempo#7983](https://github.com/grafana/tempo/issues/7983) is
  closed with a fix in v3.1.0-rc.1; upgrade to 3.1 and re-measure shutdown
  and switch behavior after comparable uptime.

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
