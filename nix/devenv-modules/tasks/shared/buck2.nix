# Imported by the shared check module, including downstream repositories.
{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
let
  cfg = config.effectUtils.buck2;
  trace = import ../lib/trace.nix { inherit lib; };
  # Buck2 invokes "watchman" through PATH, not a WATCHMAN_BINARY selector.
  # Exec the host binary in place to preserve its signature and permissions.
  watchman =
    if cfg.watchmanBin == null then
      pkgs.watchman
    else
      pkgs.writeShellScriptBin "watchman" ''
        exec ${lib.escapeShellArg cfg.watchmanBin} "$@"
      '';

  aggregateExec =
    taskName: argv:
    trace.exec taskName ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      export PATH=${lib.makeBinPath [ watchman ]}
      cd "$root"
      ${cfg.prepare}

      # Pipeline logs join their job trace after the task graph. Standalone
      # Buck commands convert locally, retaining unacknowledged OTLP chunks.
      pipeline_spool=0
      spool=""
      if [ -n "''${PIPELINE_SPOOL_DIR:-}" ]; then
        spool="$PIPELINE_SPOOL_DIR/buck2"
        pipeline_spool=1
        ${pkgs.coreutils}/bin/mkdir -p "$spool" || spool=""
      elif ${pkgs.coreutils}/bin/mkdir -p "$root/.devenv/otel/buck2-events"; then
        spool="$(${pkgs.coreutils}/bin/mktemp -d "$root/.devenv/otel/buck2-events/${taskName}.XXXXXXXX")" || spool=""
      fi
      pending="''${spool:-$root/.devenv/otel/buck2-events}/pending"
      if (( pipeline_spool )); then pending="$PIPELINE_SPOOL_DIR/pending"; fi
      buck_args=(${lib.escapeShellArgs argv})
      command_key="${taskName}-$(${pkgs.coreutils}/bin/date +%s%N)-$$"
      census_host="$(${pkgs.coreutils}/bin/uname -n)"
      unset BUCK_WRAPPER_UUID BUCK_COMMAND_SPAN_ID BUCK_COMMAND_START_NS \
        BUCK_COMMAND_TRACE_ID BUCK_COMMAND_PARENT_SPAN_ID
      if [ -n "$spool" ]; then
        # Keep the same invocation key even if tracing cannot be prepared.
        event_log="$spool/$command_key.pb.zst"
        sidecar="$spool/$command_key.sidecar"
        buck_args+=(--event-log "$event_log" --write-build-id "$spool/$command_key.buck-trace-id")
        if prepared="$("''${OTEL_SPAN_BIN:-otel-span}" buck2 --sidecar "$sidecar")"; then
          eval "$prepared"
        fi
      fi

      # The census is outside the disposable worktree and independent of OTLP.
      # An unmatched open is unknown coverage, never a successful zero-action run.
      census_capture=()
      ${cfg.eventsPackage}/bin/buck2-events census --invocation-id "$command_key" \
        --phase open --host "$census_host" --spool-dir "$pending" ||
        { census_capture=(--capture-error); printf '%s: invocation-open capture failed; coverage unknown\n' '${taskName}' >&2; }
      if "$BUCK2_BIN" "''${buck_args[@]}"; then
        buck_exit=0
      else
        buck_exit=$?
      fi
      census_build=()
      if [ -n "$spool" ] && [ -s "$spool/$command_key.buck-trace-id" ]; then
        census_build=(--build-id "$(< "$spool/$command_key.buck-trace-id")")
      fi
      ${cfg.eventsPackage}/bin/buck2-events census --invocation-id "$command_key" \
        --phase terminal --host "$census_host" --spool-dir "$pending" \
        --exit-code "$buck_exit" "''${census_build[@]}" "''${census_capture[@]}" ||
        printf '%s: invocation-terminal capture failed; coverage unknown\n' '${taskName}' >&2
      if [ "$buck_exit" -ne 0 ]; then
        if [ -n "$spool" ]; then
          printf '%s: Buck exited with code %s; event log: %s\n' '${taskName}' "$buck_exit" "$event_log" >&2
        else
          printf '%s: Buck exited with code %s; no event log\n' '${taskName}' "$buck_exit" >&2
        fi
      fi
      command_end_ns="$(${pkgs.coreutils}/bin/date +%s%N)" || command_end_ns=""
      if [ -n "''${BUCK_COMMAND_TRACE_ID:-}" ] && [ -n "$command_end_ns" ]; then
        command_status=ok
        if [ "$buck_exit" -ne 0 ]; then command_status=error; fi
        OTEL_EXPORTER_OTLP_ENDPOINT="''${OTELITE_HTTP_ENDPOINT:-''${OTEL_EXPORTER_OTLP_ENDPOINT:-}}" \
          "''${OTEL_SPAN_BIN:-otel-span}" emit-span "effect-utils-devenv" "buck2.command ''${buck_args[0]}" \
          --trace-id "$BUCK_COMMAND_TRACE_ID" \
          --parent-span-id "$BUCK_COMMAND_PARENT_SPAN_ID" \
          --span-id "$BUCK_COMMAND_SPAN_ID" \
          --start-time-ns "$BUCK_COMMAND_START_NS" \
          --end-time-ns "$command_end_ns" \
          --status-code "$command_status" \
          --attr-int "exit.code=$buck_exit" || true
      fi
      if (( ! pipeline_spool )) && [ -n "$spool" ] && [ -s "$event_log" ]; then
        OTEL_EXPORTER_OTLP_ENDPOINT="''${OTEL_EXPORTER_OTLP_ENDPOINT:-''${OTELITE_HTTP_ENDPOINT:-}}" \
          ${pkgs.coreutils}/bin/timeout -k 5 60 \
          ${cfg.eventsPackage}/bin/buck2-events ingest "$event_log" --sidecar "$sidecar" \
            --spool-dir "$pending" || true
      fi
      if (( ! pipeline_spool )); then
        OTEL_EXPORTER_OTLP_ENDPOINT="''${OTEL_EXPORTER_OTLP_ENDPOINT:-''${OTELITE_HTTP_ENDPOINT:-}}" \
          ${pkgs.coreutils}/bin/timeout -k 5 60 \
          ${cfg.eventsPackage}/bin/buck2-events export --spool-dir "$pending" || true
      fi
      exit "$buck_exit"
    '';
in
{
  options.effectUtils.buck2 = {
    watchmanBin = lib.mkOption {
      type = lib.types.nullOr (lib.types.strMatching "/.*");
      default = null;
      example = "/usr/local/bin/watchman";
      description = ''
        Absolute host Watchman executable for aggregate tasks, or null to use
        nixpkgs Watchman. Set in devenv.local.nix for a signed macOS installation.
        A task-local launcher exposes exactly this executable as watchman;
        the inherited PATH is never searched or preserved.
      '';
    };

    aggregateExec = lib.mkOption {
      type = lib.types.functionTo (lib.types.functionTo lib.types.str);
      readOnly = true;
      default = aggregateExec;
      description = "Instrumented Buck2 task exec: task name, then Buck2 argv (including subcommand).";
    };
    eventsPackage = lib.mkOption {
      type = lib.types.package;
      default = inputs.effect-utils.packages.${pkgs.stdenv.hostPlatform.system}.buck2-events;
      description = "Buck2 event-log converter used for standalone trace export.";
    };
    prepare = lib.mkOption {
      type = lib.types.lines;
      default = "";
      description = "Repository-specific setup before running instrumented Buck2 commands.";
    };
  };
}
