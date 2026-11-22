# Runner-independent capture boundary. The existing identity helper and native
# converter remain the sole trace authorities; telemetry never changes a verdict.
{
  pkgs,
  buck2,
  events,
  otelSpan,
}:
pkgs.writeShellScript "worktree-buck-trace" ''
  set -euo pipefail
  buck_args=("$@")
  command_index=0
  while (( command_index < ''${#buck_args[@]} )); do
    case "''${buck_args[command_index]}" in
      --isolation-dir|--config|-c|--config-file|--chdir|--verbose|-v|--oncall|--client-metadata|--setting|--agent-context)
        command_index=$((command_index + 2)) ;;
      -*) command_index=$((command_index + 1)) ;;
      *) break ;;
    esac
  done
  command="''${buck_args[command_index]:-}"
  case "$command" in
    build|test|run) ;;
    *) exec ${buck2}/bin/buck2 "$@" ;;
  esac
  # Reuse registered trace-only identity; never infer an internal person principal.
  span_identity_args=()
  actor="''${FRACTAL_AGENT:-''${ST_AGENT:-}}"
  if [ -n "$actor" ]; then span_identity_args+=(--attr-string "agent.actor.id=$actor"); fi
  revision="''${VCS_REF_HEAD_REVISION:-}"
  if [ -z "$revision" ]; then revision="$(${pkgs.git}/bin/git -C "$WORKSPACE_ROOT" rev-parse HEAD 2>/dev/null)" || revision=""; fi
  if [ -n "$revision" ]; then span_identity_args+=(--attr-string "vcs.ref.head.revision=$revision"); fi
  spool="''${PIPELINE_SPOOL_DIR:-$WORKSPACE_ROOT/.worktree-tools/otel}/buck2"
  event_log=""
  sidecar=""
  caller_uuid="''${BUCK2_CALLER_UUID:-}"
  unset BUCK2_CALLER_UUID BUCK_WRAPPER_UUID BUCK_COMMAND_SPAN_ID BUCK_COMMAND_START_NS \
    BUCK_COMMAND_TRACE_ID BUCK_COMMAND_PARENT_SPAN_ID
  if [ -n "$caller_uuid" ]; then export BUCK_WRAPPER_UUID="$caller_uuid"; fi
  if ${pkgs.coreutils}/bin/mkdir -p "$spool"; then
    command_key="buck-$(${pkgs.coreutils}/bin/date +%s%N)-$$"
    event_log="$spool/$command_key.pb.zst"
    sidecar="$spool/$command_key.sidecar"
    prefix_count=$((command_index + 1))
    buck_args=("''${buck_args[@]:0:prefix_count}" --event-log "$event_log" \
      --write-build-id "$spool/$command_key.buck-trace-id" "''${buck_args[@]:prefix_count}")
    identity_args=(--sidecar "$sidecar")
    if [ -n "$caller_uuid" ]; then identity_args+=(--uuid "$caller_uuid"); fi
    if prepared="$(${otelSpan}/bin/otel-span buck2 "''${identity_args[@]}")"; then
      eval "$prepared"
    fi
  fi
  buck_exit=0
  ${buck2}/bin/buck2 "''${buck_args[@]}" || buck_exit=$?
  command_end_ns="$(${pkgs.coreutils}/bin/date +%s%N)" || command_end_ns=""
  if [ -n "''${BUCK_COMMAND_TRACE_ID:-}" ] && [ -n "$command_end_ns" ]; then
    command_status=ok
    if [ "$buck_exit" -ne 0 ]; then command_status=error; fi
    DEVENV_ROOT="$WORKSPACE_ROOT" OTEL_EXPORTER_OTLP_ENDPOINT="''${OTELITE_HTTP_ENDPOINT:-''${OTEL_EXPORTER_OTLP_ENDPOINT:-}}" \
      ${otelSpan}/bin/otel-span emit-span effect-utils-buck2-client "buck2.command $command" \
      --trace-id "$BUCK_COMMAND_TRACE_ID" --parent-span-id "$BUCK_COMMAND_PARENT_SPAN_ID" \
      --span-id "$BUCK_COMMAND_SPAN_ID" --start-time-ns "$BUCK_COMMAND_START_NS" \
      --end-time-ns "$command_end_ns" --status-code "$command_status" \
      --attr-string "span.label=$command" --attr-int "exit.code=$buck_exit" "''${span_identity_args[@]}" || true
  fi
  # Pipeline closure owns later ingest/export and retention of its own logs.
  if [ -z "''${PIPELINE_SPOOL_DIR:-}" ] && [ -n "$event_log" ] && [ -s "$event_log" ]; then
    OTEL_EXPORTER_OTLP_ENDPOINT="''${OTEL_EXPORTER_OTLP_ENDPOINT:-''${OTELITE_HTTP_ENDPOINT:-}}" \
      ${pkgs.coreutils}/bin/timeout -k 5 60 \
      ${events}/bin/buck2-events ingest "$event_log" --sidecar "$sidecar" \
        --spool-dir "$spool/pending" || true
    OTEL_EXPORTER_OTLP_ENDPOINT="''${OTEL_EXPORTER_OTLP_ENDPOINT:-''${OTELITE_HTTP_ENDPOINT:-}}" \
      ${pkgs.coreutils}/bin/timeout -k 5 60 \
      ${events}/bin/buck2-events export --spool-dir "$spool/pending" || true
  fi
  exit "$buck_exit"
''
