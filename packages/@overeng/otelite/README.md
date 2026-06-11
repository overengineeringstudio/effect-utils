# otelite

A tiny, coordination-free local OTLP capture tool for E2E and instrumentation
tests — optimized for coding agents. It stands up a real OTLP receiver, runs a
command with telemetry pointed at it, captures traces/metrics/logs to files, and
hands them back for assertions. ~5 MB, millisecond startup, no Grafana/Tempo
stack, no YAML.

otelite is the **local-file capture lane**: complementary to a Grafana/Tempo
verification lane and the production collector, not a replacement for either.

## Install

```bash
nix run github:overengineeringstudio/effect-utils#otelite -- --version
# or in a flake: inputs.effect-utils.packages.<system>.otelite
```

Inside this repo's `devenv` shell, `otelite` is already on `PATH` for
`@overeng/utils-dev/otelite` tests. From a plain shell, either run the app
directly with `nix run .#otelite -- ...`, prepend the built package to `PATH`,
or point the typed wrapper at it explicitly:

```bash
export OTELITE_BIN="$(nix build --no-link --print-out-paths .#otelite)/bin/otelite"
CI=1 pnpm --dir packages/@overeng/utils-dev exec vitest run --config vitest.config.ts src/otelite/Otelite.test.ts
```

## Usage

```bash
# Capture a command's telemetry, then assert on it — the one-liner:
otelite run -- my-cli search "query" | otelite inspect - | jq -e 'select(.name == "GET /search")'

# Run a command under capture; stdout is a single machine-readable summary line.
otelite run --out ./cap -- my-instrumented-cli
#   {"schema":"otelite.summary/v1","out":"./cap","endpoints":{...},
#    "counts":{"spans":3,"metrics":1,"logs":2},"child":{"argv":[...],"exit_code":0},...}

# Inspect a capture (dir, file, or `-` for stdin / a piped run summary):
otelite inspect ./cap --service my-svc --name "GET /search"   # flat otelite.span/v1 rows
otelite inspect ./cap --summary                                # per-trace rollup
otelite inspect ./cap --signal metrics --attr http.status_code=500
otelite inspect ./cap --signal logs --summary                  # by_severity / by_service

# Receiver-only, when the test harness owns the SUT lifecycle:
otelite capture --out ./cap     # serves until SIGINT/SIGTERM or stdin EOF
#   stdout is a tagged event stream: the first line is the bound endpoints,
#   the last line is the summary. An in-process parent reads the endpoints with
#   no scraping and stops the receiver by closing the child's stdin.
#   {"schema":"otelite.endpoints/v1","http":"http://127.0.0.1:PORT","grpc":"http://127.0.0.1:PORT","out":"/abs/cap"}
#   …
#   {"schema":"otelite.summary/v1",...}

otelite --print-schema          # the stable output schema tags
```

`inspect` normalizes; it does not assert — your test framework (`jq -e`, vitest,
or the `@overeng/utils-dev/otelite` typed wrapper) owns the assertions.

## What it captures

- **Transports:** OTLP/HTTP (JSON + protobuf) and OTLP/gRPC, on ephemeral ports.
  `run` points the child at HTTP by default; for a gRPC-configured SDK use
  `otelite run --protocol grpc -- …` (or read the exported `OTELITE_GRPC_ENDPOINT`).
  Only the default OTel-SDK JSON dialect (hex IDs, string int64, integer enums)
  is accepted; other encodings are rejected loudly (HTTP 400, counted as
  `counts.rejected`), never dropped.
- **On disk:** one file per signal (`traces.ndjson` / `metrics.ndjson` /
  `logs.ndjson`), each line a canonical OTLP/JSON export.

## Output schemas

Every `inspect` row / summary carries a `schema` tag (locked by conformance
goldens), so consumers can version-pin:

| Verb                       | stdout                                                   |
| -------------------------- | -------------------------------------------------------- |
| `run`                      | one `otelite.summary/v1` line                            |
| `capture`                  | `otelite.endpoints/v1` line, then `otelite.summary/v1`   |
| `inspect --signal traces`  | `otelite.span/v1` rows, or `otelite.trace-summary/v1`    |
| `inspect --signal metrics` | `otelite.metric/v1` rows, or `otelite.metric-summary/v1` |
| `inspect --signal logs`    | `otelite.log/v1` rows, or `otelite.log-summary/v1`       |

Metric rows are per data point (gauge/sum `value`; histogram
`count/sum/min/max/mean/bucket_counts/explicit_bounds`; exp-histogram
`scale/zero_count/positive_buckets`). `attrs` is a `Record<string,string>` on
every row.

## Behavior

- **Coordination-free parallel use:** each invocation binds its own ephemeral
  ports and uses an auto-unique `$TMPDIR/otelite-<random>` out-dir (override with
  `--out`). Many agents run at once with no shared state — validated to K=400.
- **Capture completeness:** after the child exits, otelite drains in-flight
  exports (0ms tax; full capture for any emitter that flushes on shutdown). For
  fire-and-forget emitters, `--drain-idle <ms>` waits until no export arrives for
  one `<ms>` window (capped at 50 windows → at most `50 × <ms>`), never
  unbounded. Each export is written durably before it is acked.
- **Exit codes:** `run` preserves the child's code (signal deaths → `128+signo`);
  otelite's own failures use `sysexits.h` (`64` usage, `65` decode, `66` missing
  source, `73` out-dir, `74` bind/shared-out, `75` drain-idle timeout). stdout
  stays machine-JSON-only; everything human (and the child's stdout) goes to stderr.

## Limitation

The metrics OTLP/JSON receive path is lossless for the data shapes the upstream
`opentelemetry-proto` `with-serde` deserialize silently drops — string-form
int64 sum/gauge values (`"asInt":"7"`), regular histograms, and exponential
histograms. otelite uses that deserialize only to validate the dialect and then
persists the validated raw JSON body verbatim, so those metrics survive. (The
protobuf path was always lossless; its decode has no such ambiguity.)

Residual limitation: for metrics, the upstream `with-serde` deserialize is more
lenient than the trace one, so the JSON dialect gate is effectively structural
(it rejects malformed JSON and hard field-type mismatches, but tolerates some
non-default dialect shapes like numeric int64 nanos or string enums rather than
rejecting them loudly). A stricter metrics dialect gate is a follow-up.
