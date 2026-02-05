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
#   - otel-check: diagnose the OTEL stack health (see otel-check --help)
#
{
  # Fixed base port (null = derive from $DEVENV_ROOT hash)
  basePort ? null,
  # Port range for hash-based allocation (only used when basePort is null)
  portRangeStart ? 10000,
  portRangeEnd ? 60000,
}:
{ pkgs, config, lib, ... }:
let
  # Data directory for Tempo and Grafana state
  dataDir = "${config.devenv.root}/.devenv/otel";

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
    { name = "github.com/grafana/grafonnet"; path = grafonnetSrc; }
    { name = "github.com/jsonnet-libs/xtd"; path = xtdSrc; }
    { name = "github.com/jsonnet-libs/docsonnet"; path = docsonnetSrc; }
  ];

  # Build a single dashboard from Jsonnet source
  buildDashboard = name: pkgs.runCommand "grafana-dashboard-${name}" {
    nativeBuildInputs = [ pkgs.go-jsonnet ];
  } ''
    mkdir -p $out
    jsonnet \
      -J ${grafonnetJpath} \
      -J ${grafonnetSrc} \
      -J ${dashboardsSrcDir} \
      ${dashboardsSrcDir}/${name}.jsonnet \
      -o $out/${name}.json
  '';

  # All dashboards as a linkFarm (Nix store path with JSON files)
  dashboardNames = [ "overview" "dt-tasks" "shell-entry" "pnpm-install" "ts-app-traces" ];
  allDashboards = pkgs.linkFarm "otel-dashboards" (map (name: {
    name = "${name}.json";
    path = "${buildDashboard name}/${name}.json";
  }) dashboardNames);

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
  hexCharToInt = c:
    let
      chars = ["0" "1" "2" "3" "4" "5" "6" "7" "8" "9" "a" "b" "c" "d" "e" "f"];
      findIdx = i:
        if i >= 16 then 0
        else if builtins.elemAt chars i == c then i
        else findIdx (i + 1);
    in findIdx 0;
  # Take first 7 hex chars -> convert to int -> mod into port range
  # (7 hex chars = max 268M, fits in Nix int; 8 might overflow on 32-bit)
  hexChars = lib.stringToCharacters (builtins.substring 0 7 pathHash);
  hashInt = lib.mod
    (builtins.foldl' (acc: c: acc * 16 + hexCharToInt c) 0 hexChars)
    portRange;
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

    processors:
      batch:
        timeout: 1s
        send_batch_size: 128

    exporters:
      otlp:
        endpoint: "127.0.0.1:${toString tempoOtlpPort}"
        tls:
          insecure: true

    service:
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
          receivers: [otlp]
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

    memberlist:
      bind_addr:
        - "127.0.0.1"

    storage:
      trace:
        backend: local
        local:
          path: ${dataDir}/tempo-data
        wal:
          path: ${dataDir}/tempo-wal

    compactor:
      compaction:
        block_retention: 72h

    metrics_generator:
      storage:
        path: ${dataDir}/tempo-metrics
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
  # otel-span: shell helper for emitting OTLP trace spans from bash
  # =========================================================================
  #
  # This is the OTEL compat layer for shell scripts. It uses curl to POST
  # OTLP JSON to the collector. No heavy SDK needed.
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
      --attr KEY=VALUE    Add a span attribute (repeatable)
      --trace-id ID       Use specific trace ID (default: from TRACEPARENT or random)
      --parent-span-id ID Use specific parent span ID (default: from TRACEPARENT)
      --help              Show this help

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
    PARENT_SPAN_ID=""
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
        --parent-span-id)
          PARENT_SPAN_ID="$2"
          shift 2
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
    SPAN_ID="$(gen_hex 8)"

    # Export TRACEPARENT for child processes
    export TRACEPARENT="00-$TRACE_ID-$SPAN_ID-01"

    # Timestamps in nanoseconds
    start_ns="$(${pkgs.coreutils}/bin/date +%s%N)"

    # Run the command
    exit_code=0
    "''${CMD_ARGS[@]}" || exit_code=$?

    end_ns="$(${pkgs.coreutils}/bin/date +%s%N)"

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

    # Send to collector (fire-and-forget, don't block on failure)
    ${pkgs.curl}/bin/curl -s -X POST \
      "$ENDPOINT/v1/traces" \
      -H "Content-Type: application/json" \
      -d "$payload" \
      --max-time 2 \
      >/dev/null 2>&1 || true

    exit "$exit_code"
  '';

  # =========================================================================
  # otel-check: CLI diagnostic tool for the OTEL stack
  # =========================================================================
  #
  # Checks health of Grafana, Tempo, Collector, and provisioned dashboards.
  # Uses the Grafana HTTP API (anonymous auth, no tokens needed).
  #
  # Usage:
  #   otel-check                    # full health check
  #   otel-check dashboards         # list provisioned dashboards
  #   otel-check dashboards --validate  # validate each dashboard
  #   otel-check traces             # query Tempo for recent traces
  #   otel-check send-test          # end-to-end smoke test
  #   otel-check --help
  #
  otelCheck = pkgs.writeShellScriptBin "otel-check" ''
    set -euo pipefail

    GRAFANA_URL="''${OTEL_GRAFANA_URL:-}"
    COLLECTOR_URL="''${OTEL_EXPORTER_OTLP_ENDPOINT:-}"

    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    BLUE='\033[0;34m'
    BOLD='\033[1m'
    DIM='\033[2m'
    NC='\033[0m'

    ok()   { echo -e "  ''${GREEN}✓''${NC} $1"; }
    fail() { echo -e "  ''${RED}✗''${NC} $1"; }
    warn() { echo -e "  ''${YELLOW}!''${NC} $1"; }
    info() { echo -e "  ''${BLUE}→''${NC} $1"; }

    usage() {
      cat <<'USAGE'
    Usage: otel-check [command] [options]

    Diagnoses the OTEL observability stack health.

    Commands:
      (none)              Full health check (Grafana + Tempo + Collector + dashboards)
      dashboards          List all provisioned Grafana dashboards
      dashboards --validate   Load each dashboard and check for errors
      traces [query]      Query Tempo for recent traces (default: non-internal)
      send-test           End-to-end smoke test: send span → verify in Tempo
      datasources         Show configured Grafana datasources
      --help              Show this help

    Examples:
      otel-check                                          # full health
      otel-check traces                                   # recent non-internal traces
      otel-check traces '{resource.service.name="dt"}'    # dt task traces only
      otel-check traces '{}' 20                           # all traces, limit 20
      otel-check send-test                                # end-to-end pipeline test

    Environment:
      OTEL_GRAFANA_URL               Grafana URL (set by otel.nix)
      OTEL_EXPORTER_OTLP_ENDPOINT    Collector URL (set by otel.nix)
    USAGE
      exit 0
    }

    check_endpoint() {
      local name="$1" url="$2" path="$3"
      local response
      response=$(${pkgs.curl}/bin/curl -sf --max-time 3 "$url$path" 2>/dev/null) && {
        echo "$response"
        return 0
      } || {
        return 1
      }
    }

    # Resolve the Tempo datasource UID from Grafana (cached per invocation)
    _tempo_uid=""
    get_tempo_uid() {
      if [[ -z "$_tempo_uid" ]]; then
        _tempo_uid=$(${pkgs.curl}/bin/curl -sf --max-time 3 "$GRAFANA_URL/api/datasources" 2>/dev/null \
          | ${pkgs.jq}/bin/jq -r '.[] | select(.type == "tempo") | .uid' 2>/dev/null) || true
      fi
      echo "$_tempo_uid"
    }

    cmd_health() {
      echo -e "''${BOLD}OTEL Stack Health''${NC}"
      echo ""

      # Grafana
      echo -e "''${BOLD}Grafana''${NC} ($GRAFANA_URL)"
      local grafana_health
      if grafana_health=$(check_endpoint "Grafana" "$GRAFANA_URL" "/api/health"); then
        local version db_status
        version=$(echo "$grafana_health" | ${pkgs.jq}/bin/jq -r '.version // "unknown"')
        db_status=$(echo "$grafana_health" | ${pkgs.jq}/bin/jq -r '.database // "unknown"')
        ok "Healthy (v$version, db=$db_status)"
      else
        fail "Not reachable"
      fi

      # Dashboards
      local dashboards
      if dashboards=$(check_endpoint "Grafana" "$GRAFANA_URL" "/api/search?type=dash-db"); then
        local count
        count=$(echo "$dashboards" | ${pkgs.jq}/bin/jq 'length')
        ok "$count dashboards provisioned"
      else
        fail "Cannot list dashboards"
      fi

      # Datasources
      local datasources
      if datasources=$(check_endpoint "Grafana" "$GRAFANA_URL" "/api/datasources"); then
        local tempo_ds
        tempo_ds=$(echo "$datasources" | ${pkgs.jq}/bin/jq -r '.[] | select(.type == "tempo") | .name // empty')
        if [[ -n "$tempo_ds" ]]; then
          ok "Tempo datasource: $tempo_ds (uid=$(get_tempo_uid))"
        else
          fail "No Tempo datasource found"
        fi
      else
        fail "Cannot list datasources"
      fi

      echo ""

      # Tempo (direct readiness check)
      echo -e "''${BOLD}Tempo''${NC} (http://127.0.0.1:${toString tempoQueryPort})"
      local tempo_url="http://127.0.0.1:${toString tempoQueryPort}"
      local tempo_resp
      tempo_resp=$(${pkgs.curl}/bin/curl -s --max-time 3 "$tempo_url/ready" 2>/dev/null) || true
      if [[ "$tempo_resp" == "ready" ]]; then
        ok "Ready"
      elif [[ -n "$tempo_resp" ]]; then
        # Parse warmup message for friendlier display
        if echo "$tempo_resp" | grep -q "waiting for"; then
          local wait_time
          wait_time=$(echo "$tempo_resp" | grep -oP '\d+s' | head -1)
          warn "Warming up (''${wait_time:-~15s} startup delay) — try again shortly"
        else
          warn "Not ready: $tempo_resp"
        fi
      else
        fail "Not reachable"
      fi

      echo ""

      # OTEL Collector
      echo -e "''${BOLD}OTEL Collector''${NC} ($COLLECTOR_URL)"
      local metrics_url="http://127.0.0.1:${toString otelMetricsPort}"
      if check_endpoint "Collector" "$metrics_url" "/metrics" >/dev/null 2>&1; then
        ok "Healthy (metrics endpoint)"
      else
        fail "Not reachable"
      fi

      echo ""
    }

    cmd_dashboards() {
      local validate=false
      if [[ "''${1:-}" == "--validate" ]]; then
        validate=true
      fi

      echo -e "''${BOLD}Provisioned Dashboards''${NC}"
      echo ""
      local dashboards
      if ! dashboards=$(check_endpoint "Grafana" "$GRAFANA_URL" "/api/search?type=dash-db"); then
        fail "Grafana not reachable at $GRAFANA_URL"
        info "Start the stack with: devenv up"
        echo ""
        return
      fi

      local count
      count=$(echo "$dashboards" | ${pkgs.jq}/bin/jq 'length')

      if [[ "$validate" == "true" ]]; then
        # Validate each dashboard by loading its full model
        local errors=0
        local uid title
        for uid in $(echo "$dashboards" | ${pkgs.jq}/bin/jq -r '.[].uid'); do
          title=$(echo "$dashboards" | ${pkgs.jq}/bin/jq -r --arg uid "$uid" '.[] | select(.uid == $uid) | .title')
          local dash_resp
          if dash_resp=$(check_endpoint "Grafana" "$GRAFANA_URL" "/api/dashboards/uid/$uid"); then
            # Check for panel count
            local panel_count
            panel_count=$(echo "$dash_resp" | ${pkgs.jq}/bin/jq '.dashboard.panels | length')

            # Check all panels have valid datasource references
            local broken_panels
            broken_panels=$(echo "$dash_resp" | ${pkgs.jq}/bin/jq '[
              .dashboard.panels[]? |
              select(.type != "row" and .type != "text") |
              select(
                (.targets // [] | length == 0) or
                (.targets[]? | .datasource.uid // "" | test("^$"))
              ) |
              .title
            ] | length')

            # Check for unresolved datasource template variables
            local unresolved_vars
            unresolved_vars=$(echo "$dash_resp" | ${pkgs.jq}/bin/jq '
              [.dashboard | tostring | scan("\\$\\{DS_[A-Z_]+\\}")] | length
            ')

            if [[ "$broken_panels" -gt 0 ]]; then
              fail "$title ($uid): $broken_panels panel(s) with missing targets/datasource"
              errors=$((errors + 1))
            elif [[ "$unresolved_vars" -gt 0 ]]; then
              fail "$title ($uid): $unresolved_vars unresolved datasource variable(s)"
              errors=$((errors + 1))
            else
              ok "$title ($uid): $panel_count panels, all valid"
            fi
          else
            fail "$title ($uid): failed to load"
            errors=$((errors + 1))
          fi
        done
        echo ""
        if [[ "$errors" -eq 0 ]]; then
          ok "All $count dashboards validated successfully"
        else
          fail "$errors of $count dashboards have issues"
        fi
      else
        echo "$dashboards" | ${pkgs.jq}/bin/jq -r '.[] | "  \(.title)\t\(.uid)\t\(.url)"' | ${pkgs.util-linux}/bin/column -t -s $'\t'
        echo ""
        info "$count dashboards total"
        echo ""
        echo "  Open in browser:"
        echo "$dashboards" | ${pkgs.jq}/bin/jq -r '.[] | "    '$GRAFANA_URL'\(.url)"'
        echo ""
        info "Run 'otel-check dashboards --validate' to check for errors"
      fi
      echo ""
    }

    cmd_traces() {
      echo -e "''${BOLD}Recent Traces''${NC}"
      echo ""

      # Default: exclude internal Tempo traces for cleaner output
      local default_query='{resource.service.name!="tempo-all"}'
      local query="''${1:-$default_query}"
      local limit="''${2:-10}"

      local tempo_uid
      tempo_uid=$(get_tempo_uid)
      if [[ -z "$tempo_uid" ]]; then
        fail "Cannot find Tempo datasource in Grafana"
        info "Make sure the stack is running: devenv up"
        echo ""
        return
      fi

      local payload
      payload=$(${pkgs.jq}/bin/jq -n \
        --arg query "$query" \
        --arg limit "$limit" \
        --arg uid "$tempo_uid" \
        '{
          queries: [{
            refId: "A",
            datasource: { uid: $uid, type: "tempo" },
            queryType: "traceql",
            query: $query,
            limit: ($limit | tonumber),
            tableType: "traces"
          }],
          from: "now-1h",
          to: "now"
        }')

      local response
      if response=$(${pkgs.curl}/bin/curl -sf --max-time 10 \
          -X POST "$GRAFANA_URL/api/ds/query" \
          -H "Content-Type: application/json" \
          -d "$payload" 2>/dev/null); then

        local trace_count
        trace_count=$(echo "$response" | ${pkgs.jq}/bin/jq '[.results.A.frames[]?.data.values // [] | .[0] // [] | length] | add // 0')

        if [[ "$trace_count" -gt 0 ]]; then
          ok "$trace_count traces found (query: $query, last 1h)"
          echo ""
          printf "  %-34s\t%-20s\t%-30s\t%s\n" "TRACE ID" "SERVICE" "NAME" "DURATION" | ${pkgs.util-linux}/bin/column -t -s $'\t'
          echo "$response" | ${pkgs.jq}/bin/jq -r '
            .results.A.frames[]? |
            .data as $data |
            .schema.fields as $fields |
            ($fields | to_entries | map({(.value.name): .key}) | add) as $idx |
            if ($data.values | length) > 0 then
              range($data.values[0] | length) as $i |
              "  " +
              (if $idx["traceID"] then $data.values[$idx["traceID"]][$i] // "-" else "-" end) +
              "\t" +
              (if $idx["traceService"] then $data.values[$idx["traceService"]][$i] // "-" else "-" end) +
              "\t" +
              (if $idx["traceName"] then $data.values[$idx["traceName"]][$i] // "-" else "-" end) +
              "\t" +
              (if $idx["traceDuration"] then ($data.values[$idx["traceDuration"]][$i] // 0 | tostring) + "ms" else "-" end)
            else empty end
          ' 2>/dev/null | head -20 | ${pkgs.util-linux}/bin/column -t -s $'\t' || true
        else
          warn "No traces found for query: $query (last 1h)"
          info "Run some dt tasks first, then check again"
        fi
      else
        fail "Cannot query Tempo via Grafana"
        info "Make sure the stack is running: devenv up"
      fi
      echo ""
    }

    cmd_send_test() {
      echo -e "''${BOLD}End-to-End Smoke Test''${NC}"
      echo ""

      # Step 1: Check prerequisites
      info "Checking stack health..."
      local grafana_ok=false tempo_ok=false collector_ok=false

      if check_endpoint "Grafana" "$GRAFANA_URL" "/api/health" >/dev/null 2>&1; then
        grafana_ok=true
        ok "Grafana reachable"
      else
        fail "Grafana not reachable"
      fi

      local tempo_url="http://127.0.0.1:${toString tempoQueryPort}"
      local tempo_resp
      tempo_resp=$(${pkgs.curl}/bin/curl -s --max-time 3 "$tempo_url/ready" 2>/dev/null) || true
      if [[ "$tempo_resp" == "ready" ]]; then
        tempo_ok=true
        ok "Tempo ready"
      else
        fail "Tempo not ready''${tempo_resp:+ ($tempo_resp)}"
      fi

      local metrics_url="http://127.0.0.1:${toString otelMetricsPort}"
      if check_endpoint "Collector" "$metrics_url" "/metrics" >/dev/null 2>&1; then
        collector_ok=true
        ok "Collector reachable"
      else
        fail "Collector not reachable"
      fi

      if [[ "$grafana_ok" != "true" ]] || [[ "$tempo_ok" != "true" ]] || [[ "$collector_ok" != "true" ]]; then
        echo ""
        fail "Prerequisites not met — start the stack with: devenv up"
        echo ""
        return 1
      fi

      echo ""

      # Step 2: Generate a unique trace ID and send a test span
      local test_trace_id
      test_trace_id=$(${pkgs.coreutils}/bin/od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
      local test_span_id
      test_span_id=$(${pkgs.coreutils}/bin/od -An -tx1 -N8 /dev/urandom | tr -d ' \n')
      local now_ns
      now_ns=$(${pkgs.coreutils}/bin/date +%s%N)
      local end_ns=$((now_ns + 1000000))  # 1ms duration

      info "Sending test span (trace_id=$test_trace_id)..."

      local payload='{
        "resourceSpans": [{
          "resource": {
            "attributes": [
              {"key": "service.name", "value": {"stringValue": "otel-check-test"}}
            ]
          },
          "scopeSpans": [{
            "scope": {"name": "otel-check"},
            "spans": [{
              "traceId": "'"$test_trace_id"'",
              "spanId": "'"$test_span_id"'",
              "name": "smoke-test",
              "kind": 1,
              "startTimeUnixNano": "'"$now_ns"'",
              "endTimeUnixNano": "'"$end_ns"'",
              "attributes": [
                {"key": "test.type", "value": {"stringValue": "smoke-test"}}
              ],
              "status": {"code": 1}
            }]
          }]
        }]
      }'

      local send_resp
      send_resp=$(${pkgs.curl}/bin/curl -s -w "\n%{http_code}" -X POST \
        "$COLLECTOR_URL/v1/traces" \
        -H "Content-Type: application/json" \
        -d "$payload" \
        --max-time 5 2>/dev/null) || true
      local send_http_code
      send_http_code=$(echo "$send_resp" | tail -1)

      if [[ "$send_http_code" == "200" ]]; then
        ok "Span sent to Collector (HTTP 200)"
      else
        fail "Failed to send span (HTTP $send_http_code)"
        echo ""
        return 1
      fi

      # Step 3: Wait for the span to be ingested (collector batches at 1s)
      info "Waiting for ingestion (2s for batch + flush)..."
      sleep 2

      # Step 4: Query Tempo for the trace by service name
      # (TraceQL doesn't support trace ID filters; use the unique service name instead)
      local tempo_uid
      tempo_uid=$(get_tempo_uid)
      local query_payload
      query_payload=$(${pkgs.jq}/bin/jq -n \
        --arg uid "$tempo_uid" \
        '{
          queries: [{
            refId: "A",
            datasource: { uid: $uid, type: "tempo" },
            queryType: "traceql",
            query: "{resource.service.name=\"otel-check-test\"}",
            limit: 1,
            tableType: "traces"
          }],
          from: "now-5m",
          to: "now"
        }')

      local found=false
      local attempts=0
      local max_attempts=5
      local tempo_direct="http://127.0.0.1:${toString tempoQueryPort}"

      while [[ "$attempts" -lt "$max_attempts" ]]; do
        attempts=$((attempts + 1))

        # Try direct Tempo API first (more reliable, no Grafana proxy)
        if ${pkgs.curl}/bin/curl -sf --max-time 5 "$tempo_direct/api/traces/$test_trace_id" >/dev/null 2>&1; then
          found=true
          break
        fi

        if [[ "$attempts" -lt "$max_attempts" ]]; then
          info "Not found yet, retrying ($attempts/$max_attempts)..."
          sleep 2
        fi
      done

      echo ""
      if [[ "$found" == "true" ]]; then
        ok "Trace $test_trace_id found in Tempo after ''${attempts} attempt(s)"
        echo ""
        # Also verify the Grafana query path works
        local grafana_ok=false
        local query_resp
        if query_resp=$(${pkgs.curl}/bin/curl -sf --max-time 10 \
            -X POST "$GRAFANA_URL/api/ds/query" \
            -H "Content-Type: application/json" \
            -d "$query_payload" 2>/dev/null); then
          local found_count
          found_count=$(echo "$query_resp" | ${pkgs.jq}/bin/jq '[.results.A.frames[]?.data.values // [] | .[0] // [] | length] | add // 0')
          if [[ "$found_count" -gt 0 ]]; then
            grafana_ok=true
          fi
        fi
        if [[ "$grafana_ok" == "true" ]]; then
          ok "End-to-end verified: otel-span → Collector → Tempo → Grafana query"
        else
          ok "Collector → Tempo pipeline works"
          warn "Grafana query returned no results (may need a moment to sync)"
        fi
      else
        fail "Trace not found after $max_attempts attempts"
        warn "The span was sent successfully but didn't appear in Tempo"
        info "This may indicate a Collector→Tempo forwarding issue"
      fi
      echo ""
    }

    cmd_datasources() {
      echo -e "''${BOLD}Grafana Datasources''${NC}"
      echo ""
      local datasources
      if datasources=$(check_endpoint "Grafana" "$GRAFANA_URL" "/api/datasources"); then
        echo "$datasources" | ${pkgs.jq}/bin/jq -r '.[] | "  \(.name)\t\(.type)\t\(.uid)\t\(.url)\t\(if .isDefault then "(default)" else "" end)"' | ${pkgs.util-linux}/bin/column -t -s $'\t'
      else
        fail "Grafana not reachable at $GRAFANA_URL"
      fi
      echo ""
    }

    # Preflight
    if [[ -z "$GRAFANA_URL" ]]; then
      echo "otel-check: OTEL_GRAFANA_URL not set" >&2
      echo "Are you inside a devenv shell with the otel module?" >&2
      exit 1
    fi

    case "''${1:-}" in
      --help|-h) usage ;;
      dashboards) shift; cmd_dashboards "$@" ;;
      traces) shift; cmd_traces "$@" ;;
      send-test) cmd_send_test ;;
      datasources) cmd_datasources ;;
      "") cmd_health ;;
      *)
        echo "otel-check: unknown command: $1" >&2
        echo "Run 'otel-check --help' for usage" >&2
        exit 1
        ;;
    esac
  '';

in {
  packages = [
    pkgs.opentelemetry-collector-contrib
    pkgs.tempo
    pkgs.grafana
    otelSpan
    otelCheck
  ];

  # Set OTEL endpoint so TS code (Effect OTEL layers) and future devenv native
  # OTEL can discover the collector automatically
  env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:${toString otelCollectorPort}";
  env.OTEL_GRAFANA_URL = "http://127.0.0.1:${toString grafanaPort}";

  enterShell = ''
    echo "[otel] Collector: $OTEL_EXPORTER_OTLP_ENDPOINT"
    echo "[otel] Grafana:   $OTEL_GRAFANA_URL"
    echo "[otel] Start with: devenv up | Check with: otel-check"
  '';

  # =========================================================================
  # Processes (started via `devenv up`)
  # =========================================================================

  # Process names include port for visibility in process-compose TUI
  processes = {
    "otel-collector-${toString otelCollectorPort}" = {
      exec = ''
        exec ${pkgs.opentelemetry-collector-contrib}/bin/otelcol-contrib \
          --config ${otelCollectorConfig}
      '';
    };

    "tempo-${toString tempoQueryPort}" = {
      exec = ''
        mkdir -p ${dataDir}/tempo-data ${dataDir}/tempo-wal ${dataDir}/tempo-metrics
        exec ${pkgs.tempo}/bin/tempo \
          -config.file ${tempoConfig}
      '';
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
}
