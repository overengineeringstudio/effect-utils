# Grafana Dashboards

Nix-managed dashboards provisioned automatically when Grafana starts.

## Authoring: Grafonnet (Jsonnet DSL)

Dashboards are authored in [Grafonnet](https://github.com/grafana/grafonnet), Grafana's official Jsonnet library. Nix evaluates Jsonnet source files to JSON at build time, then provisions them into Grafana via file-based provisioning.

### Why Grafonnet

| Approach                | Maintainability           | Iteration speed           | Tooling overhead           | Review-friendliness          |
| ----------------------- | ------------------------- | ------------------------- | -------------------------- | ---------------------------- |
| Raw JSON                | Poor (verbose, fragile)   | Fast (copy-paste from UI) | None                       | Poor (1000+ line diffs)      |
| Nix `builtins.toJSON`   | Moderate                  | Slow (manual panel IDs)   | None                       | Moderate                     |
| **Grafonnet (Jsonnet)** | **Good (composable DSL)** | **Moderate**              | **`go-jsonnet` in devenv** | **Good (30-100 line diffs)** |
| TypeScript generator    | Good                      | Moderate                  | bun + @grafana/schema      | Good                         |

Grafonnet wins on maintainability vs raw JSON and avoids adding a TS build step for infrastructure config. The `go-jsonnet` binary is ~15MB in nixpkgs.

### Build Pipeline

```
nix/devenv-modules/otel/dashboards/*.jsonnet   # Source (Grafonnet DSL)
        │
        ▼  go-jsonnet + grafonnet lib
nix/store/.../dashboards/*.json                 # Built (in Nix store)
        │
        ▼  Grafana file provisioning
Grafana UI                                      # Live dashboards
```

### Nix Integration

```nix
# In otel.nix
grafonnetSrc = pkgs.fetchFromGitHub {
  owner = "grafana";
  repo = "grafonnet";
  rev = "7380c9c64fb973f34c3ec46265621a2b0dee0058";
  sha256 = "...";
};

buildDashboard = name: pkgs.runCommand "grafana-dashboard-${name}" {
  nativeBuildInputs = [ pkgs.go-jsonnet ];
} ''
  mkdir -p $out
  jsonnet -J ${grafonnetSrc} \
    ${./dashboards/${name}.jsonnet} \
    -o $out/${name}.json
'';

allDashboards = pkgs.linkFarm "otel-dashboards" [
  { name = "dt-tasks.json"; path = "${buildDashboard "dt-tasks"}/dt-tasks.json"; }
  { name = "shell-entry.json"; path = "${buildDashboard "shell-entry"}/shell-entry.json"; }
  # ...
];
```

Grafana provisioning config:

```yaml
apiVersion: 1
providers:
  - name: otel
    type: file
    disableDeletion: true
    updateIntervalSeconds: 0
    options:
      path: /nix/store/.../otel-dashboards # linkFarm output
```

### Iteration Workflow

```bash
# Edit Jsonnet source
vim nix/devenv-modules/otel/dashboards/dt-tasks.jsonnet

# Preview JSON output locally
jsonnet -J path/to/grafonnet dt-tasks.jsonnet | jq .

# Rebuild and re-provision (restart Grafana)
devenv up  # picks up new Nix store path
```

For faster iteration, use `jsonnet` directly + Grafana's JSON model editor (paste JSON into Dashboard Settings > JSON Model).

---

## Dashboards

All dashboards query Tempo's TraceQL. The datasource variable `${DS_TEMPO}` is replaced with `"Tempo"` during provisioning (same `sed` pattern as the unpoller setup).

### 1. Overview / Home

**Purpose**: Landing page. Single-pane summary of recent activity.

| Panel             | Type      | Query                                     |
| ----------------- | --------- | ----------------------------------------- |
| Recent traces     | Table     | `{}` (last 20 traces)                     |
| Traces by service | Bar chart | `{} \| count() by(resource.service.name)` |
| Error count (24h) | Stat      | `{status.code = error}`                   |
| Avg span duration | Stat      | `{} \| avg(duration)`                     |

### 2. dt Task Performance

**Purpose**: Answer "how long do my `dt` tasks take?" and "are caches working?". This is the primary dashboard for the PR #114 use case.

| Panel                   | Type        | Query                                                                           |
| ----------------------- | ----------- | ------------------------------------------------------------------------------- |
| Task duration over time | Time series | `{resource.service.name = "dt"} \| rate() by(name)`                             |
| Slowest tasks (p95)     | Bar chart   | `{resource.service.name = "dt"} \| quantile_over_time(duration, 0.95) by(name)` |
| Task cache hit rate     | Stat        | `{resource.service.name = "dt" && cached = "true"} \| count()` vs total         |
| Task failure rate       | Stat        | `{resource.service.name = "dt" && status.code = error} \| count()`              |
| Recent task traces      | Table       | `{resource.service.name = "dt"}` (last 50)                                      |

### 3. Shell Entry (enterShell)

**Purpose**: Answer "how long does `direnv allow` take?" with breakdown by phase.

| Panel                          | Type        | Query                                                         |
| ------------------------------ | ----------- | ------------------------------------------------------------- |
| Shell entry duration           | Time series | `{name = "devenv:enterShell"}`                                |
| Breakdown by setup phase       | Stacked bar | `{name =~ "setup:opt:.*"}` durations                          |
| pnpm:install vs cached         | Stat        | cached vs uncached enterShell durations                       |
| Time since last uncached entry | Stat        | time since last `{name = "pnpm:install" && cached = "false"}` |

### 4. pnpm Install Deep-Dive

**Purpose**: Per-package install analysis. Directly addresses network overhead from #110.

| Panel                        | Type        | Query                                                                     |
| ---------------------------- | ----------- | ------------------------------------------------------------------------- |
| Per-package install duration | Heatmap     | `{resource.service.name = "dt" && name =~ "pnpm:install:.*"} \| duration` |
| Sequential chain waterfall   | Trace view  | Single trace showing all 20 packages in sequence                          |
| Total install time trend     | Time series | `{name = "pnpm:install"} \| duration` over time                           |
| Network download indicator   | Stat        | Uncached installs (duration > threshold = likely network)                 |

### 5. TS App Traces

**Purpose**: General-purpose trace exploration for Effect OTEL layers.

| Panel                         | Type        | Query                                                                  |
| ----------------------------- | ----------- | ---------------------------------------------------------------------- |
| Service map                   | Node graph  | `{} \| by(resource.service.name)`                                      |
| Request latency (p50/p95/p99) | Time series | `{resource.service.name != "dt"} \| quantile_over_time(duration, ...)` |
| Error traces                  | Table       | `{status.code = error && resource.service.name != "dt"}`               |
| Trace search                  | Search      | Tempo native search panel                                              |

### 6. dt Duration Trends

**Purpose**: Track p50/p95/p99 percentiles over time for all traced tasks.

| Panel                                      | Type        | Query                                                                                               |
| ------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------- |
| Core Pipeline (check:quick, etc.)          | Time series | `{resource.service.name="dt" && name="check:quick"} \| quantile_over_time(duration, 0.5/0.95/0.99)` |
| TypeScript Operations                      | Time series | `{resource.service.name="dt" && name=~"ts:.*"} \| quantile_over_time(duration, ...)`                |
| Lint Components                            | Time series | `{resource.service.name="dt-task" && name=~"lint:.*"} \| quantile_over_time(duration, ...)`         |
| Test / Nix / Megarepo / Shell / pnpm / tsc | Time series | Per-category p50/p95/p99 duration trends                                                            |

---

## Span Conventions

For dashboards to work reliably, spans must follow these attribute conventions:

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

> **Note**: Cache status is tracked via `task.cached` attribute. `trace.exec` adds `task.cached=false` for executed tasks, and `trace.status` adds `task.cached=true` for cached tasks. See `nix/devenv-modules/tasks/lib/trace.nix`.

---

## Implementation Checklist

- [x] Add `go-jsonnet` to devenv packages
- [x] Fetch grafonnet as `pkgs.fetchFromGitHub` in otel.nix
- [x] Create `nix/devenv-modules/otel/dashboards/` directory with `.jsonnet` files
- [x] Wire `linkFarm` + Grafana dashboard provisioning in otel.nix
- [x] Build overview dashboard
- [x] Build dt-tasks dashboard
- [x] Build shell-entry dashboard
- [x] Build pnpm-install dashboard
- [x] Build ts-app-traces dashboard
- [x] Add `cached` attribute to `otel-span` / `dt` wrapper
- [x] Document TraceQL queries in this file for each panel
