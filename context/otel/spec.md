# OTEL Stack Specification

## Context

We run many devenv worktrees in parallel on the same machine. Each needs local observability for debugging task performance (e.g., repeated pnpm installs), tracing TS application code, and eventually consuming devenv's own native OTEL telemetry ([cachix/devenv#2415](https://github.com/cachix/devenv/issues/2415)).

## Architecture

```
 ┌─────────────────┐       ┌───────────────────┐       ┌──────────────┐
 │  dt tasks        │──────▶│  OTEL Collector    │──────▶│  Grafana     │
 │  (otel-span)     │ OTLP  │  (otelcol-contrib) │       │  Tempo       │
 │                  │ HTTP   │                   │       │  (traces)    │
 ├─────────────────┤  JSON  │  Batches spans,    │       │              │
 │  TS app code     │──────▶│  forwards to Tempo │       │  Explore UI  │
 │  (Effect OTEL)   │       │  via OTLP/gRPC     │       │              │
 ├─────────────────┤       └───────────────────┘       └──────────────┘
 │  Future: devenv  │ OTLP
 │  native (#2415)  │──────▶  (same collector endpoint)
 └─────────────────┘
```

### Protocol

| Segment             | Protocol  | Format                    |
| ------------------- | --------- | ------------------------- |
| Source -> Collector | OTLP/HTTP | JSON (`application/json`) |
| Collector -> Tempo  | OTLP/gRPC | Protobuf                  |
| Grafana -> Tempo    | HTTP API  | JSON                      |

The TS Effect OTEL layers use `FetchHttpClient` + `OtlpSerialization.layerJson`, matching the Collector's HTTP/JSON receiver. No gRPC or protobuf needed on the client side.

### Data Flow

1. **Shell scripts** (`dt`, custom scripts) use `otel-span` to POST OTLP JSON to the Collector.
2. **TS code** (`@overeng/utils`, `@overeng/utils-dev`) uses Effect's `OtlpTracer.layer` which reads `OTEL_EXPORTER_OTLP_ENDPOINT`.
3. **OTEL Collector** batches spans (1s window, 128 batch size) and forwards to Tempo over gRPC.
4. **Tempo** stores traces in local filesystem (`$DEVENV_ROOT/.devenv/otel/tempo-data`).
5. **Grafana** queries Tempo's HTTP API for trace exploration.

## Port Allocation

### Requirements

- P1 - Parallel devenv worktrees must not conflict on ports.
- P2 - Ports must be deterministic (same worktree = same ports, every time).
- P3 - `OTEL_EXPORTER_OTLP_ENDPOINT` must be known at shell entry time (not just at process start).

### Design: Hash-Based Deterministic Ports

Ports are derived from `sha256(DEVENV_ROOT)` at Nix evaluation time:

```
base = portRangeStart + (parseInt(sha256(root)[0:7], 16) % (portRangeEnd - portRangeStart - 6))
```

6 consecutive ports from `base`:

| Offset | Service                               | Default equivalent |
| ------ | ------------------------------------- | ------------------ |
| +0     | OTEL Collector OTLP HTTP receiver     | 4318               |
| +1     | Tempo OTLP gRPC ingest                | 4317               |
| +2     | Tempo HTTP query API                  | 3200               |
| +3     | Grafana HTTP UI                       | 3000               |
| +4     | Collector internal Prometheus metrics | 8888               |
| +5     | Tempo internal gRPC                   | 9095               |

Range: 10000-60000 (50K range, ~0.012% collision probability for 2 worktrees).

Collector and Tempo bind to `127.0.0.1`. Grafana binds to `0.0.0.0` for Tailscale access.

### Override

```nix
(import ./nix/devenv-modules/otel.nix { basePort = 14000; })
```

## otel-span: Shell OTLP Compat Layer

Lightweight shell helper that wraps commands in OTLP trace spans. Uses `curl` to POST JSON -- no SDK needed.

### Behavior

- **When `OTEL_EXPORTER_OTLP_ENDPOINT` is set**: wraps command, emits span with timing + exit code + attributes, fire-and-forget POST to collector (2s timeout, failure silenced).
- **When unset**: falls through to `exec` -- zero overhead.
- **Trace context**: reads/writes `TRACEPARENT` (W3C Trace Context). Child processes inherit the trace.

### Span Attributes

| Attribute         | Type            | Source                        |
| ----------------- | --------------- | ----------------------------- |
| `service.name`    | resource + span | First positional arg          |
| `devenv.root`     | resource + span | `$DEVENV_ROOT`                |
| `exit.code`       | span            | Command exit code             |
| Custom (`--attr`) | span            | User-provided key=value pairs |

