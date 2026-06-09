# otelite — Spec

How otelite captures OTLP locally for tests. See `glossary.md` for terms and
`decisions/` for why. Status: in design (issue
overengineeringstudio/effect-utils#769).

## Shape

A single Rust binary (effect-utils `packages/@overeng/otelite`, exposed as a
flake package + `nix run` app). One tokio runtime hosts both receivers over a
shared **Capture** sink.

```
otelite run     [--out <dir>] [--service N] [--http-port N] [--grpc-port N] [--drain-idle MS] [--pretty] -- <cmd...>
otelite inspect <dir|file|-> [--signal traces|metrics|logs] [--service S] [--name N] [--attr k=v]... [--summary] [--pretty]
otelite capture [--out <dir>] [--http-port N] [--grpc-port N]      # receiver-only (no child; serves until signal)
otelite --print-schema | --version | --help | <verb> --help
```

```
run -- <cmd...>:
  ├─ bind receiver: HTTP (axum) + gRPC (tonic), ephemeral :0 by default
  ├─ inject OTEL_* env into Child, pointed at the receiver
  ├─ Child runs; emitters POST/stream OTLP → decode → append to Capture
  ├─ Child exits (code C) → Drain → close
  └─ stdout: one `otelite.summary/v1` JSON line {out, endpoints, files, counts, exit_code:C, duration}
  exit code = C
inspect <src>:
  └─ read Capture → NDJSON `otelite.span/v1` rows, or one `--summary` report object
```

## CLI contract (agent-first, Unix-composable)

Design borrows from `rg --json`, `gh --json`+jq, `kubectl -o json`, BSD
`sysexits.h`. See `decisions/0009`.

- **stdout = machine JSON only.** `run`/`capture` emit one `otelite.summary/v1`
  line; `inspect` emits NDJSON `otelite.span/v1` rows (or one report object under
  `--summary`). Every object carries a `schema: "name/vN"` tag, locked by the
  conformance goldens.
- **stderr = everything human.** Endpoints, progress, drain notices, and the
  **Child's own stdout** route to stderr, so `run | jq` and `run | inspect -`
  stay clean.
- **JSON is the default; `--pretty` is opt-in** (agents are the primary
  consumer). No interactive prompts ever; output is deterministic.
- **Composition:** the `run` summary carries `.out`, so
  `otelite run -- cmd | otelite inspect - | jq -e 'select(...)'` is the
  one-liner capture→assert path. `inspect` reads a dir, a file, or `-` (stdin).
- **Filtering, not a query language:** `--service` / `--name` / `--attr k=v` /
  `--summary` cover exact-match; everything else is a natural `| jq`. Upholds the
  scope line — otelite normalizes, tests assert (`jq -e` / Effect `Schema`).
  Filters narrow the **flat** `otelite.span/v1` rows; `--summary` always
  summarizes the whole trace (filters do not pre-narrow it, so exclusive-duration
  math stays correct). In flat rows, `attrs` is a `Record<string,string>` — the
  capture model flattens every OTLP `AnyValue` (bool/int/double) to its string
  form, and non-scalar values (array/kvlist/bytes) flatten to `""`. The Effect
  `Schema` (M9) decodes `attrs` as `Record<string,string>` accordingly.

### Exit codes

`run` preserves the Child's exit code on the happy path. otelite's own failures
use `sysexits.h`, disambiguated from a child code by empty stdout:

| Code     | Meaning                                           |
| -------- | ------------------------------------------------- |
| `0..255` | `run` happy path = Child's exit code              |
| `64`     | bad flags / missing `--` cmd / unknown verb       |
| `65`     | decode error (malformed OTLP / corrupt capture)   |
| `66`     | inspect source missing/unreadable                 |
| `73`     | cannot create/write out-dir                       |
| `74`     | receiver bind error (port in use) / write failure |
| `75`     | `--drain-idle` timeout exceeded                   |
| `70`     | internal otelite bug                              |
| `69`     | a verb that isn't implemented yet                 |

A signal-killed child is reported faithfully as `128 + signo` (so a segfault or
OOM-kill isn't mistaken for SIGINT), in both `child.exit_code` and the process
exit. A `--drain-idle` that never quiesces exits `75`, overriding the child code,
but still emits the summary so the capture stays usable.

`capture` is the receiver-only verb (no child): it prints its endpoints, serves
until SIGINT/SIGTERM, then emits the same `otelite.summary/v1`. For when the test
harness owns the SUT lifecycle itself.

`inspect` covers **all three signals at parity** — traces, metrics, logs each get
flatten + filter + `--summary`. Trace summarize is salvaged from the proven trace
analysis; metric and log summarizers are authored fresh and golden-locked
(`requirements.md` R10).

## Receiver (transports)

Accepts all common patterns the production OTel stack emits:

- **OTLP/HTTP** on one port: `POST /v1/{traces,metrics,logs}`, both
  `application/json` and `application/x-protobuf`. Served by axum.
- **OTLP/gRPC** on a second port: the official `opentelemetry-proto`
  (`gen-tonic`) generated `TraceService` / `MetricsService` / `LogsService`,
  served by tonic.

Both decode into the same `opentelemetry-proto` message types and write through
one sink. No bespoke wire handling. See `decisions/0002`.

Known limitation: `opentelemetry-proto`'s `with-serde` drops the
`exponentialHistogram` data oneof on the **JSON** receive path, so an exp-histogram
emitted by a JSON-only client is captured empty; the **protobuf** path (SDK
default) captures it fine. `inspect` therefore walks the captured JSON directly
rather than round-tripping the proto type. Tracked as an otelite follow-up.

Accepted JSON dialect: the one OTel language SDKs emit by default — hex IDs,
string int64, integer enums. Other spec-conformant encodings (base64 IDs, string
enums, numeric int64) are **rejected loudly** (HTTP 400 / gRPC error), never
silently dropped — a decode failure must be visible, not mistaken for "no
telemetry." See `decisions/0011`.

## Isolation (coordination-free parallel use)

Many independent agents must run otelite concurrently with **zero cross-agent
coordination** — no shared ports, files, locks, or registry. Two per-run
identities provide that, and nothing else is shared:

- **Ephemeral `:0` ports.** Bind HTTP and gRPC to independent `:0` ports; read
  the actual ports back (clean `local_addr()`) and inject them into the Child
  env. Because otelite _owns_ the Child env there is no port-discovery problem,
  so ephemeral is strictly best — no hash-port scheme (that exists in the devenv
  stack only because emitter and receiver are configured separately).
  `--http-port` / `--grpc-port` force fixed ports for deterministic/debug runs.
- **Auto-unique out-dir.** `--out` is optional; when omitted otelite mints a
  unique dir (`$TMPDIR/otelite-<random>`) and echoes it as `.out` in the summary.
  Requiring `--out` would force every caller to invent unique names — the exact
  thing that races. Validated to K=400 concurrent runs with zero collisions
  (`decisions/0010`).
- **Defend a shared `--out`.** If two runs are pointed at the same dir, open sink
  files with `create_new`/`O_EXCL` (or flock) and **fail loud** — never silently
  truncate a peer's capture.

Validated: isolation passes at K=400 with no bind failures, no
cross-contamination, no collisions; port headroom is low-thousands of concurrent
instances. The only per-run identity is the two ephemeral ports + the out-dir;
nothing else is shared.

## Capture format

One file per signal in `<dir>`: `traces.ndjson`, `metrics.ndjson`,
`logs.ndjson`. Each line is one received export as **canonical OTLP/JSON** (the
`Export*ServiceRequest` via `opentelemetry-proto` `with-serde`) — losslessly,
regardless of whether it arrived as JSON, protobuf, or gRPC. NDJSON (one export
per line, append-only) so capture is streaming and crash-tolerant. `inspect`
owns all denesting/flattening; the capture stays raw and faithful.

## Child env injection

otelite authoritatively sets the vars that MUST point at its receiver, and
passes through everything else the caller set (least surprise):

- **Owned (always overwritten):** `OTEL_EXPORTER_OTLP_ENDPOINT` (receiver base
  URL), `OTEL_EXPORTER_OTLP_PROTOCOL` (`http/protobuf` by default; the OTLP spec
  default). These point the emitter at otelite — letting a stale parent value
  win would silently send telemetry elsewhere. The **per-signal overrides**
  (`OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_{ENDPOINT,PROTOCOL}`) take
  precedence over the base in the OTLP spec, so they are **cleared** — otherwise
  a parent `*_TRACES_ENDPOINT` pointing at a real collector would silently
  misroute traces away from otelite.
- **Respected (pass-through):** `OTEL_RESOURCE_ATTRIBUTES`, and
  `OTEL_SERVICE_NAME` unless `--service` is given (which wins). Other `OTEL_*`
  the caller set flow through untouched.

Canonical conventions confirmed against the OTLP spec: ports default ephemeral
but pin to 4317 (gRPC) / 4318 (HTTP); paths `/v1/{traces,metrics,logs}`;
content-types `application/x-protobuf` + `application/json`.

## Drain

After the Child exits, otelite finishes serving in-flight exports, then closes —
no timer by default. `--drain-idle <ms>` (bounded) is the opt-in for
fire-and-forget emitters; otelite **never** waits unbounded. See
`decisions/0006` for the evidence.

`run` swallows terminal Ctrl-C (the child shares the process group and receives
it too) so otelite stays up to drain and still emit the summary. Limitation: a
`SIGTERM` sent directly to otelite's PID (not the group) is not caught — the
child is orphaned. A forwarding SIGTERM handler is future work.

The guarantee depends on **durability before ack**: otelite writes each export to
the sink and flushes _before_ returning the OTLP success response (with
`sync_all` on shutdown). So a synchronous emitter that awaits its ack — or any
SDK that flushes on shutdown — is guaranteed its span is durably captured by the
time the Child exits, making in-flight drain sufficient (`decisions/0010`). To
avoid serializing throughput, the flush is a batched / notify-after-fsync barrier
rather than a per-export fsync held under the sink lock (a review spike measured
~600× latency inflation for the naive form on contended storage).

## Effect wrapper (`@overeng/otelite-effect`)

Tests consume otelite two ways: the raw CLI (language-agnostic) and a typed
Effect helper for the Effect/TS test harness. The helper is built
**Effect-native** (`/sk-effect`):

- Spawns the CLI via `@effect/platform` `Command` (`Command.make("otelite",
...)` + `CommandExecutor`), not `node:child_process`. Receiver lifecycle is a
  scoped resource so the Child + capture are released deterministically.
- Decodes the `run` summary and `inspect` rows with `Schema` — `Schema.decode`
  over the CLI's JSON contract — so consumers get typed `Summary` / `SpanRow`
  values, not `unknown`.
- Exposed as an `Effect.Service`; failures are tagged errors (spawn failure,
  non-zero child, decode mismatch) on the error channel, not defects.
- The CLI's JSON output is the single source of truth; the wrapper never
  reimplements capture/inspect logic — it shells out and decodes.

## Testing

otelite is a testing tool, so its own tests are held to a high bar. No mocking —
exercise the real receiver and the real binary (per house rules).

- **Conformance goldens (contract lock):** the salvaged `inspect`/`summarize`
  output is pinned by the byte-for-byte goldens carried over from the proven
  trace analysis (`tests/conformance/`). They lock the normalized JSON contract
  the Effect
  `Schema` and downstream assertions depend on; changing the field set or
  `canonical` serializer regenerates them.
- **Cross-transport equivalence (central invariant):** the same logical span
  emitted via OTLP/HTTP-JSON, OTLP/HTTP-protobuf, and OTLP/gRPC must produce an
  identical canonical-OTLP capture. One property test guards that the three
  decode paths converge — the strongest single check that the receiver is
  correct.
- **Round-trip + property tests (`@effect/vitest`):** capture→inspect preserves
  every emitted span; randomized span trees satisfy summarize invariants
  (durations ≥ 0, exclusive ≤ inclusive, parent covers children).
- **Determinism:** ephemeral ports + in-flight drain make end-to-end tests
  non-flaky by construction (validated by the drain experiment); tests assert
  exact counts, never sleep.
- **Real-binary integration:** the Effect wrapper's tests run the
  nix-built otelite binary against a known-good fixture emitter — no stubs.
- **Fixture emitter:** a small, deterministic OTLP emitter (drives all three
  transports) is shared across Rust integration tests and the Effect wrapper
  tests, so both layers test against the same known input.

## Scope line

otelite captures and normalizes; it does **not** assert. Test frameworks
(vitest/Effect) assert against `inspect` output. No assertion DSL. otelite is
the local-file capture **Lane**, not a Grafana/Tempo-mediated or production
substitute.
