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
otelite capture --out ./cap     # serves until SIGINT/SIGTERM, then prints the summary

otelite --print-schema          # the stable output schema tags
```

`inspect` normalizes; it does not assert — your test framework (`jq -e`, vitest,
or the `@overeng/otelite-effect` typed wrapper) owns the assertions.

## What it captures

- **Transports:** OTLP/HTTP (JSON + protobuf) and OTLP/gRPC, on ephemeral ports.
  Only the default OTel-SDK JSON dialect (hex IDs, string int64, integer enums)
  is accepted; other encodings are rejected loudly (HTTP 400), never dropped.
- **On disk:** one file per signal (`traces.ndjson` / `metrics.ndjson` /
  `logs.ndjson`), each line a canonical OTLP/JSON export.

## Output schemas

Every `inspect` row / summary carries a `schema` tag (locked by conformance
goldens), so consumers can version-pin:

| Verb | stdout |
| --- | --- |
| `run` / `capture` | one `otelite.summary/v1` line |
| `inspect --signal traces` | `otelite.span/v1` rows, or `otelite.trace-summary/v1` |
| `inspect --signal metrics` | `otelite.metric/v1` rows, or `otelite.metric-summary/v1` |
| `inspect --signal logs` | `otelite.log/v1` rows, or `otelite.log-summary/v1` |

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
  fire-and-forget emitters, `--drain-idle <ms>` waits — bounded, never
  unbounded. Each export is written durably before it is acked.
- **Exit codes:** `run` preserves the child's code (signal deaths → `128+signo`);
  otelite's own failures use `sysexits.h` (`64` usage, `65` decode, `66` missing
  source, `73` out-dir, `74` bind/shared-out, `75` drain-idle timeout). stdout
  stays machine-JSON-only; everything human (and the child's stdout) goes to stderr.

## Limitation

Exponential histograms only survive the protobuf receive path; the OTLP/JSON
receive path drops them (an upstream `opentelemetry-proto` deserialize gap).
SDKs default to protobuf, so this rarely bites.
