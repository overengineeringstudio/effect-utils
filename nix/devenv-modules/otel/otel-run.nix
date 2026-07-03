# otel-run: mint a fresh root trace around a command and print its Grafana link.
#
# A thin wrapper over `otel-span run` that closes the gaps which make a raw
# `otel-span run` inconvenient for ad-hoc "just trace this task" use:
#   - FRESH ROOT by default: unsets ambient TRACEPARENT / OTEL_TASK_TRACEPARENT
#     so the command's spans form their own trace instead of joining the
#     surrounding shell/agent session trace. `--join` opts into joining the
#     ambient trace instead (and does NOT mint a new trace id — otel-span
#     inherits both the trace and the parent from the environment).
#   - LABEL derived from argv: `devenv tasks run <task>` -> `<task>`, else the
#     basename of argv[0]. `--label` overrides.
#   - REACHABLE ENDPOINT: the devenv shell often exports an
#     OTEL_EXPORTER_OTLP_ENDPOINT that points at a devenv-local collector which
#     is not running (no `devenv up`), so spans silently fail to export. We
#     probe the configured endpoint with a TCP connect and fall back to the
#     standard local OTLP/HTTP ingress (127.0.0.1:4318) when it is unreachable.
#   - GRAFANA LINK: after the run (even on failure — a failed run's trace is
#     the interesting one) we print the Grafana explore URL for the trace on
#     stderr. Gated on OTEL_GRAFANA_URL alone, so the link still prints when the
#     endpoint was unreachable (a warning is added in that case).
#
# The Grafana explore-URL builder below mirrors otel-span's `_log_trace_url`
# (otel/otel-span.nix) and otel.nix's `otelResolveShellState` exactly (same
# panes JSON + sed percent-encoding + TS_HOSTNAME substitution + OSC-8 link).
# This is a third copy of that builder; the two existing copies are inline shell
# in separate Nix files, so there is no shared shell fragment to reuse yet.
#
# Usage:
#   otel-run [--label <name>] [--join] [--] <command> [args...]
#
# Usage in a devenv module:
#   packages = [ (import ./otel/otel-run.nix { inherit pkgs; }) ];
{ pkgs }:
pkgs.writeShellScriptBin "otel-run" ''
  set -euo pipefail

  _label=""
  _join=0

  # Parse otel-run's own flags; stop at `--` or the first non-flag (the command).
  while [ $# -gt 0 ]; do
    case "$1" in
      --label) _label="''${2:-}"; shift 2 ;;
      --label=*) _label="''${1#--label=}"; shift ;;
      --join) _join=1; shift ;;
      --help | -h)
        cat >&2 <<'USAGE'
  Usage: otel-run [--label <name>] [--join] [--] <command> [args...]

  Mint a fresh root trace around <command> and print its Grafana link.

    --label <name>  Override the label derived from argv.
    --join          Join the ambient trace instead of minting a fresh root.
  USAGE
        exit 0
        ;;
      --)
        shift
        break
        ;;
      *) break ;;
    esac
  done

  if [ $# -eq 0 ]; then
    echo "otel-run: no command given" >&2
    exit 2
  fi

  # Derive the root label from argv when not overridden with --label.
  if [ -z "$_label" ]; then
    if [ "$1" = "devenv" ] && [ "''${2:-}" = "tasks" ] && [ "''${3:-}" = "run" ] && [ -n "''${4:-}" ]; then
      _label="$4"
    else
      _label="$(${pkgs.coreutils}/bin/basename "$1")"
    fi
  fi

  # Resolve trace context. Fresh-root: drop ambient context and mint a trace id
  # we both pin (--trace-id) and link to. Join: inherit trace + parent from the
  # environment (do NOT pass --trace-id — that would keep the ambient parent but
  # swap in a fresh trace id, orphaning the span) and parse the ambient trace id
  # for the URL.
  _trace_id=""
  _span_args=()
  if [ "$_join" -eq 1 ]; then
    _tp="''${OTEL_TASK_TRACEPARENT:-''${TRACEPARENT:-}}"
    if [[ "$_tp" =~ ^00-([0-9a-fA-F]{32})-[0-9a-fA-F]{16}-[0-9a-fA-F]{2}$ ]]; then
      _trace_id="''${BASH_REMATCH[1]}"
    fi
  else
    unset TRACEPARENT OTEL_TASK_TRACEPARENT
    _trace_id="$(${pkgs.coreutils}/bin/head -c16 /dev/urandom | ${pkgs.coreutils}/bin/od -An -tx1 | ${pkgs.coreutils}/bin/tr -d ' \n')"
    _span_args=(--trace-id "$_trace_id")
  fi

  # Probe a candidate OTLP endpoint (http://host:port[/...]) with a TCP connect.
  # A plain connect avoids POSTing junk into a live collector.
  _probe_endpoint() {
    local _url="$1" _hostport _host _port
    _hostport="''${_url#*://}"
    _hostport="''${_hostport%%/*}"
    _host="''${_hostport%%:*}"
    _port="''${_hostport##*:}"
    [ -n "$_host" ] && [ -n "$_port" ] && [ "$_host" != "$_port" ] || return 1
    ${pkgs.coreutils}/bin/timeout 1 ${pkgs.bash}/bin/bash -c "exec 3<>/dev/tcp/$_host/$_port" 2>/dev/null
  }

  # Pick the first reachable endpoint: the configured one, else the standard
  # local OTLP/HTTP ingress. Export it so both otel-span and the (possibly
  # nested) child inherit the reachable endpoint instead of a dead collector.
  _endpoint=""
  _endpoint_ok=0
  for _cand in "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" "http://127.0.0.1:4318"; do
    [ -n "$_cand" ] || continue
    [ -n "$_endpoint" ] || _endpoint="$_cand"
    if _probe_endpoint "$_cand"; then
      _endpoint="$_cand"
      _endpoint_ok=1
      break
    fi
  done
  if [ "$_endpoint_ok" -eq 1 ]; then
    export OTEL_EXPORTER_OTLP_ENDPOINT="$_endpoint"
  fi

  # Run the command inside an otel-span root span, forwarding its exit code.
  _exit=0
  otel-span run "effect-utils-devenv" "$_label" \
    ''${_span_args[@]+"''${_span_args[@]}"} \
    --attr "span.label=$_label" \
    -- "$@" || _exit=$?

  # Warn (before the link) if no OTLP endpoint was reachable, so a printed URL
  # that will dead-link is clearly caveated rather than silently misleading.
  if [ "$_endpoint_ok" -ne 1 ]; then
    printf '[otel] WARN: no reachable OTLP endpoint (%s); spans may not have landed. Start the stack with: devenv up\n' "''${_endpoint:-none}" >&2
  fi

  # Print the Grafana explore URL for the trace (mirrors otel-span's
  # _log_trace_url). Gated on OTEL_GRAFANA_URL alone; if it is unset we still
  # surface the trace id so it can be looked up manually.
  if [ -n "''${OTEL_GRAFANA_URL:-}" ] && [ -n "$_trace_id" ]; then
    _panes='{"a":{"datasource":{"type":"tempo","uid":"tempo"},"queries":[{"refId":"A","datasource":{"type":"tempo","uid":"tempo"},"queryType":"traceql","query":"'"$_trace_id"'"}],"range":{"from":"now-1h","to":"now"}}}'
    _encoded=$(printf '%s' "$_panes" | ${pkgs.gnused}/bin/sed 's/{/%7B/g;s/}/%7D/g;s/\[/%5B/g;s/\]/%5D/g;s/"/%22/g;s/:/%3A/g;s/,/%2C/g;s/ /%20/g')
    _url="$OTEL_GRAFANA_URL/explore?schemaVersion=1&panes=$_encoded&orgId=1"
    if [ -n "''${TS_HOSTNAME:-}" ]; then
      _url="''${_url//127.0.0.1/$TS_HOSTNAME}"
    fi
    _trace_label="trace:$_trace_id"
    if [ -t 2 ]; then
      printf '[otel] \e]8;;%s\x07\e[4m%s\e[24m\e]8;;\x07\n' "$_url" "$_trace_label" >&2
    else
      printf '[otel] %s %s\n' "$_trace_label" "$_url" >&2
    fi
  else
    printf '[otel] trace:%s (set OTEL_GRAFANA_URL or enter the devenv shell for a clickable link)\n' "''${_trace_id:-unknown}" >&2
  fi

  exit "$_exit"
''
