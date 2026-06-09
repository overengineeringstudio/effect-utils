# otelite — Requirements

Testable constraints for the local OTLP capture tool. See `vision.md` for why,
`spec.md` for how, `decisions/` for the trade-off rationale.

## Requirements

- **R01 — Capture.** Capture OTLP traces, metrics, and logs emitted by a child
  process to local files, one file per signal, as canonical OTLP/JSON
  (lossless), regardless of the wire encoding received.
- **R02 — Transports.** Accept OTLP/HTTP (`application/json` and
  `application/x-protobuf`) on one port and OTLP/gRPC on another — the common
  patterns the prod stack emits.
- **R03 — Run a child.** Spawn a child with the canonical `OTEL_*` env injected
  to point its emitter at the receiver; **preserve the child's exit code**;
  pass through caller-set `OTEL_*` except the endpoint/protocol it owns.
- **R04 — Coordination-free concurrency (first-class).** N independent agents
  must run otelite concurrently with no shared ports, files, locks, or registry,
  and no agreed convention between them. Validated to K=400 with zero
  bind failures, cross-contamination, or collisions.
- **R05 — Deterministic completeness.** Default to in-flight drain on child exit
  (0ms tax, full capture for emitters that await their ack); bounded
  `--drain-idle` opt-in for fire-and-forget; **never** wait unbounded. Persist
  each export (flush; `sync_all` on shutdown) **before** acking it.
- **R06 — Composable, agent-first CLI.** Machine-readable JSON on stdout
  (human/diagnostics + child stdout on stderr); `--pretty` opt-in; schema-tagged
  output locked by conformance goldens; `sysexits.h` exit codes for own
  failures; `inspect` reads dir|file|`-` and composes with `jq`.
- **R07 — Normalize, don't assert.** `inspect` produces normalized, filtered, or
  summarized views; assertions live in the test framework. No assertion DSL.
- **R08 — Nix-idiomatic packaging.** Ship as an effect-utils flake package +
  `nix run` app, reproducible, small enough that CI adoption is free.
- **R09 — Effect-native wrapper.** A typed Effect helper wraps the CLI via
  `@effect/platform` `Command` + `Schema`, with the CLI's JSON as the single
  source of truth.

## Assumptions

- **A01.** Emitters under test flush on shutdown / await their export ack — the
  regimes otelite optimizes for. Fire-and-forget is the exception, served by an
  explicit opt-in. An un-flushed span is treated as a SUT bug to surface.
- **A02.** Consumers want faithful canonical OTLP on disk; all denesting and
  analysis happens in `inspect`, not at capture time.
- **A03.** otelite owns the child env, so there is no port-discovery problem —
  ephemeral `:0` ports are sufficient and strictly best for isolation.
- **A04.** Public repo, used by private repos: no sensitive data in code or
  fixtures; redaction is the application's responsibility (non-goal here).

## Tradeoffs

- **T01.** Native receiver over collector-contrib: own ~424 LOC of receiver to
  gain ~60× smaller / ~20× faster / clean ephemeral-port read-back; accept owning
  OTLP decode (mitigated by official `opentelemetry-proto` crates). [0001, 0004,
  0008]
- **T02.** gRPC from day one pulls tokio+tonic (~94 crates / ~5 MB) for a path
  Effect tests don't currently emit — accepted for drop-in parity; still ~60×
  smaller than the collector. [0002]
- **T03.** Vendor the salvaged trace model into otelite rather than a shared
  lib — accept a later mechanical extraction to avoid freezing a public lib API
  before a second consumer exists. [0005]
- **T04.** CLI + Effect wrapper = two packages — accept a thin typed adapter over
  a stable JSON contract; the CLI stays the source of truth. [0007]
- **T05.** In-flight-drain default can drop fire-and-forget spans — accepted (it
  signals a SUT flush failure); bounded `--drain-idle` is the opt-in. [0006]

## Non-goals

Replace the Grafana/Tempo-mediated verification lane · replace the production collector
· dashboards or long-term storage · guarantee telemetry redaction.

## Resolved (was open)

- **DQ01 → `$TMPDIR/otelite-<random>`.** OS-cleaned, no gitignore, parallel-safe;
  the resolved `.out` is always echoed in the summary for discoverability.
- **DQ02 → `capture` is in v1.** The triad `run` / `inspect` / `capture` ships
  at v1 (capture = receiver-only, no child, serves until signal → summary).
  Folds into R06.
- **DQ03 → full metrics/logs `inspect` parity at v1.** All three signals get
  flat + filter + rich summary. Net-new work: the salvaged trace analysis is
  span-shaped, so metrics and logs need their own summarizers (see R10).

## Requirements (added)

- **R10 — Signal parity.** `inspect` supports traces, metrics, and logs with the
  same depth (flatten, filter, summarize). Trace summarize is salvaged; metric
  and log summarizers are authored fresh (no prior precedent) and held to the
  same conformance-golden discipline.
