# otel-span: OTLP trace span CLI.
#
# Delivers spans via spool file ($OTEL_SPAN_SPOOL_DIR) or HTTP POST (fallback).
#
# Subcommands:
#   run   — wrap a command in an OTLP trace span
#   emit  — deliver a raw OTLP JSON payload from stdin
#
# Usage:
#   packages = [ effectUtils.lib.mkOtelSpan { inherit pkgs; } ];
{ pkgs }:
pkgs.writeShellScriptBin "otel-span" ''
  set -euo pipefail

  # ── Shared delivery function (payload passed as $1) ──
  _otel_deliver() {
    local payload="$1"
    _spool_dir="''${OTEL_SPAN_SPOOL_DIR:-}"
    if [ -n "$_spool_dir" ] && [ -d "$_spool_dir" ]; then
      if [ "''${OTEL_SPOOL_MULTI_WRITER:-}" = "1" ]; then
        _tmp=$(mktemp "$_spool_dir/.tmp.XXXXXXXXXX")
        printf '%s\n' "$payload" | ${pkgs.jq}/bin/jq -c . > "$_tmp"
        mv "$_tmp" "''${_spool_dir}/$(date +%s%N)-$$.jsonl"
      else
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
  }

  # ── Subcommand: emit ──
  _cmd_emit() {
    local payload
    payload=$(cat)
    _otel_deliver "$payload"
  }

  # ── Subcommand: run ──
  _cmd_run() {
    _run_usage() {
      cat <<'USAGE'
Usage: otel-span run <service-name> <span-name> [options] -- <command> [args...]

Wraps a command in an OTLP trace span. Delivers via spool file
($OTEL_SPAN_SPOOL_DIR) when available, falls back to HTTP POST.
No-op when neither endpoint nor spool dir is configured.

Options:
  --attr KEY=VALUE      Add a span attribute (repeatable)
  --status-attr KEY     Derive bool attribute from exit code (0=true, else=false)
                        and force span status to OK (for status checks, not errors)
  --trace-id ID         Use specific trace ID (default: from TRACEPARENT or random)
  --span-id ID          Use specific span ID (default: random)
  --parent-span-id ID   Use specific parent span ID (default: from TRACEPARENT)
  --start-time-ns NS    Override start timestamp in nanoseconds (default: now)
  --end-time-ns NS      Override end timestamp in nanoseconds (default: now after command)
  --log-url             Print Grafana trace URL to stderr after span emission
  --help                Show this help

Environment:
  OTEL_EXPORTER_OTLP_ENDPOINT   Collector HTTP endpoint (fallback delivery)
  OTEL_SPAN_SPOOL_DIR           Spool directory for file-based delivery (preferred)
  OTEL_GRAFANA_URL              Grafana base URL (used by --log-url)
  OTEL_TASK_TRACEPARENT         Task-level trace context (survives devenv shell re-evaluations)
  TRACEPARENT                    W3C Trace Context parent (optional, OTEL_TASK_TRACEPARENT preferred)

Examples:
  otel-span run dt pnpm:install -- pnpm install
  otel-span run dt ts:check --attr cached=true -- tsc --noEmit
USAGE
      exit 0
    }

    SERVICE_NAME=""
    SPAN_NAME=""
    ATTRS=()
    STATUS_ATTR=""
    TRACE_ID=""
    SPAN_ID=""
    PARENT_SPAN_ID=""
    START_TIME_NS=""
    END_TIME_NS=""
    LOG_URL=""
    CMD_ARGS=()

    while [[ $# -gt 0 ]]; do
      case "$1" in
        --help) _run_usage ;;
        --attr)
          ATTRS+=("$2")
          shift 2
          ;;
        --status-attr)
          STATUS_ATTR="$2"
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
            echo "otel-span run: unexpected argument: $1" >&2
            exit 1
          fi
          shift
          ;;
      esac
    done

    if [[ -z "$SERVICE_NAME" ]] || [[ -z "$SPAN_NAME" ]] || [[ ''${#CMD_ARGS[@]} -eq 0 ]]; then
      echo "otel-span run: missing required arguments" >&2
      echo "Usage: otel-span run <service-name> <span-name> [options] -- <command> [args...]" >&2
      exit 1
    fi

    ENDPOINT="''${OTEL_EXPORTER_OTLP_ENDPOINT:-}"
    if [[ -z "$ENDPOINT" ]]; then
      # No collector configured - just run the command directly
      exec "''${CMD_ARGS[@]}"
    fi

    gen_hex() {
      local len=$1
      ${pkgs.coreutils}/bin/od -An -tx1 -N"$len" /dev/urandom | tr -d ' \n'
    }

    # Resolve parent trace context.
    # OTEL_TASK_TRACEPARENT takes precedence because devenv shell re-evaluations
    # overwrite TRACEPARENT on each enterShell, making it unreliable for task spans.
    _tp_source="''${OTEL_TASK_TRACEPARENT:-''${TRACEPARENT:-}}"
    if [[ -n "$_tp_source" ]]; then
      IFS='-' read -r _tp_ver _tp_trace _tp_parent _tp_flags <<< "$_tp_source"
      TRACE_ID="''${TRACE_ID:-$_tp_trace}"
      PARENT_SPAN_ID="''${PARENT_SPAN_ID:-$_tp_parent}"
    fi

    TRACE_ID="''${TRACE_ID:-$(gen_hex 16)}"
    SPAN_ID="''${SPAN_ID:-$(gen_hex 8)}"

    export TRACEPARENT="00-$TRACE_ID-$SPAN_ID-01"
    export OTEL_TASK_TRACEPARENT="$TRACEPARENT"

    start_ns="''${START_TIME_NS:-$(${pkgs.coreutils}/bin/date +%s%N)}"

    exit_code=0
    "''${CMD_ARGS[@]}" || exit_code=$?

    end_ns="''${END_TIME_NS:-$(${pkgs.coreutils}/bin/date +%s%N)}"

    # Build attributes JSON (true/false emitted as boolValue, everything else as stringValue)
    attrs_json='[{"key":"service.name","value":{"stringValue":"'"$SERVICE_NAME"'"}}'
    attrs_json+=',{"key":"exit.code","value":{"intValue":"'"$exit_code"'"}}'
    attrs_json+=',{"key":"devenv.root","value":{"stringValue":"'"$DEVENV_ROOT"'"}}'
    for attr in "''${ATTRS[@]}"; do
      key="''${attr%%=*}"
      val="''${attr#*=}"
      if [ "$val" = "true" ] || [ "$val" = "false" ]; then
        attrs_json+=',{"key":"'"$key"'","value":{"boolValue":'"$val"'}}'
      else
        attrs_json+=',{"key":"'"$key"'","value":{"stringValue":"'"$val"'"}}'
      fi
    done
    # --status-attr: derive bool attribute from exit code (0=true, non-zero=false)
    if [[ -n "$STATUS_ATTR" ]]; then
      if [[ "$exit_code" -eq 0 ]]; then
        attrs_json+=',{"key":"'"$STATUS_ATTR"'","value":{"boolValue":true}}'
      else
        attrs_json+=',{"key":"'"$STATUS_ATTR"'","value":{"boolValue":false}}'
      fi
    fi
    attrs_json+=']'

    # --status-attr forces OK status (status checks aren't errors, exit 1 means "not cached")
    if [[ -n "$STATUS_ATTR" ]] || [[ "$exit_code" -eq 0 ]]; then
      status_json='{"code":1}'
    else
      status_json='{"code":2,"message":"exit code '"$exit_code"'"}'
    fi

    parent_json=""
    if [[ -n "''${PARENT_SPAN_ID:-}" ]]; then
      parent_json='"parentSpanId":"'"$PARENT_SPAN_ID"'",'
    fi

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

    _otel_deliver "$payload"

    if [ -n "$LOG_URL" ] && [ -n "''${OTEL_GRAFANA_URL:-}" ]; then
      _panes='{"a":{"datasource":{"type":"tempo","uid":"tempo"},"queries":[{"refId":"A","datasource":{"type":"tempo","uid":"tempo"},"queryType":"traceql","query":"'"$TRACE_ID"'"}],"range":{"from":"now-1h","to":"now"}}}'
      _encoded=$(printf '%s' "$_panes" | ${pkgs.gnused}/bin/sed 's/{/%7B/g;s/}/%7D/g;s/\[/%5B/g;s/\]/%5D/g;s/"/%22/g;s/:/%3A/g;s/,/%2C/g;s/ /%20/g')
      _url="$OTEL_GRAFANA_URL/explore?schemaVersion=1&panes=$_encoded&orgId=1"
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
  }

  # ── Top-level help ──
  _top_help() {
    cat <<'HELP'
Usage: otel-span <subcommand> [args...]

OTLP trace span CLI. Delivers spans via spool file or HTTP POST.

Subcommands:
  run   Wrap a command in an OTLP trace span
  emit  Deliver a raw OTLP JSON payload from stdin

Run 'otel-span <subcommand> --help' for subcommand-specific help.
HELP
  }

  # ── Subcommand dispatch ──
  case "''${1:-}" in
    run)  shift; _cmd_run "$@" ;;
    emit) shift; _cmd_emit ;;
    --help|-h) _top_help; exit 0 ;;
    "")
      echo "otel-span: subcommand required" >&2
      _top_help >&2
      exit 1
      ;;
    *)
      echo "otel-span: unknown subcommand: $1" >&2
      _top_help >&2
      exit 1
      ;;
  esac
''
