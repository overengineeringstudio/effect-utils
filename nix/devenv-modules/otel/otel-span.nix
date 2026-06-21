# otel-span: OTLP trace span CLI.
#
# Delivers spans via spool file ($OTEL_SPAN_SPOOL_DIR) or HTTP POST (fallback).
#
# Subcommands:
#   run       — wrap a command in an OTLP trace span
#   emit-span — emit one OTLP span with typed attributes
#   emit      — deliver a raw OTLP JSON payload from stdin
#
# Usage:
#   packages = [ effectUtils.lib.mkOtelSpan { inherit pkgs; } ];
{ pkgs }:
pkgs.writeShellScriptBin "otel-span" ''
      set -euo pipefail

      _jq=${pkgs.jq}/bin/jq

      _otel_delivery_configured() {
        [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ] || { [ -n "''${OTEL_SPAN_SPOOL_DIR:-}" ] && [ -d "''${OTEL_SPAN_SPOOL_DIR:-}" ]; }
      }

      # Payload is passed as $1. Spool delivery validates and compacts JSON before
      # writing so malformed shell-built OTLP never enters downstream tests.
      _otel_deliver() {
        local payload="$1"
        local _spool_dir="''${OTEL_SPAN_SPOOL_DIR:-}"
        if [ -n "$_spool_dir" ] && [ -d "$_spool_dir" ]; then
          if [ "''${OTEL_SPOOL_MULTI_WRITER:-}" = "1" ]; then
            local _tmp
            _tmp=$(${pkgs.coreutils}/bin/mktemp "$_spool_dir/.tmp.XXXXXXXXXX")
            printf '%s\n' "$payload" | "$_jq" -c . > "$_tmp"
            ${pkgs.coreutils}/bin/mv "$_tmp" "''${_spool_dir}/$(${pkgs.coreutils}/bin/date +%s%N)-$$.jsonl"
          else
            printf '%s\n' "$payload" | "$_jq" -c . >> "$_spool_dir/spans.jsonl"
          fi
        else
          local _endpoint="''${OTEL_EXPORTER_OTLP_ENDPOINT:-}"
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

      _gen_hex() {
        local len=$1
        ${pkgs.coreutils}/bin/od -An -tx1 -N"$len" /dev/urandom | tr -d ' \n'
      }

      _is_hex_len() {
        local value="$1"
        local len="$2"
        [[ "$value" =~ ^[0-9a-fA-F]{$len}$ ]]
      }

      _validate_trace_id() {
        local value="$1"
        _is_hex_len "$value" 32 || { echo "otel-span: invalid trace id: $value" >&2; exit 1; }
      }

      _validate_span_id() {
        local value="$1"
        _is_hex_len "$value" 16 || { echo "otel-span: invalid span id: $value" >&2; exit 1; }
      }

      _resolve_trace_context() {
        local _tp_source="''${OTEL_TASK_TRACEPARENT:-''${TRACEPARENT:-}}"
        if [[ -n "$_tp_source" ]]; then
          local _tp_ver _tp_trace _tp_parent _tp_flags
          IFS='-' read -r _tp_ver _tp_trace _tp_parent _tp_flags <<< "$_tp_source"
          if [[ "$_tp_ver" = "00" ]] && _is_hex_len "$_tp_trace" 32 && _is_hex_len "$_tp_parent" 16; then
            TRACE_ID="''${TRACE_ID:-$_tp_trace}"
            PARENT_SPAN_ID="''${PARENT_SPAN_ID:-$_tp_parent}"
          fi
        fi

        TRACE_ID="''${TRACE_ID:-$(_gen_hex 16)}"
        SPAN_ID="''${SPAN_ID:-$(_gen_hex 8)}"

        _validate_trace_id "$TRACE_ID"
        _validate_span_id "$SPAN_ID"
        if [[ -n "''${PARENT_SPAN_ID:-}" ]]; then
          _validate_span_id "$PARENT_SPAN_ID"
        fi
      }

      _attr_key_from_kv() {
        local kv="$1"
        [[ "$kv" == *=* ]] || { echo "otel-span: attribute must be KEY=VALUE: $kv" >&2; exit 1; }
        local key="''${kv%%=*}"
        [ -n "$key" ] || { echo "otel-span: attribute key must not be empty" >&2; exit 1; }
        printf '%s' "$key"
      }

      _attr_value_from_kv() {
        local kv="$1"
        printf '%s' "''${kv#*=}"
      }

      _add_attr() {
        local type="$1"
        local kv="$2"
        ATTR_TYPES+=("$type")
        ATTR_KEYS+=("$(_attr_key_from_kv "$kv")")
        ATTR_VALUES+=("$(_attr_value_from_kv "$kv")")
      }

      _add_auto_attr() {
        local kv="$1"
        local key value
        key="$(_attr_key_from_kv "$kv")"
        value="$(_attr_value_from_kv "$kv")"
        if [[ "$value" = "true" || "$value" = "false" ]]; then
          ATTR_TYPES+=("bool")
        elif [[ "$value" =~ ^-?[0-9]+$ ]]; then
          ATTR_TYPES+=("int")
        elif [[ "$value" =~ ^-?([0-9]+[.][0-9]*|[.][0-9]+)([eE][-+]?[0-9]+)?$ || "$value" =~ ^-?[0-9]+[eE][-+]?[0-9]+$ ]]; then
          ATTR_TYPES+=("double")
        else
          ATTR_TYPES+=("string")
        fi
        ATTR_KEYS+=("$key")
        ATTR_VALUES+=("$value")
      }

      _append_attr_json() {
        local out="$1"
        local type="$2"
        local key="$3"
        local value="$4"

        # service.name belongs on the resource. Keeping it off span attributes
        # avoids duplicate query paths and trace preview noise.
        if [[ "$key" = "service.name" ]]; then
          return 0
        fi

        case "$type" in
          string)
            "$_jq" -cn --arg key "$key" --arg value "$value" \
              '{key:$key,value:{stringValue:$value}}' >> "$out"
            ;;
          bool)
            [[ "$value" = "true" || "$value" = "false" ]] || { echo "otel-span: bool attribute $key must be true or false" >&2; exit 1; }
            "$_jq" -cn --arg key "$key" --argjson value "$value" \
              '{key:$key,value:{boolValue:$value}}' >> "$out"
            ;;
          int)
            [[ "$value" =~ ^-?[0-9]+$ ]] || { echo "otel-span: int attribute $key is not an integer: $value" >&2; exit 1; }
            "$_jq" -cn --arg key "$key" --arg value "$value" \
              '{key:$key,value:{intValue:$value}}' >> "$out"
            ;;
          double)
            [[ "$value" =~ ^-?([0-9]+[.][0-9]*|[.][0-9]+)([eE][-+]?[0-9]+)?$ || "$value" =~ ^-?[0-9]+[eE][-+]?[0-9]+$ || "$value" =~ ^-?[0-9]+$ ]] \
              || { echo "otel-span: double attribute $key is not numeric: $value" >&2; exit 1; }
            "$_jq" -cn --arg key "$key" --argjson value "$value" \
              '{key:$key,value:{doubleValue:$value}}' >> "$out"
            ;;
          *)
            echo "otel-span: internal error: unknown attribute type $type" >&2
            exit 1
            ;;
        esac
      }

      _span_label_default() {
        local name="$1"
        local label="''${name##*/}"
        printf '%s' "$label"
      }

      _build_attrs_json() {
        local span_name="$1"
        local out
        out=$(${pkgs.coreutils}/bin/mktemp)
        local has_label=0
        local i
        for ((i = 0; i < ''${#ATTR_KEYS[@]}; i += 1)); do
          if [[ "''${ATTR_KEYS[$i]}" = "span.label" ]]; then
            has_label=1
          fi
          _append_attr_json "$out" "''${ATTR_TYPES[$i]}" "''${ATTR_KEYS[$i]}" "''${ATTR_VALUES[$i]}"
        done
        if [[ "$has_label" -eq 0 ]]; then
          _append_attr_json "$out" "string" "span.label" "$(_span_label_default "$span_name")"
        fi
        "$_jq" -cs . "$out"
        ${pkgs.coreutils}/bin/rm -f "$out"
      }

      _build_span_payload() {
        local service_name="$1"
        local span_name="$2"
        local scope_name="$3"
        local start_ns="$4"
        local end_ns="$5"
        local attrs_json="$6"
        local status_json="$7"
        local root="''${DEVENV_ROOT:-$PWD}"

        "$_jq" -n \
          --arg service_name "$service_name" \
          --arg devenv_root "$root" \
          --arg scope_name "$scope_name" \
          --arg trace_id "$TRACE_ID" \
          --arg span_id "$SPAN_ID" \
          --arg parent_span_id "''${PARENT_SPAN_ID:-}" \
          --arg span_name "$span_name" \
          --arg start_ns "$start_ns" \
          --arg end_ns "$end_ns" \
          --argjson attrs "$attrs_json" \
          --argjson status "$status_json" \
          '{
            resourceSpans: [{
              resource: {
                attributes: [
                  {key: "service.name", value: {stringValue: $service_name}},
                  {key: "devenv.root", value: {stringValue: $devenv_root}}
                ]
              },
              scopeSpans: [{
                scope: {name: $scope_name},
                spans: [({
                  traceId: $trace_id,
                  spanId: $span_id,
                  name: $span_name,
                  kind: 1,
                  startTimeUnixNano: $start_ns,
                  endTimeUnixNano: $end_ns,
                  attributes: $attrs,
                  status: $status
                } + (if $parent_span_id == "" then {} else {parentSpanId: $parent_span_id} end))]
              }]
            }]
          }'
      }

      _log_trace_url() {
        local trace_id="$1"
        if [ -n "''${OTEL_GRAFANA_URL:-}" ]; then
          local _panes _encoded _url _trace_label
          _panes='{"a":{"datasource":{"type":"tempo","uid":"tempo"},"queries":[{"refId":"A","datasource":{"type":"tempo","uid":"tempo"},"queryType":"traceql","query":"'"$trace_id"'"}],"range":{"from":"now-1h","to":"now"}}}'
          _encoded=$(printf '%s' "$_panes" | ${pkgs.gnused}/bin/sed 's/{/%7B/g;s/}/%7D/g;s/\[/%5B/g;s/\]/%5D/g;s/"/%22/g;s/:/%3A/g;s/,/%2C/g;s/ /%20/g')
          _url="$OTEL_GRAFANA_URL/explore?schemaVersion=1&panes=$_encoded&orgId=1"
          if [ -n "''${TS_HOSTNAME:-}" ]; then
            _url="''${_url//127.0.0.1/$TS_HOSTNAME}"
          fi
          _trace_label="trace:$trace_id"
          if [ -t 2 ]; then
            printf '[otel] \e]8;;%s\x07\e[4m%s\e[24m\e]8;;\x07\n' "$_url" "$_trace_label" >&2
          else
            printf '[otel] %s %s\n' "$_trace_label" "$_url" >&2
          fi
        fi
      }

      _cmd_emit() {
        local payload
        payload=$(cat)
        _otel_deliver "$payload"
      }

      _emit_span_usage() {
        cat <<'USAGE'
    Usage: otel-span emit-span <service-name> <span-name> [options]

    Emits one OTLP span. Use this for measurement spans that do not wrap a
    command, such as parsed compiler diagnostics.

    Options:
      --attr KEY=VALUE          Add an auto-typed span attribute (repeatable)
      --attr-string KEY=VALUE   Add a string span attribute
      --attr-bool KEY=VALUE     Add a bool span attribute (true/false)
      --attr-int KEY=VALUE      Add an int span attribute
      --attr-double KEY=VALUE   Add a double span attribute
      --trace-id ID             Use specific trace ID (default: from TRACEPARENT or random)
      --span-id ID              Use specific span ID (default: random)
      --parent-span-id ID       Use specific parent span ID (default: from TRACEPARENT)
      --start-time-ns NS        Start timestamp in nanoseconds (default: now)
      --end-time-ns NS          End timestamp in nanoseconds (default: now)
      --scope-name NAME         Instrumentation scope name (default: otel-span)
      --status-code ok|error    Span status (default: ok)
      --status-message MESSAGE  Error status message
      --help                    Show this help
  USAGE
      }

      _cmd_emit_span() {
        SERVICE_NAME=""
        SPAN_NAME=""
        TRACE_ID=""
        SPAN_ID=""
        PARENT_SPAN_ID=""
        START_TIME_NS=""
        END_TIME_NS=""
        SCOPE_NAME="otel-span"
        STATUS_CODE="ok"
        STATUS_MESSAGE=""
        ATTR_TYPES=()
        ATTR_KEYS=()
        ATTR_VALUES=()

        while [[ $# -gt 0 ]]; do
          case "$1" in
            --help) _emit_span_usage; exit 0 ;;
            --attr) _add_auto_attr "$2"; shift 2 ;;
            --attr-string) _add_attr "string" "$2"; shift 2 ;;
            --attr-bool) _add_attr "bool" "$2"; shift 2 ;;
            --attr-int) _add_attr "int" "$2"; shift 2 ;;
            --attr-double) _add_attr "double" "$2"; shift 2 ;;
            --trace-id) TRACE_ID="$2"; shift 2 ;;
            --span-id) SPAN_ID="$2"; shift 2 ;;
            --parent-span-id) PARENT_SPAN_ID="$2"; shift 2 ;;
            --start-time-ns) START_TIME_NS="$2"; shift 2 ;;
            --end-time-ns) END_TIME_NS="$2"; shift 2 ;;
            --scope-name) SCOPE_NAME="$2"; shift 2 ;;
            --status-code) STATUS_CODE="$2"; shift 2 ;;
            --status-message) STATUS_MESSAGE="$2"; shift 2 ;;
            *)
              if [[ -z "$SERVICE_NAME" ]]; then
                SERVICE_NAME="$1"
              elif [[ -z "$SPAN_NAME" ]]; then
                SPAN_NAME="$1"
              else
                echo "otel-span emit-span: unexpected argument: $1" >&2
                exit 1
              fi
              shift
              ;;
          esac
        done

        if [[ -z "$SERVICE_NAME" || -z "$SPAN_NAME" ]]; then
          echo "otel-span emit-span: missing required arguments" >&2
          _emit_span_usage >&2
          exit 1
        fi

        _resolve_trace_context

        local start_ns end_ns attrs_json status_json payload
        end_ns="''${END_TIME_NS:-$(${pkgs.coreutils}/bin/date +%s%N)}"
        start_ns="''${START_TIME_NS:-$end_ns}"
        attrs_json="$(_build_attrs_json "$SPAN_NAME")"

        case "$STATUS_CODE" in
          ok|OK|1) status_json='{"code":1}' ;;
          error|ERROR|2)
            status_json=$("$_jq" -cn --arg message "$STATUS_MESSAGE" '{code:2,message:$message}')
            ;;
          *)
            echo "otel-span emit-span: --status-code must be ok or error" >&2
            exit 1
            ;;
        esac

        payload="$(_build_span_payload "$SERVICE_NAME" "$SPAN_NAME" "$SCOPE_NAME" "$start_ns" "$end_ns" "$attrs_json" "$status_json")"
        _otel_deliver "$payload"
      }

      _run_usage() {
        cat <<'USAGE'
    Usage: otel-span run <service-name> <span-name> [options] -- <command> [args...]

    Wraps a command in an OTLP trace span. Delivers via spool file
    ($OTEL_SPAN_SPOOL_DIR) when available, falls back to HTTP POST.
    No-op when neither endpoint nor spool dir is configured.

    Options:
      --attr KEY=VALUE      Add an auto-typed span attribute (repeatable)
      --status-attr KEY     Derive bool attribute from exit code (0=true, else=false)
                            and force span status to OK (for status checks, not errors)
      --trace-id ID         Use specific trace ID (default: from TRACEPARENT or random)
      --span-id ID          Use specific span ID (default: random)
      --parent-span-id ID   Use specific parent span ID (default: from TRACEPARENT)
      --start-time-ns NS    Override start timestamp in nanoseconds (default: now)
      --end-time-ns NS      Override end timestamp in nanoseconds (default: now after command)
      --log-url             Print Grafana trace URL to stderr after span emission
      --help                Show this help
  USAGE
      }

      _cmd_run() {
        SERVICE_NAME=""
        SPAN_NAME=""
        STATUS_ATTR=""
        TRACE_ID=""
        SPAN_ID=""
        PARENT_SPAN_ID=""
        START_TIME_NS=""
        END_TIME_NS=""
        LOG_URL=""
        CMD_ARGS=()
        ATTR_TYPES=()
        ATTR_KEYS=()
        ATTR_VALUES=()

        while [[ $# -gt 0 ]]; do
          case "$1" in
            --help) _run_usage; exit 0 ;;
            --attr) _add_auto_attr "$2"; shift 2 ;;
            --status-attr) STATUS_ATTR="$2"; shift 2 ;;
            --trace-id) TRACE_ID="$2"; shift 2 ;;
            --span-id) SPAN_ID="$2"; shift 2 ;;
            --parent-span-id) PARENT_SPAN_ID="$2"; shift 2 ;;
            --start-time-ns) START_TIME_NS="$2"; shift 2 ;;
            --end-time-ns) END_TIME_NS="$2"; shift 2 ;;
            --log-url) LOG_URL="1"; shift ;;
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
          _run_usage >&2
          exit 1
        fi

        if ! _otel_delivery_configured; then
          exec "''${CMD_ARGS[@]}"
        fi

        _resolve_trace_context

        export TRACEPARENT="00-$TRACE_ID-$SPAN_ID-01"
        export OTEL_TASK_TRACEPARENT="$TRACEPARENT"

        local start_ns end_ns exit_code attrs_json status_json payload
        start_ns="''${START_TIME_NS:-$(${pkgs.coreutils}/bin/date +%s%N)}"

        exit_code=0
        "''${CMD_ARGS[@]}" || exit_code=$?

        end_ns="''${END_TIME_NS:-$(${pkgs.coreutils}/bin/date +%s%N)}"

        _add_attr "int" "exit.code=$exit_code"
        if [[ -n "$STATUS_ATTR" ]]; then
          if [[ "$exit_code" -eq 0 ]]; then
            _add_attr "bool" "$STATUS_ATTR=true"
          else
            _add_attr "bool" "$STATUS_ATTR=false"
          fi
        fi

        attrs_json="$(_build_attrs_json "$SPAN_NAME")"

        if [[ -n "$STATUS_ATTR" || "$exit_code" -eq 0 ]]; then
          status_json='{"code":1}'
        else
          status_json=$("$_jq" -cn --arg message "exit code $exit_code" '{code:2,message:$message}')
        fi

        payload="$(_build_span_payload "$SERVICE_NAME" "$SPAN_NAME" "otel-span" "$start_ns" "$end_ns" "$attrs_json" "$status_json")"
        _otel_deliver "$payload"

        if [ -n "$LOG_URL" ]; then
          _log_trace_url "$TRACE_ID"
        fi

        exit "$exit_code"
      }

      _top_help() {
        cat <<'HELP'
    Usage: otel-span <subcommand> [args...]

    OTLP trace span CLI. Delivers spans via spool file or HTTP POST.

    Subcommands:
      run        Wrap a command in an OTLP trace span
      emit-span  Emit one typed OTLP span without wrapping a command
      emit       Deliver a raw OTLP JSON payload from stdin

    Run 'otel-span <subcommand> --help' for subcommand-specific help.
  HELP
      }

      case "''${1:-}" in
        run) shift; _cmd_run "$@" ;;
        emit-span) shift; _cmd_emit_span "$@" ;;
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
