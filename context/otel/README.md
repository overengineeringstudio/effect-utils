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

| Variable                      | Set by      | Purpose                                                                          |
| ----------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `otel.nix`  | Collector HTTP endpoint. Read by TS code, `otel-span`, future devenv OTEL.       |
| `OTEL_GRAFANA_URL`            | `otel.nix`  | Grafana UI URL for opening dashboards.                                           |
| `TRACEPARENT`                 | `otel-span` | W3C Trace Context. Propagated to child processes for parent-child trace linking. |

## Shell Helpers

### `otel-span` -- Emit trace spans

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

### `otel-check` -- Diagnose the stack

CLI diagnostic tool using Grafana's HTTP API (anonymous auth, no tokens needed):

```bash
# Full health check (Grafana + Tempo + Collector + dashboards)
otel-check

# List all provisioned dashboards with URLs
otel-check dashboards

# Validate each dashboard (panel count, datasource refs, template vars)
otel-check dashboards --validate

# Query Tempo for recent traces (excludes internal Tempo traces)
otel-check traces

# Query with custom TraceQL filter
otel-check traces '{resource.service.name="dt"}'

# End-to-end smoke test: send span → Collector → Tempo → query back
otel-check send-test

# Show configured datasources
otel-check datasources
```

Example output of `otel-check`:

```
OTEL Stack Health

Grafana (http://127.0.0.1:56608)
  ✓ Healthy (v12.3.2, db=ok)
  ✓ 5 dashboards provisioned
  ✓ Tempo datasource: Tempo (uid=tempo)

Tempo (http://127.0.0.1:56607)
  ✓ Ready

OTEL Collector (http://127.0.0.1:56605)
  ✓ Healthy (metrics endpoint)
```

Example output of `otel-check dashboards --validate`:

```
Provisioned Dashboards

  ✓ dt Task Performance (otel-dt-tasks): 15 panels, all valid
  ✓ OTEL Overview (otel-overview): 9 panels, all valid
  ✓ pnpm Install Deep-Dive (otel-pnpm-install): 10 panels, all valid
  ✓ Shell Entry Performance (otel-shell-entry): 7 panels, all valid
  ✓ TS App Traces (otel-ts-app-traces): 10 panels, all valid

  ✓ All 5 dashboards validated successfully
```

Example output of `otel-check send-test`:

```
End-to-End Smoke Test

  → Checking stack health...
  ✓ Grafana reachable
  ✓ Tempo ready
  ✓ Collector reachable

  → Sending test span (trace_id=16be05cf...)...
  ✓ Span sent to Collector (HTTP 200)
  → Waiting for ingestion (2s for batch + flush)...

  ✓ Trace found in Tempo after 1 attempt(s)
  ✓ End-to-end verified: otel-span → Collector → Tempo → Grafana query
```

## Processes

Started via `devenv up`. Process names include ports for visibility in the process-compose TUI:

| Process                 | Purpose                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `otel-collector-<port>` | Receives OTLP/HTTP, batches, forwards to Tempo                              |
| `tempo-<port>`          | Trace storage (local filesystem)                                            |
| `grafana-<port>`        | Dashboard UI with Tempo pre-configured (binds 0.0.0.0 for Tailscale access) |

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
