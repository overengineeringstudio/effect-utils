# Standalone otel-span and otel-emit-span shell helpers.
#
# These can be added to any devenv/shell without importing the full OTEL module
# (which starts local collector/tempo/grafana processes).
#
# Usage:
#   packages = [ effectUtils.lib.mkOtelSpan { inherit pkgs; } ];
#
# Or to get both derivations separately:
#   let otelSpan = effectUtils.lib.mkOtelSpan { inherit pkgs; };
#   in { packages = [ otelSpan otelSpan.passthru.otelEmitSpan ]; }
{ pkgs }:
let
  # Low-level helper: delivers an OTLP JSON payload via spool file or HTTP POST.
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

  # otel-span: wraps command execution in an OTLP trace span.
  # Supports TRACEPARENT propagation, custom attributes, Grafana URL logging.
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
in
otelSpan // { passthru = { inherit otelEmitSpan; }; }
