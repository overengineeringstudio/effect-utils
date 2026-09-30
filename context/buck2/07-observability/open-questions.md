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
- **buck2-tools Rust rewrite (q17):** the full rewrite was stopped after
  slice 1 on 2026-09-30 following a rebaseline; #1394 was closed as not
  planned. Further ports are parked and trigger-based in
  [issue #1522](https://github.com/overengineeringstudio/effect-utils/issues/1522);
  see the [rebaseline experiment](../.experiments/2026-09-30-buck2-tools-rust-rebaseline.md)
  for evidence and reopen triggers.
- **Findings for other owners (q8):** serial `tsgo_emit` chain and 8-slot
  contention ([02-execution](../02-execution/open-questions.md)), uncached
  editor bootstrap and the publish tail
  ([03-materialization](../03-materialization/open-questions.md)), cache
  service upload/materialization latency
  ([04-reuse](../04-reuse/open-questions.md)). Recorded there; this lane owns
  only their measurement.
