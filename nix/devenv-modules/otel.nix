# OpenTelemetry observability stack for local development
#
# Provides OTEL Collector + Grafana Tempo + Grafana as devenv processes
# for collecting traces from dt tasks, TS app code, and (future) devenv native OTEL.
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.otel {})
#     # or with custom base port:
#     # (inputs.effect-utils.devenvModules.otel { basePort = 14000; })
#   ];
#
# Port allocation:
#   By default, ports are derived deterministically from a hash of $DEVENV_ROOT
#   so parallel devenvs (worktrees) get non-conflicting ports automatically.
#   You can override with a fixed basePort if preferred.
#
# Components:
#   - OTEL Collector (receives OTLP/HTTP on port basePort+0, exports to Tempo)
#   - Grafana Tempo (receives traces from collector on port basePort+1, query on basePort+2)
#   - Grafana (dashboard UI on port basePort+3)
#
# Environment variables set:
#   - OTEL_EXPORTER_OTLP_ENDPOINT - points to the OTEL Collector HTTP endpoint
#   - OTEL_GRAFANA_URL - points to the Grafana UI
#
# OTEL compat layer:
#   This module anticipates devenv's future native OTEL support (cachix/devenv#2415).
#   The same OTEL_EXPORTER_OTLP_ENDPOINT env var will work with both this module
#   and devenv's native OTEL when it lands.
#
# Shell helpers:
#   - otel-span: emit OTLP trace spans from shell scripts (see otel-span --help)
#   - otel health: diagnose the OTEL stack health (see otel health --help)
#
{
  # Fixed base port (null = derive from $DEVENV_ROOT hash)
  basePort ? null,
  # Port range for hash-based allocation (only used when basePort is null)
  portRangeStart ? 10000,
  portRangeEnd ? 60000,
  # Mode: "auto" detects system stack, "local" always uses local, "system" always uses system
  mode ? "auto",
}:
{
  pkgs,
  config,
  lib,
  ...
}:
let
  # Data directory for Tempo and Grafana state
  dataDir = "${config.devenv.root}/.devenv/otel";
  # Spool directory for otel-span file-based span delivery
  spoolDir = "${dataDir}/spool";

  # =========================================================================
  # Grafonnet: build dashboards from Jsonnet source at Nix eval time
  # =========================================================================

  grafonnetSrc = pkgs.fetchFromGitHub {
    owner = "grafana";
    repo = "grafonnet";
    rev = "7380c9c64fb973f34c3ec46265621a2b0dee0058";
    sha256 = "sha256-WS3Z/k9fDSleK6RVPTFQ9Um26GRFv/kxZhARXpGkS10=";
  };

  # Grafonnet's transitive dependencies (jsonnet-bundler style imports)
  xtdSrc = pkgs.fetchFromGitHub {
    owner = "jsonnet-libs";
    repo = "xtd";
    rev = "4d7f8cb24d613430799f9d56809cc6964f35cea9";
    sha256 = "sha256-MWinI7gX39UIDVh9kzkHFH6jsKZoI294paQUWd/4+ag=";
  };

  docsonnetSrc = pkgs.fetchFromGitHub {
    owner = "jsonnet-libs";
    repo = "docsonnet";
    rev = "6ac6c69685b8c29c54515448eaca583da2d88150";
    sha256 = "sha256-Uy86lIQbFjebNiAAp0dJ8rAtv16j4V4pXMPcl+llwBA=";
  };

  dashboardsSrcDir = ./otel/dashboards;

  # Create a JPATH root so `github.com/...` vendored imports resolve correctly.
  # Grafonnet and its deps use jsonnet-bundler style import paths.
  grafonnetJpath = pkgs.linkFarm "grafonnet-jpath" [
    {
      name = "github.com/grafana/grafonnet";
      path = grafonnetSrc;
    }
    {
      name = "github.com/jsonnet-libs/xtd";
      path = xtdSrc;
    }
    {
      name = "github.com/jsonnet-libs/docsonnet";
      path = docsonnetSrc;
    }
  ];

  # Build a single dashboard from Jsonnet source
  buildDashboard =
    name:
    pkgs.runCommand "grafana-dashboard-${name}"
      {
        nativeBuildInputs = [ pkgs.go-jsonnet ];
      }
      ''
        mkdir -p $out
        jsonnet \
          -J ${grafonnetJpath} \
          -J ${grafonnetSrc} \
          -J ${dashboardsSrcDir} \
          ${dashboardsSrcDir}/${name}.jsonnet \
          -o $out/${name}.json
      '';

  # All dashboards as a linkFarm (Nix store path with JSON files)
  # NOTE: dashboardNames order determines build; add/remove to force rebuild
  dashboardNames = [
    "overview"
    "dt-tasks"
    "dt-duration-trends"
    "shell-entry"
    "pnpm-install"
    "ts-app-traces"
  ];
  allDashboards = pkgs.linkFarm "otel-dashboards" (
    map (name: {
      name = "${name}.json";
      path = "${buildDashboard name}/${name}.json";
    }) dashboardNames
  );

  # Grafana dashboard provisioning config
  grafanaDashboardProvision = pkgs.writeText "grafana-dashboards.yaml" ''
    apiVersion: 1
    providers:
      - name: otel
        type: file
        disableDeletion: true
        updateIntervalSeconds: 0
        options:
          path: ${allDashboards}
  '';

  # =========================================================================
  # Port allocation: deterministic hash-based ports from DEVENV_ROOT
  # =========================================================================
  #
  # We need 6 consecutive ports:
  #   +0: OTEL Collector OTLP HTTP receiver (4318-equivalent)
  #   +1: Tempo OTLP gRPC ingest (for collector -> tempo)
  #   +2: Tempo HTTP query API (for Grafana -> tempo)
  #   +3: Grafana HTTP UI
  #   +4: OTEL Collector internal metrics (replaces default 8888)
  #   +5: Tempo internal gRPC (replaces default 9095)
  #
  # When basePort is null, we hash the devenv root path to get a deterministic
  # base in [portRangeStart, portRangeEnd-6]. Same worktree = same ports always.
  portRange = portRangeEnd - portRangeStart - 6;
  pathHash = builtins.hashString "sha256" config.devenv.root;
  # Convert hex char to int (0-15)
  hexCharToInt =
    c:
    let
      chars = [
        "0"
        "1"
        "2"
        "3"
        "4"
        "5"
        "6"
        "7"
        "8"
        "9"
        "a"
        "b"
        "c"
        "d"
        "e"
        "f"
      ];
      findIdx =
        i:
        if i >= 16 then
          0
        else if builtins.elemAt chars i == c then
          i
        else
          findIdx (i + 1);
    in
    findIdx 0;
  # Take first 7 hex chars -> convert to int -> mod into port range
  # (7 hex chars = max 268M, fits in Nix int; 8 might overflow on 32-bit)
  hexChars = lib.stringToCharacters (builtins.substring 0 7 pathHash);
  hashInt = lib.mod (builtins.foldl' (acc: c: acc * 16 + hexCharToInt c) 0 hexChars) portRange;
  derivedBasePort = portRangeStart + hashInt;
  effectiveBasePort = if basePort != null then basePort else derivedBasePort;

  otelCollectorPort = effectiveBasePort;
  tempoOtlpPort = effectiveBasePort + 1;
  tempoQueryPort = effectiveBasePort + 2;
  grafanaPort = effectiveBasePort + 3;
  otelMetricsPort = effectiveBasePort + 4;
  tempoInternalGrpcPort = effectiveBasePort + 5;

  # =========================================================================
  # Config files (generated at Nix eval time, written to /nix/store)
  # =========================================================================

  # OTEL Collector config: receives OTLP/HTTP, exports to Tempo via OTLP/gRPC
  otelCollectorConfig = pkgs.writeText "otel-collector-config.yaml" ''
    receivers:
      otlp:
        protocols:
          http:
            endpoint: "127.0.0.1:${toString otelCollectorPort}"
      otlpjsonfile:
        include:
          - "${spoolDir}/*.jsonl"
        start_at: beginning
        poll_interval: 500ms
        delete_after_read: true
        storage: file_storage/spool

    processors:
      batch:
        timeout: 1s
        send_batch_size: 128

    exporters:
      otlp:
        endpoint: "127.0.0.1:${toString tempoOtlpPort}"
        tls:
          insecure: true

    extensions:
      file_storage/spool:
        directory: ${dataDir}/spool-offsets

    service:
      extensions: [file_storage/spool]
      telemetry:
        metrics:
          readers:
            - pull:
                exporter:
                  prometheus:
                    host: "127.0.0.1"
                    port: ${toString otelMetricsPort}
      pipelines:
        traces:
          receivers: [otlp, otlpjsonfile]
          processors: [batch]
          exporters: [otlp]
  '';

  # Tempo config: receives from collector, stores to local filesystem
  tempoConfig = pkgs.writeText "tempo-config.yaml" ''
    server:
      http_listen_address: "127.0.0.1"
      http_listen_port: ${toString tempoQueryPort}
      grpc_listen_address: "127.0.0.1"
      grpc_listen_port: ${toString tempoInternalGrpcPort}

    distributor:
      receivers:
        otlp:
          protocols:
            grpc:
              endpoint: "127.0.0.1:${toString tempoOtlpPort}"

    # Optimized for low-scale local dev: prioritize search latency over throughput.
    # Traces become searchable in ~2-4s instead of the default 6-11s.
    ingester:
      # How often the ingester sweeps traces through the pipeline (default: 10s).
      # Primary bottleneck for search latency — reduced to match trace_idle_period.
      flush_check_period: 2s
      # Time after last span before a trace is flushed to WAL (default: 5s).
      # Lower means completed traces appear in WAL-based search sooner.
      trace_idle_period: 2s
      # Max time a trace stays in the head block before forced WAL flush (default: 30m).
      # Head block is searched synchronously, so this mainly affects WAL visibility.
      max_block_duration: 5m
      # Max head block size before cutting a new one (default: 500MB).
      # Keeps blocks small for faster search at low throughput.
      max_block_bytes: 10000000
      # How long completed blocks stay in the ingester before backend flush (default: 15m).
      # Shorter for dev since we don't need long ingester retention.
      complete_block_timeout: 5m

    memberlist:
      bind_addr:
        - "127.0.0.1"

    query_frontend:
      search:
        # Don't search the slow backend storage for traces newer than 30m (default: 15m).
        # Forces recent searches to use the fast ingester path only.
        query_backend_after: 30m

    storage:
      trace:
        backend: local
        local:
          path: ${dataDir}/tempo-data
        wal:
          path: ${dataDir}/tempo-wal
        # How often to poll backend for new blocks (default: 5m).
        # Faster discovery of flushed blocks for search.
        blocklist_poll: 30s

    compactor:
      compaction:
        block_retention: 72h

    metrics_generator:
      processor:
        local_blocks:
          # flush_to_storage: true is required for TraceQL metrics queries on historical data.
          # Without this, metrics queries only work on very recent in-memory data.
          flush_to_storage: true
          # Include all spans, not just server spans (default filters to server only)
          filter_server_spans: false
      storage:
        path: ${dataDir}/tempo-metrics
      traces_storage:
        path: ${dataDir}/tempo-data

    overrides:
      defaults:
        metrics_generator:
          processors:
            - local-blocks
  '';

  # Grafana provisioning: auto-configure Tempo as a datasource
  # Grafana datasource provisioning with stable UID.
  # The deleteDatasources + datasources pattern ensures the UID is always "tempo",
  # even if Grafana previously auto-generated a different one. On each startup,
  # Grafana deletes the old datasource by name+orgId, then re-creates it with our UID.
  grafanaDatasources = pkgs.writeText "grafana-datasources.yaml" ''
    apiVersion: 1
    deleteDatasources:
      - name: Tempo
        orgId: 1
    datasources:
      - name: Tempo
        uid: tempo
        type: tempo
        access: proxy
        url: http://127.0.0.1:${toString tempoQueryPort}
        isDefault: true
        editable: false
        jsonData:
          traceqlMetrics: true
  '';

  grafanaIni = pkgs.writeText "grafana.ini" ''
    [server]
    http_addr = 0.0.0.0
    http_port = ${toString grafanaPort}
    root_url = http://127.0.0.1:${toString grafanaPort}

    [paths]
    data = ${dataDir}/grafana-data
    logs = ${dataDir}/grafana-logs
    plugins = ${dataDir}/grafana-plugins
    provisioning = ${dataDir}/grafana-provisioning

    [auth.anonymous]
    enabled = true
    org_role = Admin

    [security]
    admin_user = admin
    admin_password = admin

    [analytics]
    reporting_enabled = false
    check_for_updates = false
    check_for_plugin_updates = false

    [log]
    mode = console
    level = warn

    [unified_alerting]
    enabled = false

    [alerting]
    enabled = false
  '';

  # =========================================================================
  # otel-emit-span: low-level helper that delivers an OTLP JSON payload
  # =========================================================================
  #
  # Reads one OTLP JSON object from stdin and delivers it via:
  #   1. Spool file (if OTEL_SPAN_SPOOL_DIR is set and exists) — compact JSONL
  #   2. HTTP POST fallback to OTEL_EXPORTER_OTLP_ENDPOINT
  #
  otelEmitSpan = pkgs.writeShellScriptBin "otel-emit-span" ''
    set -euo pipefail
    payload=$(cat)
    _spool_dir="''${OTEL_SPAN_SPOOL_DIR:-}"
    if [ -n "$_spool_dir" ] && [ -d "$_spool_dir" ]; then
      if [ "''${OTEL_SPOOL_MULTI_WRITER:-}" = "1" ]; then
        # Atomic unique file (system-level, multi-writer safe)
        _tmp=$(mktemp "$_spool_dir/.tmp.XXXXXXXXXX")
        printf '%s\n' "$payload" | ${pkgs.jq}/bin/jq -c . > "$_tmp"
        mv "$_tmp" "''${_spool_dir}/$(date +%s%N)-$$.jsonl"
      else
        # Single file append (local devenv, single-writer)
        printf '%s\n' "$payload" | ${pkgs.jq}/bin/jq -c . >> "$_spool_dir/spans.jsonl"
      fi
    else
      _endpoint="''${OTEL_EXPORTER_OTLP_ENDPOINT:-}"
      if [ -n "$_endpoint" ]; then
        ${pkgs.curl}/bin/curl -s -X POST \
          "$_endpoint/v1/traces" \
          -H "Content-Type: application/json" \
          -d "$payload" \
          --max-time 2 \
          >/dev/null 2>&1 || true
      fi
    fi
  '';

  # =========================================================================
  # otel-span: shell helper for emitting OTLP trace spans from bash
  # =========================================================================
  #
  # This is the OTEL compat layer for shell scripts. It writes OTLP JSON
  # to a spool file for the collector's otlpjsonfilereceiver to pick up.
  # Falls back to curl POST if the spool dir is not available.
  #
  # Usage:
  #   otel-span <service-name> <span-name> -- <command> [args...]
  #   otel-span --help
  #
  # Example:
  #   otel-span "dt" "pnpm:install" -- pnpm install
  #   otel-span "dt" "ts:check" --attr "cached=true" -- tsc --noEmit
  #
  # The span will include:
  #   - duration (start/end timestamps)
  #   - exit code as status
  #   - custom attributes via --attr key=value
  #   - parent trace context via TRACEPARENT env var (W3C Trace Context)
  #
  otelSpan = pkgs.writeShellScriptBin "otel-span" ''
    set -euo pipefail

    usage() {
      cat <<'USAGE'
    Usage: otel-span <service-name> <span-name> [options] -- <command> [args...]

    Wraps a command execution in an OTLP trace span and sends it to the
    OTEL Collector at $OTEL_EXPORTER_OTLP_ENDPOINT.

    Options:
      --attr KEY=VALUE      Add a span attribute (repeatable)
      --trace-id ID         Use specific trace ID (default: from TRACEPARENT or random)
      --span-id ID          Use specific span ID (default: random)
      --parent-span-id ID   Use specific parent span ID (default: from TRACEPARENT)
      --start-time-ns NS    Override start timestamp in nanoseconds (default: now)
      --end-time-ns NS      Override end timestamp in nanoseconds (default: now after command)
      --log-url             Print Grafana trace URL to stderr after span emission
      --help                Show this help

    Environment:
      OTEL_EXPORTER_OTLP_ENDPOINT  Collector endpoint (required)
      TRACEPARENT                   W3C Trace Context parent (optional)

    Examples:
      otel-span dt pnpm:install -- pnpm install
      otel-span dt ts:check --attr cached=true -- tsc --noEmit
    USAGE
      exit 0
    }

    # Parse arguments
    SERVICE_NAME=""
    SPAN_NAME=""
    ATTRS=()
    TRACE_ID=""
    SPAN_ID=""
    PARENT_SPAN_ID=""
    START_TIME_NS=""
    END_TIME_NS=""
    LOG_URL=""
    CMD_ARGS=()

    while [[ $# -gt 0 ]]; do
      case "$1" in
        --help) usage ;;
        --attr)
          ATTRS+=("$2")
          shift 2
          ;;
        --trace-id)
          TRACE_ID="$2"
          shift 2
          ;;
        --span-id)
          SPAN_ID="$2"
          shift 2
          ;;
        --parent-span-id)
          PARENT_SPAN_ID="$2"
          shift 2
          ;;
        --start-time-ns)
          START_TIME_NS="$2"
          shift 2
          ;;
        --end-time-ns)
          END_TIME_NS="$2"
          shift 2
          ;;
        --log-url)
          LOG_URL="1"
          shift
          ;;
        --)
          shift
          CMD_ARGS=("$@")
          break
          ;;
        *)
          if [[ -z "$SERVICE_NAME" ]]; then
            SERVICE_NAME="$1"
          elif [[ -z "$SPAN_NAME" ]]; then
            SPAN_NAME="$1"
          else
            echo "otel-span: unexpected argument: $1" >&2
            exit 1
          fi
          shift
          ;;
      esac
    done

    if [[ -z "$SERVICE_NAME" ]] || [[ -z "$SPAN_NAME" ]] || [[ ''${#CMD_ARGS[@]} -eq 0 ]]; then
      echo "otel-span: missing required arguments" >&2
      echo "Usage: otel-span <service-name> <span-name> [options] -- <command> [args...]" >&2
      exit 1
    fi

    ENDPOINT="''${OTEL_EXPORTER_OTLP_ENDPOINT:-}"
    if [[ -z "$ENDPOINT" ]]; then
      # No collector configured - just run the command directly
      exec "''${CMD_ARGS[@]}"
    fi

    # Generate IDs
    gen_hex() {
      local len=$1
      ${pkgs.coreutils}/bin/od -An -tx1 -N"$len" /dev/urandom | tr -d ' \n'
    }

    # Parse TRACEPARENT (W3C Trace Context: version-traceid-parentid-flags)
    if [[ -n "''${TRACEPARENT:-}" ]]; then
      IFS='-' read -r _tp_ver _tp_trace _tp_parent _tp_flags <<< "$TRACEPARENT"
      TRACE_ID="''${TRACE_ID:-$_tp_trace}"
      PARENT_SPAN_ID="''${PARENT_SPAN_ID:-$_tp_parent}"
    fi

    TRACE_ID="''${TRACE_ID:-$(gen_hex 16)}"
    SPAN_ID="''${SPAN_ID:-$(gen_hex 8)}"

    # Export TRACEPARENT for child processes
    export TRACEPARENT="00-$TRACE_ID-$SPAN_ID-01"

    # Timestamps in nanoseconds (--start-time-ns overrides for retroactive root spans)
    start_ns="''${START_TIME_NS:-$(${pkgs.coreutils}/bin/date +%s%N)}"

    # Run the command
    exit_code=0
    "''${CMD_ARGS[@]}" || exit_code=$?

    end_ns="''${END_TIME_NS:-$(${pkgs.coreutils}/bin/date +%s%N)}"

    # Build attributes JSON
    attrs_json='[{"key":"service.name","value":{"stringValue":"'"$SERVICE_NAME"'"}}'
    attrs_json+=',{"key":"exit.code","value":{"intValue":"'"$exit_code"'"}}'
    attrs_json+=',{"key":"devenv.root","value":{"stringValue":"'"$DEVENV_ROOT"'"}}'
    for attr in "''${ATTRS[@]}"; do
      key="''${attr%%=*}"
      val="''${attr#*=}"
      attrs_json+=',{"key":"'"$key"'","value":{"stringValue":"'"$val"'"}}'
    done
    attrs_json+=']'

    # OTLP status: OK (1) for exit 0, ERROR (2) for non-zero
    if [[ "$exit_code" -eq 0 ]]; then
      status_json='{"code":1}'
    else
      status_json='{"code":2,"message":"exit code '"$exit_code"'"}'
    fi

    # Parent span ID field (omit if no parent)
    parent_json=""
    if [[ -n "''${PARENT_SPAN_ID:-}" ]]; then
      parent_json='"parentSpanId":"'"$PARENT_SPAN_ID"'",'
    fi

    # Build OTLP JSON payload
    payload='{
      "resourceSpans": [{
        "resource": {
          "attributes": [
            {"key": "service.name", "value": {"stringValue": "'"$SERVICE_NAME"'"}},
            {"key": "devenv.root", "value": {"stringValue": "'"$DEVENV_ROOT"'"}}
          ]
        },
        "scopeSpans": [{
          "scope": {"name": "otel-span"},
          "spans": [{
            "traceId": "'"$TRACE_ID"'",
            "spanId": "'"$SPAN_ID"'",
            '"$parent_json"'
            "name": "'"$SPAN_NAME"'",
            "kind": 1,
            "startTimeUnixNano": "'"$start_ns"'",
            "endTimeUnixNano": "'"$end_ns"'",
            "attributes": '"$attrs_json"',
            "status": '"$status_json"'
          }]
        }]
      }]
    }'

    # Deliver span via otel-emit-span (spool file or HTTP fallback)
    printf '%s\n' "$payload" | ${otelEmitSpan}/bin/otel-emit-span

    # Print Grafana trace URL to stderr if --log-url was set
    if [ -n "$LOG_URL" ] && [ -n "''${OTEL_GRAFANA_URL:-}" ]; then
      _panes='{"a":{"datasource":{"type":"tempo","uid":"tempo"},"queries":[{"refId":"A","datasource":{"type":"tempo","uid":"tempo"},"queryType":"traceql","query":"'"$TRACE_ID"'"}],"range":{"from":"now-1h","to":"now"}}}'
      _encoded=$(printf '%s' "$_panes" | ${pkgs.gnused}/bin/sed 's/{/%7B/g;s/}/%7D/g;s/\[/%5B/g;s/\]/%5D/g;s/"/%22/g;s/:/%3A/g;s/,/%2C/g;s/ /%20/g')
      _url="$OTEL_GRAFANA_URL/explore?schemaVersion=1&panes=$_encoded&orgId=1"
      # Rewrite localhost to Tailscale hostname for remote dev servers
      if [ -n "''${TS_HOSTNAME:-}" ]; then
        _url="''${_url//127.0.0.1/$TS_HOSTNAME}"
      fi
      _trace_label="trace:$TRACE_ID"
      if [ -t 2 ]; then
        printf '[otel] \e]8;;%s\x07\e[4m%s\e[24m\e]8;;\x07\n' "$_url" "$_trace_label" >&2
      else
        printf '[otel] %s %s\n' "$_trace_label" "$_url" >&2
      fi
    fi

    exit "$exit_code"
  '';

  # Whether to include local OTEL infrastructure (collector, tempo, grafana processes)
  needsLocalInfra = mode != "system";

in
{
  packages =
    [ otelEmitSpan otelSpan ]
    ++ lib.optionals needsLocalInfra [
      pkgs.opentelemetry-collector-contrib
      pkgs.tempo
      pkgs.grafana
    ];

  # Default env vars point to local stack; enterShell overrides for system/auto mode
  env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:${toString otelCollectorPort}";
  env.OTEL_GRAFANA_URL = "http://127.0.0.1:${toString grafanaPort}";
  env.OTEL_SPAN_SPOOL_DIR = spoolDir;
  env.OTEL_MODE = mode;
  # Nix store path to compiled dashboard JSON files (built from jsonnet at eval time)
  env.OTEL_DASHBOARDS_DIR = "${allDashboards}";

  # mkAfter ensures this runs after setup.nix's task execution and load-exports
  # sourcing, so TRACEPARENT (from setup:gate) is available regardless of import order.
  enterShell = lib.mkAfter ''
    # ── Mode detection ──────────────────────────────────────────────────
    # Resolve "auto" to "system" or "local" at runtime by probing for the
    # system-level OTEL stack (home-manager otel-stack module).
    if [ "$OTEL_MODE" = "auto" ]; then
      if [ -d "$HOME/.otel/spool" ] || \
         ${pkgs.curl}/bin/curl -sf --max-time 0.5 http://127.0.0.1:4318/ >/dev/null 2>&1; then
        OTEL_MODE="system"
      else
        OTEL_MODE="local"
      fi
    fi

    if [ "$OTEL_MODE" = "system" ]; then
      # Override env vars to point to the system-level stack
      export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318"
      export OTEL_GRAFANA_URL="http://127.0.0.1:3000"
      export OTEL_SPAN_SPOOL_DIR="''${XDG_RUNTIME_DIR:-/tmp}/otel/spool"
      export OTEL_SPOOL_MULTI_WRITER="1"
      echo "[otel] Using system-level OTEL stack (mode=$OTEL_MODE)"
    else
      echo "[otel] Using local devenv OTEL stack (mode=$OTEL_MODE)"
    fi

    _otel_grafana="$OTEL_GRAFANA_URL"
    if [ -n "''${TS_HOSTNAME:-}" ]; then
      _otel_grafana="''${_otel_grafana//127.0.0.1/$TS_HOSTNAME}"
    fi
    # Build Grafana link: trace-specific when TRACEPARENT is available, dashboard otherwise
    if [ -n "''${TRACEPARENT:-}" ]; then
      IFS='-' read -r _ _otel_trace_id _ _ <<< "$TRACEPARENT"
      _panes='{"a":{"datasource":{"type":"tempo","uid":"tempo"},"queries":[{"refId":"A","datasource":{"type":"tempo","uid":"tempo"},"queryType":"traceql","query":"'"$_otel_trace_id"'"}],"range":{"from":"now-1h","to":"now"}}}'
      _encoded=$(printf '%s' "$_panes" | sed 's/{/%7B/g;s/}/%7D/g;s/\[/%5B/g;s/\]/%5D/g;s/"/%22/g;s/:/%3A/g;s/,/%2C/g;s/ /%20/g')
      _grafana_link_url="$_otel_grafana/explore?schemaVersion=1&panes=$_encoded&orgId=1"
    else
      _grafana_link_url="$_otel_grafana"
    fi
    if [ -n "''${_otel_trace_id:-}" ]; then
      _trace_label="trace:$_otel_trace_id"
    else
      _trace_label="grafana"
    fi
    if [ -t 1 ]; then
      _grafana_display="$(printf '\e]8;;%s\x07\e[4m%s\e[24m\e]8;;\x07' "$_grafana_link_url" "$_trace_label")"
    else
      _grafana_display="$_trace_label $_grafana_link_url"
    fi
    echo "[otel] Start with: devenv up | $_grafana_display"

    # Detect cold vs warm start (setup-git-hash written by setup.nix)
    _cold_start="false"
    if [ ! -f .direnv/task-cache/setup-git-hash ]; then
      _cold_start="true"
    elif [ "$(git rev-parse HEAD 2>/dev/null || echo no-git)" != "$(cat .direnv/task-cache/setup-git-hash 2>/dev/null || echo "")" ]; then
      _cold_start="true"
    fi

    # Detect what triggered this shell reload by comparing watched file mtimes.
    # Uses devenv's input-paths.txt (nix inputs that affect the shell derivation),
    # excluding .devenv/bootstrap/ files which are regenerated on every eval.
    # xargs stat is ~2ms for ~50 files — negligible overhead.
    _reload_trigger="unknown"
    _otel_mtime_snapshot=".direnv/otel-watch-mtimes"
    if [ -f ".devenv/input-paths.txt" ]; then
      _otel_current=$(grep -v '\.devenv/bootstrap/' .devenv/input-paths.txt \
        | xargs stat -c '%Y %n' 2>/dev/null | sort -k2)
      if [ ! -f "$_otel_mtime_snapshot" ]; then
        _reload_trigger="initial"
      elif [ "$_otel_current" = "$(cat "$_otel_mtime_snapshot" 2>/dev/null)" ]; then
        _reload_trigger="env-change"
      else
        _otel_changed=$(diff <(cat "$_otel_mtime_snapshot") <(echo "$_otel_current") 2>/dev/null \
          | grep '^[<>]' | awk '{print $NF}' | sort -u \
          | sed "s|^''${DEVENV_ROOT:-.}/||" \
          | head -5 | paste -sd ',' -)
        _reload_trigger="''${_otel_changed:-unknown}"
      fi
      mkdir -p .direnv
      echo "$_otel_current" > "$_otel_mtime_snapshot"
    fi

    # Emit root shell:entry span covering the full setup duration.
    # TRACEPARENT and OTEL_SHELL_ENTRY_NS are propagated from setup:gate via
    # devenv's native task output -> env mechanism (devenv.env convention).
    if command -v otel-span >/dev/null 2>&1 \
      && [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ] \
      && [ -n "''${TRACEPARENT:-}" ] \
      && [ -n "''${OTEL_SHELL_ENTRY_NS:-}" ]; then
      IFS='-' read -r _ _trace_id _span_id _ <<< "$TRACEPARENT"
      (
        unset TRACEPARENT
        otel-span "devenv" "shell:entry" \
          --trace-id "$_trace_id" \
          --span-id "$_span_id" \
          --start-time-ns "$OTEL_SHELL_ENTRY_NS" \
          --end-time-ns "$(date +%s%N)" \
          --attr "cold_start=$_cold_start" \
          --attr "reload.trigger=$_reload_trigger" \
          -- true
      ) || true
    fi

    # Mark the moment the shell becomes interactive (after all setup + OTEL work).
    # Consumed by dt.nix for the shell.ready_ms span attribute.
    export SHELL_ENTRY_TIME_NS=$(date +%s%N)
  '';

  # =========================================================================
  # Processes (started via `devenv up`)
  # =========================================================================

  # Process names include port for visibility in process-compose TUI
  # Processes are only defined when running in local mode (auto also needs them as fallback)
  processes = lib.mkIf needsLocalInfra {
    "otel-collector-${toString otelCollectorPort}" = {
      exec = ''
        mkdir -p ${spoolDir} ${dataDir}/spool-offsets
        exec ${pkgs.opentelemetry-collector-contrib}/bin/otelcol-contrib \
          --config ${otelCollectorConfig} \
          --feature-gates=filelog.allowFileDeletion
      '';
    };

    "tempo-${toString tempoQueryPort}" = {
      exec = ''
        mkdir -p ${dataDir}/tempo-data ${dataDir}/tempo-wal ${dataDir}/tempo-metrics
        exec ${pkgs.tempo}/bin/tempo \
          -config.file ${tempoConfig}
      '';
      # Auto-restart on WAL corruption: Tempo's /ready stays healthy even when
      # WAL files are missing, so we probe the search API which exercises the
      # storage path and returns 500 when the WAL is corrupt.
      # Auto-restart on WAL corruption: Tempo's /ready stays healthy even when
      # WAL files are missing, so we probe the search API which exercises the
      # storage path and returns 500 when the WAL is corrupt.
      # Readiness probe failures trigger restart via availability policy.
      process-compose = {
        readiness_probe = {
          exec.command = "${pkgs.curl}/bin/curl -sf http://127.0.0.1:${toString tempoQueryPort}/api/search/tag/service.name/values -o /dev/null";
          initial_delay_seconds = 15;
          period_seconds = 30;
          timeout_seconds = 5;
          success_threshold = 1;
          failure_threshold = 3;
        };
        availability = {
          restart = "always";
          backoff_seconds = 3;
          max_restarts = 10;
        };
      };
    };

    "grafana-${toString grafanaPort}" = {
      exec = ''
        mkdir -p ${dataDir}/grafana-data ${dataDir}/grafana-logs ${dataDir}/grafana-plugins
        mkdir -p ${dataDir}/grafana-provisioning/datasources ${dataDir}/grafana-provisioning/dashboards
        install -m 644 ${grafanaDatasources} ${dataDir}/grafana-provisioning/datasources/tempo.yaml
        install -m 644 ${grafanaDashboardProvision} ${dataDir}/grafana-provisioning/dashboards/otel.yaml
        exec ${pkgs.grafana}/bin/grafana server \
          --config ${grafanaIni} \
          --homepath ${pkgs.grafana}/share/grafana
      '';
    };
  };

  # =========================================================================
  # Tasks
  # =========================================================================

  tasks."otel:test" = {
    description = "Run otel-span shell-level unit tests (offline, no devenv up needed)";
    exec = ''
      set -euo pipefail
      _pass=0
      _fail=0
      _tmp=$(mktemp -d)
      trap 'rm -rf "$_tmp"' EXIT

      _check() {
        local name="$1"
        shift
        if "$@"; then
          echo "PASS: $name"
          _pass=$((_pass + 1))
        else
          echo "FAIL: $name"
          _fail=$((_fail + 1))
        fi
      }

      # Test 1: JSON format validation
      _test_json_format() {
        local spool="$_tmp/json-test"
        mkdir -p "$spool"
        OTEL_SPAN_SPOOL_DIR="$spool" otel-span "test" "json-check" -- true >/dev/null 2>&1
        [ -f "$spool/spans.jsonl" ] || return 1
        local line
        line=$(head -1 "$spool/spans.jsonl")
        # Validate required OTLP fields
        echo "$line" | ${pkgs.jq}/bin/jq -e '.resourceSpans[0].scopeSpans[0].spans[0] | .traceId and .spanId and .name and .startTimeUnixNano and .endTimeUnixNano' >/dev/null 2>&1
      }
      _check "JSON format" _test_json_format

      # Test 2: TRACEPARENT propagation
      _test_traceparent() {
        local spool="$_tmp/tp-test"
        mkdir -p "$spool"
        local child_tp
        child_tp=$(OTEL_SPAN_SPOOL_DIR="$spool" otel-span "test" "parent" -- bash -c 'echo $TRACEPARENT' 2>/dev/null)
        # Must match W3C format: 00-{32hex}-{16hex}-01
        [[ "$child_tp" =~ ^00-[0-9a-f]{32}-[0-9a-f]{16}-01$ ]] || return 1
        # Trace ID in child must match the span's trace ID in the spool file
        local span_trace
        span_trace=$(head -1 "$spool/spans.jsonl" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].traceId')
        local child_trace
        child_trace=$(echo "$child_tp" | cut -d- -f2)
        [ "$span_trace" = "$child_trace" ]
      }
      _check "TRACEPARENT propagation" _test_traceparent

      # Test 3: Spool fallback (nonexistent dir)
      _test_spool_fallback() {
        # With nonexistent spool dir, should still succeed (falls back to curl which may fail silently)
        OTEL_SPAN_SPOOL_DIR="/nonexistent" OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:1" otel-span "test" "fallback" -- true >/dev/null 2>&1
      }
      _check "Spool fallback" _test_spool_fallback

      # Test 4: Spool file write
      _test_spool_write() {
        local spool="$_tmp/write-test"
        mkdir -p "$spool"
        OTEL_SPAN_SPOOL_DIR="$spool" otel-span "test" "write-check" -- true >/dev/null 2>&1
        [ -f "$spool/spans.jsonl" ] || return 1
        local lines
        lines=$(wc -l < "$spool/spans.jsonl")
        [ "$lines" -eq 1 ]
      }
      _check "Spool write" _test_spool_write

      # Test 5: --span-id override
      _test_span_id_override() {
        local spool="$_tmp/spanid-test"
        mkdir -p "$spool"
        OTEL_SPAN_SPOOL_DIR="$spool" otel-span "test" "spanid-check" --span-id "abcdef0123456789" -- true >/dev/null 2>&1
        [ -f "$spool/spans.jsonl" ] || return 1
        local actual
        actual=$(head -1 "$spool/spans.jsonl" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].spanId')
        [ "$actual" = "abcdef0123456789" ]
      }
      _check "--span-id override" _test_span_id_override

      # Test 6: --start-time-ns override
      _test_start_time_override() {
        local spool="$_tmp/startns-test"
        mkdir -p "$spool"
        OTEL_SPAN_SPOOL_DIR="$spool" otel-span "test" "startns-check" --start-time-ns "1234567890000000000" -- true >/dev/null 2>&1
        [ -f "$spool/spans.jsonl" ] || return 1
        local actual
        actual=$(head -1 "$spool/spans.jsonl" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].startTimeUnixNano')
        [ "$actual" = "1234567890000000000" ]
      }
      _check "--start-time-ns override" _test_start_time_override

      # Test 7: --end-time-ns override
      _test_end_time_override() {
        local spool="$_tmp/endns-test"
        mkdir -p "$spool"
        OTEL_SPAN_SPOOL_DIR="$spool" otel-span "test" "endns-check" --end-time-ns "9999999999999999999" -- true >/dev/null 2>&1
        [ -f "$spool/spans.jsonl" ] || return 1
        local actual
        actual=$(head -1 "$spool/spans.jsonl" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].endTimeUnixNano')
        [ "$actual" = "9999999999999999999" ]
      }
      _check "--end-time-ns override" _test_end_time_override

      # Test 8: --log-url outputs Grafana trace URL to stderr
      _test_log_url() {
        local spool="$_tmp/logurl-test"
        mkdir -p "$spool"
        local stderr_output
        stderr_output=$(OTEL_SPAN_SPOOL_DIR="$spool" OTEL_GRAFANA_URL="http://localhost:3000" otel-span "test" "url-check" --log-url -- true 2>&1 1>/dev/null)
        # Must contain [otel] Trace: prefix
        echo "$stderr_output" | grep -q '\[otel\] Trace:' || return 1
        # Must contain the Grafana explore URL
        echo "$stderr_output" | grep -q 'localhost:3000/explore' || return 1
        # Must contain the trace ID from the span
        local trace_id
        trace_id=$(head -1 "$spool/spans.jsonl" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].traceId')
        echo "$stderr_output" | grep -q "$trace_id" || return 1
      }
      _check "--log-url output" _test_log_url

      # Test 9: No TRACEPARENT produces root span (no parentSpanId)
      _test_no_traceparent_root() {
        local spool="$_tmp/root-test"
        mkdir -p "$spool"
        (
          unset TRACEPARENT
          OTEL_SPAN_SPOOL_DIR="$spool" otel-span "test" "root-check" -- true >/dev/null 2>&1
        )
        [ -f "$spool/spans.jsonl" ] || return 1
        # parentSpanId must be absent (not an orphaned reference)
        local has_parent
        has_parent=$(head -1 "$spool/spans.jsonl" | ${pkgs.jq}/bin/jq '.resourceSpans[0].scopeSpans[0].spans[0] | has("parentSpanId")')
        [ "$has_parent" = "false" ]
      }
      _check "No TRACEPARENT = root span" _test_no_traceparent_root

      echo ""
      echo "$_pass passed, $_fail failed"
      [ "$_fail" -eq 0 ]
    '';
  };

  tasks."otel:test:trace-structure" = {
    description = "Validate trace structure invariants from spool file data (offline)";
    exec = ''
      set -euo pipefail
      _pass=0
      _fail=0
      _tmp=$(mktemp -d)
      trap 'rm -rf "$_tmp"' EXIT

      _check() {
        local name="$1"
        shift
        if "$@"; then
          echo "PASS: $name"
          _pass=$((_pass + 1))
        else
          echo "FAIL: $name"
          _fail=$((_fail + 1))
        fi
      }

      # Helper functions for span field extraction, count, IDs
      _span_field() {
        local file="$1" line_num="$2" field="$3"
        ${pkgs.gawk}/bin/awk "NR==$line_num" "$file" | ${pkgs.jq}/bin/jq -r ".resourceSpans[0].scopeSpans[0].spans[0].$field"
      }
      _span_count() {
        local file="$1"
        wc -l < "$file" | tr -d ' '
      }
      _all_span_ids() {
        local file="$1"
        ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].spanId' "$file"
      }
      _all_parent_ids() {
        local file="$1"
        ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].parentSpanId // ""' "$file"
      }

      # Generate 5-span trace tree with explicit IDs
      _spool="$_tmp/trace-struct"
      mkdir -p "$_spool"
      _trace_id="aabbccdd11223344aabbccdd11223344"

      # Root span (no parent)
      (unset TRACEPARENT; OTEL_SPAN_SPOOL_DIR="$_spool" otel-span "devenv" "shell:entry" --trace-id "$_trace_id" --span-id "0000000000000001" --start-time-ns "1000000000000000" --end-time-ns "11000000000000000" -- true >/dev/null 2>&1)

      # Child 1 of root
      OTEL_SPAN_SPOOL_DIR="$_spool" otel-span "dt-task" "ts:check" --trace-id "$_trace_id" --span-id "0000000000000002" --parent-span-id "0000000000000001" --start-time-ns "1100000000000000" --end-time-ns "6000000000000000" -- true >/dev/null 2>&1

      # Grandchild 1 of child 1
      OTEL_SPAN_SPOOL_DIR="$_spool" otel-span "tsc-project" "utils" --trace-id "$_trace_id" --span-id "0000000000000003" --parent-span-id "0000000000000002" --start-time-ns "1200000000000000" --end-time-ns "4000000000000000" -- true >/dev/null 2>&1

      # Grandchild 2 of child 1
      OTEL_SPAN_SPOOL_DIR="$_spool" otel-span "tsc-project" "core" --trace-id "$_trace_id" --span-id "0000000000000004" --parent-span-id "0000000000000002" --start-time-ns "4100000000000000" --end-time-ns "5800000000000000" -- true >/dev/null 2>&1

      # Child 2 of root
      OTEL_SPAN_SPOOL_DIR="$_spool" otel-span "dt-task" "lint:check" --trace-id "$_trace_id" --span-id "0000000000000005" --parent-span-id "0000000000000001" --start-time-ns "1200000000000000" --end-time-ns "4000000000000000" -- true >/dev/null 2>&1

      _sf="$_spool/spans.jsonl"

      # Test 1: correct span count
      _test_span_count() {
        [ "$(_span_count "$_sf")" -eq 5 ]
      }
      _check "5 spans emitted" _test_span_count

      # Test 2: all spans share the same traceId
      _test_same_trace_id() {
        local unique
        unique=$(_all_span_ids "$_sf" | wc -l)
        local trace_ids
        trace_ids=$(${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].traceId' "$_sf" | sort -u | wc -l)
        [ "$trace_ids" -eq 1 ]
      }
      _check "all spans share traceId" _test_same_trace_id

      # Test 3: exactly one root span (no parentSpanId)
      _test_single_root() {
        local roots
        roots=$(${pkgs.jq}/bin/jq -r 'if .resourceSpans[0].scopeSpans[0].spans[0] | has("parentSpanId") then "child" else "root" end' "$_sf" | grep -c "root")
        [ "$roots" -eq 1 ]
      }
      _check "single root span" _test_single_root

      # Test 4: no orphan spans (every parentSpanId references an existing spanId)
      _test_no_orphans() {
        local span_ids parent_ids
        span_ids=$(_all_span_ids "$_sf")
        parent_ids=$(_all_parent_ids "$_sf" | grep -v '^$' || true)
        while IFS= read -r pid; do
          echo "$span_ids" | grep -qF "$pid" || return 1
        done <<< "$parent_ids"
        return 0
      }
      _check "no orphan spans" _test_no_orphans

      # Test 5: root span encloses all children (timing)
      _test_root_timing() {
        local root_start root_end
        root_start=$(_span_field "$_sf" 1 "startTimeUnixNano")
        root_end=$(_span_field "$_sf" 1 "endTimeUnixNano")
        for i in 2 3 4 5; do
          local s e
          s=$(_span_field "$_sf" "$i" "startTimeUnixNano")
          e=$(_span_field "$_sf" "$i" "endTimeUnixNano")
          [ "$s" -ge "$root_start" ] || return 1
          [ "$e" -le "$root_end" ] || return 1
        done
        return 0
      }
      _check "root encloses all children" _test_root_timing

      # Test 6: parent-child timing (child within parent)
      _test_parent_child_timing() {
        # child 1 (line 2, parent=line 1)
        local p_start p_end c_start c_end
        p_start=$(_span_field "$_sf" 1 "startTimeUnixNano")
        p_end=$(_span_field "$_sf" 1 "endTimeUnixNano")
        c_start=$(_span_field "$_sf" 2 "startTimeUnixNano")
        c_end=$(_span_field "$_sf" 2 "endTimeUnixNano")
        [ "$c_start" -ge "$p_start" ] && [ "$c_end" -le "$p_end" ] || return 1
        # grandchild 1 (line 3, parent=line 2)
        p_start=$(_span_field "$_sf" 2 "startTimeUnixNano")
        p_end=$(_span_field "$_sf" 2 "endTimeUnixNano")
        c_start=$(_span_field "$_sf" 3 "startTimeUnixNano")
        c_end=$(_span_field "$_sf" 3 "endTimeUnixNano")
        [ "$c_start" -ge "$p_start" ] && [ "$c_end" -le "$p_end" ] || return 1
        return 0
      }
      _check "parent-child timing valid" _test_parent_child_timing

      # Test 7: no duplicate span IDs
      _test_no_duplicate_ids() {
        local total unique
        total=$(_all_span_ids "$_sf" | wc -l)
        unique=$(_all_span_ids "$_sf" | sort -u | wc -l)
        [ "$total" -eq "$unique" ]
      }
      _check "no duplicate spanIds" _test_no_duplicate_ids

      # Test 8: detect orphan (negative test — inject an orphan and verify detection)
      _test_detect_orphan() {
        local orphan_spool="$_tmp/orphan-test"
        mkdir -p "$orphan_spool"
        # Emit a span with a parentSpanId that doesn't exist
        OTEL_SPAN_SPOOL_DIR="$orphan_spool" otel-span "test" "orphan" --trace-id "$_trace_id" --span-id "0000000000000099" --parent-span-id "DOES_NOT_EXIST_00" --start-time-ns "2000000000000000" --end-time-ns "3000000000000000" -- true >/dev/null 2>&1
        local of="$orphan_spool/spans.jsonl"
        local span_ids parent_ids
        span_ids=$(_all_span_ids "$of")
        parent_ids=$(_all_parent_ids "$of" | grep -v '^$' || true)
        # The orphan's parent should NOT be in span_ids — so this check should fail
        while IFS= read -r pid; do
          if ! echo "$span_ids" | grep -qF "$pid"; then
            return 0  # correctly detected orphan
          fi
        done <<< "$parent_ids"
        return 1  # failed to detect orphan
      }
      _check "detect orphan (negative test)" _test_detect_orphan

      echo ""
      echo "$_pass passed, $_fail failed"
      [ "$_fail" -eq 0 ]
    '';
  };
}
