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
- **A03.** For `run`, otelite owns the child env, so there is no port-discovery
  problem — ephemeral `:0` ports are sufficient and strictly best for isolation.
  The in-process `capture` path (the emitter is the *parent*, not a child otelite
  spawns) does not have that luxury; discovery is resolved by the
  `otelite.endpoints/v1` stdout event (R12), so ports stay ephemeral — not fixed —
  and parallelism (R04) is preserved. See [0014].
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
- **T06.** `capture` stdout becomes a tagged event stream (endpoints line, then
  summary line) instead of a single summary line — accept the contract change (and
  the test/golden update) to give in-process parents scrape-free ephemeral-endpoint
  discovery on the channel they already read. Rejected a side-file (a second
  discovery mechanism + existence/atomicity polling) and a stdin command channel
  (no gain given write-before-ack). `run` stays one line. [0014]

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
- **R11 — Trace-derived metrics (spanmetrics).** `inspect --signal traces
--derive-metrics` projects captured spans into RED metrics, emitting
  `otelite.metric/v1` rows (so they flow through the same filters/`--summary` as
  native metrics). Faithful to the collector-contrib spanmetrics connector:
  metrics `calls` (monotonic delta sum) and `duration` (delta histogram, unit
  `ms`, default bounds `2,4,6,8,10,50,100,200,400,800,1000,1400,2000,5000,
10000,15000`); default dimensions `service.name`, `span.name`, `span.kind`,
  `status.code`; enums encoded as proto strings (`SPAN_KIND_SERVER`,
  `STATUS_CODE_ERROR`, …); errors counted via `status.code = STATUS_CODE_ERROR`.
  The derivation reads the raw capture (integer `kind`/`status`), not the flat
  `otelite.span/v1` rows. Held to the same conformance-golden discipline as R10.
- **R12 — Machine-first `capture` contract.** `capture`'s stdout is a tagged
  NDJSON event stream: an `otelite.endpoints/v1` line (`http`/`grpc`/`out`)
  emitted the instant both listeners bind, then `otelite.summary/v1` as the final
  line — so a *parent* process (not a child otelite spawns) learns the ephemeral
  endpoint by dispatching on `schema`, with no string/regex scraping, from any
  language. The receiver stops on SIGINT/SIGTERM **or** stdin EOF (a non-TTY
  parent closes the child's stdin — no signal/PID plumbing). `run`'s one-line
  summary contract and `run | inspect -` are unchanged. [0014]
- **R13 — In-process capture for test assertions.** The Effect wrapper exposes a
  scoped `capture` that boots a receiver, yields its endpoints to the *test
  process* for in-process emission, drains and stops on scope close, and inspects
  the capture as typed rows — the shared primitive for harness-level
  span/metric/log assertions, whether the spans come from a synthetic emitter or
  a real instrumented consumer. Child-based capture (a workload that *can* be a
  subprocess) is already covered by R03/R09; R13 is the in-process complement,
  built on the R12 contract. The end-to-end wire round-trip through the wrapper is
  proven for the child path; the scoped in-process `capture` is the next increment.
