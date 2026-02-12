# Devenv OTEL Integration

Per-project OpenTelemetry tracing for `dt` tasks, TS app code, and (future) devenv native telemetry. Provides a local Collector + Tempo + Grafana stack via `devenv up`, with auto-detection of an existing system-level stack.

## System Stack Assumptions

The devenv module auto-detects a globally running OTEL stack on fixed well-known ports (Collector `:4318`, Tempo `:3200`, Grafana `:3700`). When detected, the devenv module reuses the system endpoints instead of starting its own services.

To run a **local** per-project stack instead (e.g. when no system stack is available), the module starts Collector + Tempo + Grafana on hash-derived ports via `devenv up`.

## Quick Start

```bash
# 1. Enter devenv -- ports are printed on shell entry
direnv allow
# [otel] Collector: http://127.0.0.1:XXXXX
# [otel] Grafana:   http://127.0.0.1:XXXXX

# 2. Start the stack (Collector + Tempo + Grafana)
devenv up

# 3. Run tasks -- automatically traced when stack is running
dt pnpm:install
dt check:quick

# 4. View traces
open $OTEL_GRAFANA_URL          # Grafana UI -> Explore -> Tempo
```

## Import

```nix
# devenv.nix
imports = [
  (inputs.effect-utils.devenvModules.otel {})
  # or with fixed base port:
  (inputs.effect-utils.devenvModules.otel { basePort = 14000; })
];
```

## Auto-Detection (System vs Local)

```
mode = "auto" (default)
  ├── probes $HOME/.otel/spool or curl :4318
  ├── if found → "system": uses system endpoints, skips local services
  └── if not   → "local": starts per-project Collector/Tempo/Grafana
```

When in system mode, `otel dash sync` copies project dashboards to `~/.otel/dashboards/{project}/` for the system Grafana to pick up.

## Environment Variables

| Variable                      | Set by      | Purpose                                                    |
| ----------------------------- | ----------- | ---------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `otel.nix`  | Collector HTTP endpoint (hash-based port)                  |
| `OTEL_GRAFANA_URL`            | `otel.nix`  | Grafana UI URL                                             |
| `TRACEPARENT`                 | `otel-span` | W3C Trace Context, propagated for parent-child trace links |

## Port Allocation

Ports are derived from `sha256(DEVENV_ROOT)` at Nix evaluation time so parallel worktrees don't conflict:

```
base = portRangeStart + (parseInt(sha256(root)[0:7], 16) % (portRangeEnd - portRangeStart - 6))
```

6 consecutive ports from `base`:

| Offset | Service                               |
| ------ | ------------------------------------- |
| +0     | OTEL Collector OTLP HTTP receiver     |
| +1     | Tempo OTLP gRPC ingest                |
| +2     | Tempo HTTP query API                  |
| +3     | Grafana HTTP UI                       |
| +4     | Collector internal Prometheus metrics |
| +5     | Tempo internal gRPC                   |

Range: 10000-60000 (~0.012% collision probability for 2 worktrees).

## Shell Helpers

### `otel-span` -- Emit trace spans

Wraps any command in an OTLP trace span. Fire-and-forget POST to collector (2s timeout, failure silenced). No-op when collector is down.

```bash
otel-span <service-name> <span-name> -- <command> [args...]
otel-span dt pnpm:install --attr cached=false -- pnpm install
```

The `dt` wrapper calls `otel-span` automatically -- no manual wrapping needed for task runs.

## Two-Level Tracing (`dt` + `dt-task`)

**Level 1 -- Root span** (`service.name="dt"`): `dt` wraps the entire `devenv tasks run`:

```bash
otel-span "dt" "$task_name" --attr "dt.args=$*" -- devenv tasks run "$@" --mode before
```

**Level 2 -- Child spans** (`service.name="dt-task"`): Each task's `exec` is wrapped via `trace.nix`:

```nix
# In task modules (e.g., ts.nix):
trace = import ../lib/trace.nix { inherit lib; };
exec = trace.exec "ts:check" "tsc --build tsconfig.all.json";
```

