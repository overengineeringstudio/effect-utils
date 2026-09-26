# Buck2 Observability Open Questions

These are the lane's open design questions. Each links to the spec section or
child that owns it. Questions exit this file into the specs (as decisions) or
experiments (as tested hypotheses).

## OQ1: What does always-ingesting both views cost in Tempo? — open

- Blocks: production widening of ingest (05); the BUCK.OBS-T02 tradeoff.
- Decided (q24, 2026-09-25): ingest the critical view _and_ the full view as
  two identified traces for now — "dial in later if issues appear". The cost
  is unmeasured: ~67 k spans / ~61 MB OTLP JSON per full CI run, at ~90
  runs/day, stored 30 d.
- Measurement plan: when the ingest CLI lands, ingest a representative week of
  run records (cold + warm + fork shapes) into the Tempo instance and record
  object-store block growth, compactor behavior, trace-fetch and TraceQL
  latency at both view sizes, and querier stability. Compare against the
  critical-view-only baseline (~6 k spans/run). Report before any production
  widening; if growth exceeds the corridor budget (BUCK.OBS-R06), the dial-in
  options are: critical view only + on-demand full re-ingest (the q24
  recommended option), or a higher full-view cadence (e.g. failures only).

## OQ2: Will upstream accept daemon-wait attribution? — open, not gating

- The upstream dice-hook track (issue + ~200–350-line PR injecting an event
  hook at the shared-task await) is filed in parallel
  ([03-event-log-adapter decision 0003](./03-event-log-adapter/.decisions/0003-daemon-wait-at-ingest.md)).
  Acceptance odds are low-to-moderate with months of lag; the fleet design
  works without it. The busy-waiter blind spot (lane starvation on a busy
  command leaves no silent gap) is fixed only upstream. Revisit if upstream
  merges or if >10% of true waits sit on busy waiters.

## OQ3: When can direct OTLP become an optional fast path? — open, not gating

- Prerequisites (q18): `otel-span` must honor `OTEL_EXPORTER_OTLP_HEADERS`
  (today ignored — measured) and define a spool flush protocol. The sealed
  record remains the system of record; upload-enqueued ingest targets
  job-end→clickable ≤30 s p95 plus upload time without this fast path. Enable
  only after measuring whether it adds useful latency improvement without
  introducing a second correctness path.

## OQ4: When do the `ci.*` vendor keys migrate to OTel CICD attributes? — open

- The ontology (q19) adopts `cicd.pipeline.*`, `cicd.worker.*`, and `vcs.*`
  for local _and_ CI runs; today's `ci.*` keys (`ci.provider`,
  `ci.pr.fork`, and the run/job identity keys) and the `devenv.task.exec`
  naming predate that. Migration timing depends on the otel-scrape semconv
  pin (v1.37.0) catching up to the now-RC CICD set and on a coordinated
  rename across the spool, ingester, and dashboards. The build path must
  not carry two schemes indefinitely.

## OQ5: Evidence-namespace lifecycle details — resolved

- The fleet build-evidence trait owns the dedicated ZFS dataset and placement
  claim, one hardened `buck2-evidence` service with separate upload and
  read-only resolver Tailscale Services, a SQLite index/queue, ~one-year raw
  retention within ≤150 GiB/yr, and queue health. Upload is tailnet-only in
  V1; fork ingestion and its short-lived capability/revocation story are
  explicitly deferred rather than presumed implemented. Trace storage lasts
  30 days, and the archived raw record enables re-ingest. The dedicated
  namespace and service choice is recorded in
  [05](./05-ingest-and-archive/spec.md); the fleet realization lives in
  dotfiles `context/fleet/traits/build-evidence`.

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
- **Findings for other owners (q8):** serial `tsgo_emit` chain and 8-slot
  contention ([02-execution](../02-execution/open-questions.md)), uncached
  editor bootstrap and the publish tail
  ([03-materialization](../03-materialization/open-questions.md)), cache
  service upload/materialization latency
  ([04-reuse](../04-reuse/open-questions.md)). Recorded there; this lane owns
  only their measurement.
