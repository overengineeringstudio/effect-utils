# otel-span: OTLP trace span CLI.
#
# Delivers spans via spool file ($OTEL_SPAN_SPOOL_DIR) or HTTP POST (fallback).
#
# Subcommands:
#   run       — wrap a command in an OTLP trace span
#   emit-span — emit one OTLP span with typed attributes
#   buck2     — prepare Buck command identity and sidecar (never runs Buck)
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
        ${pkgs.coreutils}/bin/od -An -tx1 -N"$len" /dev/urandom | ${pkgs.coreutils}/bin/tr -d ' \n'
      }

      _is_hex_len() {
        local value="$1"
        local len="$2"
        [[ "$value" =~ ^[0-9a-f]{$len}$ ]]
      }

      _valid_traceparent() {
        [[ "$1" =~ ^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$ ]] &&
          [[ "''${BASH_REMATCH[1]}" != 00000000000000000000000000000000 ]] &&
          [[ "''${BASH_REMATCH[2]}" != 0000000000000000 ]]
      }

      _validate_trace_id() {
        _is_hex_len "$1" 32 && [[ "$1" != 00000000000000000000000000000000 ]] ||
          { echo "otel-span: invalid trace id: $1" >&2; exit 1; }
      }

      _validate_span_id() {
        _is_hex_len "$1" 16 && [[ "$1" != 0000000000000000 ]] ||
          { echo "otel-span: invalid span id: $1" >&2; exit 1; }
      }

      _resolve_trace_context() {
        local _tp_source="''${OTEL_TASK_TRACEPARENT:-''${TRACEPARENT:-}}"
        TRACE_FLAGS=01
        if _valid_traceparent "$_tp_source"; then
          local _tp_trace="''${BASH_REMATCH[1]}" _tp_parent="''${BASH_REMATCH[2]}"
          TRACE_FLAGS="''${BASH_REMATCH[3]}"
          TRACE_ID="''${TRACE_ID:-$_tp_trace}"
          PARENT_SPAN_ID="''${PARENT_SPAN_ID:-$_tp_parent}"
        fi

        TRACE_ID="''${TRACE_ID:-$(_gen_hex 16)}"
        SPAN_ID="''${SPAN_ID:-$(_gen_hex 8)}"
        _validate_trace_id "$TRACE_ID"
        _validate_span_id "$SPAN_ID"
        if [[ -n "''${PARENT_SPAN_ID:-}" ]]; then

          _validate_span_id "$PARENT_SPAN_ID"
        fi
      }
      # Binary framing is shared with buck2-evidence: domain NUL, then each
      # UTF-8 input as u32be(byte length) + bytes.
      _u32be() {
        local n=$1 bytes
        printf -v bytes '\\%03o\\%03o\\%03o\\%03o' \
          "$(( (n >> 24) & 255 ))" "$(( (n >> 16) & 255 ))" \
          "$(( (n >> 8) & 255 ))" "$(( n & 255 ))"
        printf '%b' "$bytes"
      }

      _frame() {
        local LC_ALL=C
        _u32be "''${#1}"
        printf '%s' "$1"
      }

      _derive_pipeline_id() {
        local domain=$1 length=$2 run=$3 job="''${4:-}" counter=0 digest result
        while :; do
          digest="$(
            {
              printf '%s\0' "$domain"
              _frame "$run"
              if [[ "$domain" == "buck2.pipeline-run.job/v1" ]]; then _frame "$job"; fi
              if (( counter > 0 )); then _u32be "$counter"; fi
            } | ${pkgs.coreutils}/bin/sha256sum
          )"
          result="''${digest:0:length}"
          if [[ "$result" != "$(printf '%0*d' "$length" 0)" ]]; then
            printf '%s' "$result"
            return
          fi
          ((counter += 1))
        done
      }

      _valid_ci_component() {
        local component=$1 char hex byte i
        [[ -n "$component" ]] || return 1
        {
          for ((i = 0; i < ''${#component}; i++)); do
            char="''${component:i:1}"
            if [[ "$char" == "%" ]]; then
              hex="''${component:i+1:2}"
              [[ "$hex" =~ ^[0-9A-F]{2}$ ]] || return 1
              byte=$((16#$hex))
              # Canonical RFC 3986 encoding leaves unreserved bytes literal.
              if (( (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) ||
                    (byte >= 48 && byte <= 57) || byte == 45 || byte == 46 ||
                    byte == 95 || byte == 126 )); then return 1; fi
              printf '%b' "\\x$hex"
              ((i += 2))
            else
              [[ "$char" =~ ^[a-zA-Z0-9._~-]$ ]] || return 1
              printf '%s' "$char"
            fi
          done
        } | ${if pkgs.stdenv.hostPlatform.isDarwin then pkgs.libiconv else pkgs.glibc.bin}/bin/iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1
      }

      _valid_pipeline_run_id() {
        local id=$1 provider repo run attempt
        if [[ "$id" =~ ^local/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
          return 0
        fi
        if [[ "$id" =~ ^ci/([^/]+)/([^/]+)/([^/]+)/([1-9][0-9]*)$ ]]; then
          provider="''${BASH_REMATCH[1]}" repo="''${BASH_REMATCH[2]}" run="''${BASH_REMATCH[3]}" attempt="''${BASH_REMATCH[4]}"
          local component
          for component in "$provider" "$repo" "$run"; do
            _valid_ci_component "$component" || return 1
          done
          return 0
        fi
        return 1
      }

      _cmd_pipeline_derive() {
        local id=$1 job=$2
        _valid_pipeline_run_id "$id" || { echo "otel-span: invalid PIPELINE_RUN_ID: $id" >&2; return 1; }
        [[ -n "$job" ]] || { echo "otel-span: missing PIPELINE_TASK_KEY" >&2; return 1; }
        printf 'trace=%s root=%s job=%s\n' \
          "$(_derive_pipeline_id buck2.pipeline-run.trace/v1 32 "$id")" \
          "$(_derive_pipeline_id buck2.pipeline-run.root/v1 16 "$id")" \
          "$(_derive_pipeline_id buck2.pipeline-run.job/v1 16 "$id" "$job")"
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
        local link_traceparent="''${LINK_TRACEPARENT:-}"
        if [[ -n "$link_traceparent" ]]; then
          _valid_traceparent "$link_traceparent" || { echo "otel-span: invalid link traceparent" >&2; return 1; }
        fi

        "$_jq" -n \
          --arg service_name "$service_name" \
          --arg devenv_root "$root" \
          --arg scope_name "$scope_name" \
          --arg trace_id "$TRACE_ID" \
          --arg span_id "$SPAN_ID" \
          --arg parent_span_id "''${PARENT_SPAN_ID:-}" \
          --arg link_traceparent "$link_traceparent" \
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
                } + (if $parent_span_id == "" then {} else {parentSpanId: $parent_span_id} end) + (if $link_traceparent == "" then {} else {links:[{traceId:($link_traceparent|split("-")[1]),spanId:($link_traceparent|split("-")[2])}]} end))]
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

      _buck2_usage() {
        cat <<'USAGE'
    Usage: otel-span buck2 --sidecar <path>

    Prints shell-safe exports for a Buck command span. Evaluate the output in
    the caller's shell before invoking Buck directly; after Buck exits, emit
    the completed span with otel-span emit-span and BUCK_COMMAND_SPAN_ID.
    Invalid or absent trace context leaves BUCK_WRAPPER_UUID unset.
  USAGE
      }

      _cmd_buck2() {
        local sidecar=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --help) _buck2_usage; return 0 ;;
            --sidecar)
              if [[ $# -lt 2 || -z "$2" ]]; then
                echo "otel-span buck2: --sidecar requires a path" >&2
                return 1
              fi
              sidecar="$2"
              shift 2
              ;;
            *)
              echo "otel-span buck2: unexpected argument: $1" >&2
              return 1
              ;;
          esac
        done
        if [[ -z "$sidecar" ]]; then
          echo "otel-span buck2: --sidecar is required" >&2
          return 1
        fi

        local span_id start_ns tp trace_id parent_id flags digest uuid command_tp
        span_id="$(_gen_hex 8)"
        start_ns="$(${pkgs.coreutils}/bin/date +%s%N)"
        printf 'export BUCK_COMMAND_SPAN_ID=%s BUCK_COMMAND_START_NS=%s\n' "$span_id" "$start_ns"

        tp="''${OTEL_TASK_TRACEPARENT:-''${TRACEPARENT:-}}"
        # W3C version 00 requires a 32-hex trace id, 16-hex parent id, and
        # two hex flags. Neither id may be all zero. Never trust a partially
        # parsed context: Buck rejects malformed BUCK_WRAPPER_UUID at startup.
        if _valid_traceparent "$tp"; then
          trace_id="''${BASH_REMATCH[1]}"
          parent_id="''${BASH_REMATCH[2]}"
          flags="''${BASH_REMATCH[3]}"
          digest="$(printf '%s' "$trace_id:$span_id" | ${pkgs.coreutils}/bin/sha256sum)"
          digest="''${digest%% *}"
          digest="''${digest:0:32}"
          uuid="''${digest:0:8}-''${digest:8:4}-''${digest:12:4}-''${digest:16:4}-''${digest:20:12}"
          command_tp="00-$trace_id-$span_id-$flags"
          if ! printf '%s %s\n' "$uuid" "$command_tp" >> "$sidecar"; then
            echo "otel-span buck2: cannot append sidecar: $sidecar" >&2
          fi
          printf 'export BUCK_COMMAND_TRACE_ID=%s BUCK_COMMAND_PARENT_SPAN_ID=%s BUCK_WRAPPER_UUID=%s\n' \
            "$trace_id" "$parent_id" "$uuid"
          return 0
        fi
        printf 'unset BUCK_COMMAND_TRACE_ID BUCK_COMMAND_PARENT_SPAN_ID BUCK_WRAPPER_UUID\n'
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
        LINK_TRACEPARENT=""
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
            --link-traceparent) LINK_TRACEPARENT="$2"; shift 2 ;;
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
        LINK_TRACEPARENT=""
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
            --link-traceparent) LINK_TRACEPARENT="$2"; shift 2 ;;
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
        if [[ -n "$TRACE_ID" ]]; then _validate_trace_id "$TRACE_ID"; fi
        if [[ -n "$SPAN_ID" ]]; then _validate_span_id "$SPAN_ID"; fi
        if [[ -n "$PARENT_SPAN_ID" ]]; then _validate_span_id "$PARENT_SPAN_ID"; fi

        if ! _otel_delivery_configured; then
          exec "''${CMD_ARGS[@]}"
        fi

        _resolve_trace_context

        export TRACEPARENT="00-$TRACE_ID-$SPAN_ID-$TRACE_FLAGS"
        export OTEL_TASK_TRACEPARENT="$TRACEPARENT"

        local start_ns end_ns exit_code attrs_json status_json payload
        start_ns="''${START_TIME_NS:-$(${pkgs.coreutils}/bin/date +%s%N)}"
        local forward_file
        forward_file="$(${pkgs.coreutils}/bin/mktemp)"
        export OTEL_SPAN_FORWARD_LINK_FILE="$forward_file"

        exit_code=0
        "''${CMD_ARGS[@]}" || exit_code=$?
        if [[ -s "$forward_file" ]]; then
          LINK_TRACEPARENT="$(< "$forward_file")"
        fi
        ${pkgs.coreutils}/bin/rm -f "$forward_file"
        unset OTEL_SPAN_FORWARD_LINK_FILE

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

      _cmd_pipeline_run() {
        if [[ "''${1:-}" == "--help" ]]; then
          echo "Usage: otel-span pipeline-run -- devenv tasks run <verb> [args...]"
          return 0
        fi
        [[ "''${1:-}" == "--" && $# -gt 1 ]] ||
          { echo "otel-span pipeline-run: expected -- <command> [args...]" >&2; return 2; }
        shift
        local owner=0 nested=0 invalid=0 run_id job_key trace_id root_id job_id
        local inherited="''${OTEL_TASK_TRACEPARENT:-''${TRACEPARENT:-}}" outer="" rc=0 signal=""
        if [[ ! -v PIPELINE_RUN_ID ]]; then
          run_id="local/$(${pkgs.util-linux}/bin/uuidgen | ${pkgs.coreutils}/bin/tr '[:upper:]' '[:lower:]')"
          owner=1
        else
          run_id="$PIPELINE_RUN_ID"
        fi
        job_key="''${PIPELINE_TASK_KEY:-worker/local}"
        if ! _valid_pipeline_run_id "$run_id" || [[ -z "$job_key" ]]; then
          echo "otel-span pipeline-run: invalid pipeline identity; running without seeded telemetry" >&2
          invalid=1
        fi
        if (( invalid )); then
          "$@"
          return $?
        fi
        trace_id="$(_derive_pipeline_id buck2.pipeline-run.trace/v1 32 "$run_id")"
        root_id="$(_derive_pipeline_id buck2.pipeline-run.root/v1 16 "$run_id")"
        job_id="$(_derive_pipeline_id buck2.pipeline-run.job/v1 16 "$run_id" "$job_key")"
        export PIPELINE_RUN_ID="$run_id" PIPELINE_TASK_KEY="$job_key"
        export PIPELINE_TRACE_ID="$trace_id" PIPELINE_ROOT_SPAN_ID="$root_id" PIPELINE_TASK_SPAN_ID="$job_id"
        if (( owner )); then export PIPELINE_ROOT_OWNER=entrypoint; fi
        # A nested task stays beneath its active span, not a second job/root.
        if [[ "''${PIPELINE_ROOT_OWNER:-}" == entrypoint ]] && _valid_traceparent "$inherited" &&
          [[ "''${BASH_REMATCH[1]}" == "$trace_id" ]] && (( ! owner )); then
          nested=1
        fi
        if _valid_traceparent "$inherited" && [[ "''${BASH_REMATCH[1]}" != "$trace_id" ]]; then
          outer="$inherited"
        fi
        unset OTEL_TASK_TRACEPARENT
        if (( nested )); then
          export TRACEPARENT="$inherited"
        else
          export TRACEPARENT="00-$trace_id-$job_id-01"
        fi
        export OTEL_TASK_TRACEPARENT="$TRACEPARENT"
        if [[ -z "''${PIPELINE_REPOSITORY:-}" ]]; then
          local origin repo_owner repo_name
          origin="$(${pkgs.git}/bin/git -C "''${DEVENV_ROOT:-$PWD}" remote get-url origin 2>/dev/null || true)"
          if [[ "$origin" =~ ^https?://[^/]+/([a-zA-Z0-9_.-]+)/([a-zA-Z0-9_.-]+)/?$ ]] ||
            [[ "$origin" =~ ^[^/@:]+@[^/:]+:([a-zA-Z0-9_.-]+)/([a-zA-Z0-9_.-]+)$ ]] ||
            [[ "$origin" =~ ^ssh://[^/@]+@[^/]+/([a-zA-Z0-9_.-]+)/([a-zA-Z0-9_.-]+)$ ]]; then
            repo_owner="''${BASH_REMATCH[1]}"
            repo_name="''${BASH_REMATCH[2]%.git}"
            if [[ -n "$repo_name" ]]; then
              export PIPELINE_REPOSITORY="$repo_owner/$repo_name"
            fi
          fi
        fi

        if (( owner )) || [[ -z "''${PIPELINE_SPOOL_DIR:-}" ]]; then
          export PIPELINE_SPOOL_DIR="''${DEVENV_ROOT:-$PWD}/.devenv/otel/run-records/$trace_id-$job_id"
        fi
        if ${pkgs.coreutils}/bin/mkdir -p "$PIPELINE_SPOOL_DIR/spans" "$PIPELINE_SPOOL_DIR/buck2" 2>/dev/null; then
          export OTEL_SPAN_SPOOL_DIR="$PIPELINE_SPOOL_DIR/spans"
          export OTEL_SPOOL_MULTI_WRITER=1
        else
          echo "otel-span pipeline-run: cannot create evidence spool; continuing" >&2
          unset PIPELINE_SPOOL_DIR OTEL_SPAN_SPOOL_DIR
        fi
        if (( owner )) && [[ -n "$outer" && -n "''${OTEL_SPAN_FORWARD_LINK_FILE:-}" ]]; then
          printf '00-%s-%s-01\n' "$trace_id" "$root_id" > "$OTEL_SPAN_FORWARD_LINK_FILE" || true
        fi
        local start_ns end_ns child
        start_ns="$(${pkgs.coreutils}/bin/date +%s%N)"
        ${pkgs.util-linux}/bin/setsid "$@" & child=$!
        _pipeline_signal() {
          signal=$1
          kill -s TERM -- "-$child" 2>/dev/null || kill -s TERM "$child" 2>/dev/null || true
        }
        trap '_pipeline_signal INT' INT
        trap '_pipeline_signal TERM' TERM
        wait "$child" || rc=$?
        if [[ -n "$signal" ]]; then
          trap ':' INT TERM
          wait "$child" 2>/dev/null || true
          if [[ "$signal" == INT ]]; then rc=130; else rc=143; fi
        fi
        trap - INT TERM
        end_ns="$(${pkgs.coreutils}/bin/date +%s%N)"
        if (( owner )); then
          local status=ok link_args=()
          (( rc == 0 )) || status=error
          if [[ -n "$outer" ]]; then link_args=(--link-traceparent "$outer"); fi
          (
            unset TRACEPARENT OTEL_TASK_TRACEPARENT
            "$0" emit-span effect-utils-devenv cicd.pipeline.task.run \
              --trace-id "$trace_id" --span-id "$job_id" --parent-span-id "$root_id" \
              --start-time-ns "$start_ns" --end-time-ns "$end_ns" \
              --status-code "$status" --attr "cicd.pipeline.task.name=$job_key" \
              --attr "cicd.pipeline.run.id=$run_id" || true
            "$0" emit-span effect-utils-devenv cicd.pipeline.run \
              --trace-id "$trace_id" --span-id "$root_id" \
              --start-time-ns "$start_ns" --end-time-ns "$end_ns" \
              --status-code "$status" --attr "cicd.pipeline.run.id=$run_id" \
              --attr-int "exit.code=$rc" "''${link_args[@]}" || true
          )
        fi
        if (( ! nested )) && [[ -n "''${PIPELINE_SPOOL_DIR:-}" ]] && command -v buck2-evidence >/dev/null 2>&1; then
          if ${pkgs.coreutils}/bin/timeout -k 2 15 buck2-evidence seal \
            --spool "$PIPELINE_SPOOL_DIR" --run-id "$run_id" --task-key "$job_key"; then
            if [[ -n "''${OTELITE_HTTP_ENDPOINT:-''${OTEL_EXPORTER_OTLP_ENDPOINT:-}}" ]]; then
              OTEL_EXPORTER_OTLP_ENDPOINT="''${OTELITE_HTTP_ENDPOINT:-$OTEL_EXPORTER_OTLP_ENDPOINT}" \
                ${pkgs.coreutils}/bin/timeout -k 2 60 buck2-evidence ingest --local \
                  --spool "$PIPELINE_SPOOL_DIR" ||
                echo "otel-span pipeline-run: local ingest failed" >&2
            fi
          else
            echo "otel-span pipeline-run: evidence seal failed" >&2
          fi
        fi
        printf 'pipeline run=%s trace=%s exit=%s\n' "$run_id" "$trace_id" "$rc" >&2
        return "$rc"
      }

      _top_help() {
        cat <<'HELP'
    Usage: otel-span <subcommand> [args...]

    OTLP trace span CLI. Delivers spans via spool file or HTTP POST.

    Subcommands:
      run        Wrap a command in an OTLP trace span
      pipeline-run  Seed a pipeline trace around a devenv task verb
      buck2      Prepare Buck command identity without wrapping Buck
      emit-span  Emit one typed OTLP span without wrapping a command
      emit       Deliver a raw OTLP JSON payload from stdin

    Run 'otel-span <subcommand> --help' for subcommand-specific help.
  HELP
      }

      case "''${1:-}" in
        run) shift; _cmd_run "$@" ;;
        emit-span) shift; _cmd_emit_span "$@" ;;
        pipeline-derive) shift; _cmd_pipeline_derive "$@" ;;
        pipeline-run) shift; _cmd_pipeline_run "$@" ;;
        buck2) shift; _cmd_buck2 "$@" ;;
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