### dt Integration

The `dt` wrapper auto-detects `otel-span` on PATH and wraps every task run:

```bash
# What dt does internally when OTEL is available:
otel-span "dt" "$task_name" --attr "dt.args=$*" -- devenv tasks run "$@" --mode before
```

## Storage

All state lives in `$DEVENV_ROOT/.devenv/otel/`:

| Directory               | Contents                             | Retention             |
| ----------------------- | ------------------------------------ | --------------------- |
| `tempo-data/`           | Compacted trace blocks               | 72h (configurable)    |
| `tempo-wal/`            | Write-ahead log                      | Flushed on compaction |
| `tempo-metrics/`        | Tempo metrics generator state        | Rolling               |
| `grafana-data/`         | Grafana database (dashboards, prefs) | Persistent            |
| `grafana-provisioning/` | Auto-provisioned Tempo datasource    | Regenerated on start  |

The `.devenv/` directory is gitignored. Clean with `rm -rf .devenv/otel/`.

## Forward Compatibility

### devenv Native OTEL (cachix/devenv#2415)

When devenv adds native OTEL support, it will:

1. Read `OTEL_EXPORTER_OTLP_ENDPOINT` (same env var this module sets)
2. Export build/eval/fetch spans to the same collector
3. Appear alongside `dt` and TS traces in Grafana

No configuration changes needed -- the collector accepts any OTLP source.

### Migration Path

1. **Now**: This module provides the full stack. `otel-span` bridges shell scripts to OTEL.
2. **When devenv#2415 lands**: Enable devenv's native OTEL flag. Remove `otel-span` wrapper from `dt` if devenv instruments tasks natively. Keep the collector/tempo/grafana stack.
3. **Long-term**: The collector can be extended with additional exporters (e.g., Honeycomb, Datadog) or additional pipelines (metrics, logs) without changing producers.

## Grafana Configuration

- **Anonymous auth**: enabled with Admin role (local dev, no login needed)
- **Bind address**: `0.0.0.0` (accessible via Tailscale from other machines)
- **Tempo datasource**: auto-provisioned with stable UID via delete+recreate pattern
- **Dashboards**: provisioned via Nix-built Grafonnet (see [dashboards.md](./dashboards.md))
- **Analytics/updates**: disabled
- **Log level**: warn (minimal console noise)

## CLI Diagnostics: `otel-check`

Shell helper for diagnosing stack health via Grafana's HTTP API. No tokens needed (anonymous auth).

| Command                            | What it does                                                      |
| ---------------------------------- | ----------------------------------------------------------------- |
| `otel-check`                       | Full health: Grafana + Tempo + Collector + dashboard count        |
| `otel-check dashboards`            | List provisioned dashboards with browser URLs                     |
| `otel-check dashboards --validate` | Load each dashboard, check panels, datasource refs, template vars |
| `otel-check traces`                | Query Tempo for recent non-internal traces (last 1h)              |
| `otel-check traces '<traceql>'`    | Query with custom TraceQL filter                                  |
| `otel-check send-test`             | End-to-end smoke test: send span → Collector → Tempo → query      |
| `otel-check datasources`           | Show configured Grafana datasources with UIDs                     |

### Dashboard Validation

`otel-check dashboards --validate` loads each dashboard via the Grafana API and checks:

- Panel count (non-zero)
- All non-row/text panels have targets with valid datasource UIDs
- No unresolved datasource template variables

### API Endpoints Used

| Endpoint                                           | Purpose                                           |
| -------------------------------------------------- | ------------------------------------------------- |
| `GET /api/health`                                  | Grafana health (no auth required)                 |
| `GET /api/search?type=dash-db`                     | List dashboards                                   |
| `GET /api/dashboards/uid/:uid`                     | Load full dashboard model (for validation)        |
| `GET /api/datasources`                             | List datasources (resolves Tempo UID dynamically) |
| `POST /api/ds/query`                               | Query Tempo via TraceQL                           |
| `POST <collector>/v1/traces`                       | Send test OTLP span (for send-test)               |
| `GET http://127.0.0.1:<tempo-port>/ready`          | Direct Tempo readiness check                      |
| `GET http://127.0.0.1:<tempo-port>/api/traces/:id` | Direct trace lookup (for send-test)               |
| `GET http://127.0.0.1:<metrics-port>/metrics`      | Collector Prometheus metrics                      |
