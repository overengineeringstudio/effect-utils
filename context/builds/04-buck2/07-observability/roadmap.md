# Buck2 Observability Roadmap

## Task-level PR report columns

The current [trace-access spec](./06-trace-access/spec.md) limits PR comments to
job facts from the GitHub Actions Jobs API. Task duration, action critical
path, and seven-run task baselines require an isolated build-telemetry read scope and
an authenticated read proxy restricted to this repository's run/attempt and
allowlisted aggregates. The proxy must bind CI identity and must not accept
arbitrary TraceQL or caller-supplied tenant headers. The consumer owns backend
writer/viewer routing and proxy access policy; this lane owns the report's
consumer contract. Revisit only after complete matching task spans from seven
successful main runs and safe read isolation have been measured
([decision 0004](.decisions/0004-tempo-only-delivery-and-job-report.md)).

## Tempo durability and lifecycle

- **Burst readback:** Tempo 3.0.3 can lose tail spans when spaced export bursts
  are read between writes ([grafana/tempo#8002](https://github.com/grafana/tempo/issues/8002)).
  The [single job-end export burst](./05-otlp-delivery/spec.md) avoids the
  observed pattern, but does not resolve the upstream bug. Keep the upstream
  issue open and validate readback across bursts before relying on it.
- **Shutdown after uptime:** Tempo 3.0.3 can hang on SIGTERM after roughly an
  hour of uptime when live-store complete queues stop. A switch that restarts
  Tempo then fails and rolls back. For consumers selecting Tempo, evaluate 3.1 and re-measure clean
  shutdown and switch behavior; the related
  [grafana/tempo#7983](https://github.com/grafana/tempo/issues/7983) is closed
  with a fix in v3.1.0-rc.1.

## Export admission and attributes

- **Forks:** Fork builds retain telemetry in the local spool without exporting
  it. Evaluate label-gated fork export before granting a fork access to the
  collector; the admission and trust boundary remain unresolved.
- **Local development:** Local runs export only with
  `OTEL_EXPORTER_OTLP_ENDPOINT` configured. Define safe endpoint discovery and
  failure behavior before making local-host export the default.

## Tool implementation

- Further `buck2-tools` Rust ports are parked after slice 1 (#1401), not
  scheduled as a full rewrite. Reopen only when a module needs a substantial
  rewrite or the Bun closure becomes a measured transfer/cache cost, as
  recorded in [effect-utils#1522](https://github.com/overengineeringstudio/effect-utils/issues/1522)
  and the [rebaseline experiment](../../.experiments/2026-09-30-buck2-tools-rust-rebaseline.md).
