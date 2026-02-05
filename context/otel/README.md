# OpenTelemetry Observability

Local OTEL stack for tracing `dt` tasks, TS app code, and (future) devenv native telemetry.

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

## Environment Variables

| Variable | Set by | Purpose |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `otel.nix` | Collector HTTP endpoint. Read by TS code, `otel-span`, future devenv OTEL. |
| `OTEL_GRAFANA_URL` | `otel.nix` | Grafana UI URL for opening dashboards. |
| `TRACEPARENT` | `otel-span` | W3C Trace Context. Propagated to child processes for parent-child trace linking. |

## Shell Helper: `otel-span`

Wrap any command in an OTLP trace span:

```bash
# Basic usage
otel-span <service-name> <span-name> -- <command> [args...]

# With attributes
otel-span dt pnpm:install --attr cached=false --attr packages=20 -- pnpm install

# No-op when collector is down (fire-and-forget)
otel-span dt ts:check -- tsc --noEmit
```

The `dt` wrapper calls `otel-span` automatically -- no manual wrapping needed for task runs.

## Processes

Started via `devenv up`:

| Process | Purpose |
| --- | --- |
| `otel-collector` | Receives OTLP/HTTP, batches, forwards to Tempo |
| `tempo` | Trace storage (local filesystem) |
| `grafana` | Dashboard UI with Tempo pre-configured |

## Import in Other Repos

```nix
# devenv.nix
imports = [
  (inputs.effect-utils.devenvModules.otel {})
  # or with fixed base port:
  (inputs.effect-utils.devenvModules.otel { basePort = 14000; })
];
```

## Related

- [spec.md](./spec.md) -- Architecture, port allocation, forward compatibility
- [dashboards.md](./dashboards.md) -- Grafonnet dashboards, span conventions, implementation plan
- [nix-devenv/tasks/tasks.md](../nix-devenv/tasks/tasks.md) -- `dt` wrapper and task modules
- [cachix/devenv#2415](https://github.com/cachix/devenv/issues/2415) -- Upstream native OTEL support