`TRACEPARENT` chains the spans: `dt` exports it -> `devenv tasks run` inherits it -> each task `exec` reads it via `otel-span`.

## Span Conventions

### Resource Attributes

| Attribute      | Required | Values           | Set by                    |
| -------------- | -------- | ---------------- | ------------------------- |
| `service.name` | Yes      | `"dt"`, app name | `otel-span`, Effect layer |
| `devenv.root`  | Yes      | Absolute path    | `otel-span`, Effect layer |

### Span Attributes (dt tasks)

| Attribute     | Type      | Description             | Example                        |
| ------------- | --------- | ----------------------- | ------------------------------ |
| `name`        | span name | Task name               | `"pnpm:install"`, `"ts:check"` |
| `exit.code`   | int       | Process exit code       | `0`, `1`                       |
| `dt.args`     | string    | Full dt command args    | `"check:quick"`                |
| `task.cached` | string    | Whether task was cached | `"true"`, `"false"`            |

`trace.exec` adds `task.cached=false` for executed tasks. `trace.status` adds `task.cached=true` for cached tasks. See `nix/devenv-modules/tasks/lib/trace.nix`.

## Dashboards

Nix-managed dashboards authored in [Grafonnet](https://github.com/grafana/grafonnet) (Jsonnet DSL), built at Nix eval time and provisioned into Grafana via file-based provisioning.

Source: `nix/devenv-modules/otel/dashboards/*.jsonnet`

### Build Pipeline

```
nix/devenv-modules/otel/dashboards/*.jsonnet   # Source (Grafonnet DSL)
        │
        ▼  go-jsonnet + grafonnet lib
/nix/store/.../dashboards/*.json               # Built (in Nix store)
        │
        ▼  Grafana file provisioning
Grafana UI                                      # Live dashboards
```

### Iteration Workflow

```bash
# Preview JSON output locally
jsonnet -J path/to/grafonnet dt-tasks.jsonnet | jq .

# Or paste into Grafana's Dashboard Settings > JSON Model for live preview
```

### Dashboard List

| Dashboard            | Purpose                                        |
| -------------------- | ---------------------------------------------- |
| `overview`           | Landing page: recent traces, service breakdown |
| `dt-tasks`           | Task duration, cache hit rate, failure rate    |
| `shell-entry`        | `direnv allow` / enterShell duration breakdown |
| `pnpm-install`       | Per-package install analysis, waterfall view   |
| `ts-app-traces`      | General-purpose trace exploration for Effect   |
| `dt-duration-trends` | p50/p95/p99 percentiles over time by category  |

### Project Dashboards (`.otel/dashboards.json`)

Projects define their own dashboards in `.otel/dashboards.json`. When a system-level OTEL stack is running, these are synced to its Grafana via `otel dash sync`.

## Data Storage

All state in `$DEVENV_ROOT/.devenv/otel/` (gitignored):

| Directory               | Contents                | Retention            |
| ----------------------- | ----------------------- | -------------------- |
| `tempo-data/`           | Compacted trace blocks  | 72h (configurable)   |
| `tempo-wal/`            | Write-ahead log         | Flushed on compact   |
| `grafana-data/`         | Grafana database/prefs  | Persistent           |
| `grafana-provisioning/` | Auto-provisioned config | Regenerated on start |

Clean with `rm -rf .devenv/otel/`.

## Forward Compatibility (cachix/devenv#2415)

When devenv adds native OTEL support, it will read `OTEL_EXPORTER_OTLP_ENDPOINT` (same env var this module sets) and export build/eval/fetch spans to the same collector. No configuration changes needed.

## Module Structure

```
nix/devenv-modules/
  otel.nix                    — devenv module: processes, env vars, auto-detection, dashboards
  otel/dashboards/            — Grafonnet source files
  tasks/lib/trace.nix         — otel-span wrapper for task exec tracing
  tasks/lib/cache.nix         — cache status tracking (sets task.cached attribute)
```

## Related

- **`nix/devenv-modules/tasks/tasks.md`** -- `dt` wrapper and task modules
- **[cachix/devenv#2415](https://github.com/cachix/devenv/issues/2415)** -- Upstream native OTEL support
