# OTEL tracing helpers for devenv tasks
#
# Wraps task `exec` scripts with `otel-span` to produce child spans
# that link to the parent trace (from the `dt` wrapper).
#
# When OTEL is available (otel-span on PATH + OTEL_EXPORTER_OTLP_ENDPOINT set),
# each task execution emits an OTLP span with service.name="dt-task".
# When OTEL is not available, the original exec runs directly.
#
# Usage in task modules:
#   let trace = import ../lib/trace.nix { inherit lib; };
#   in {
#     # Simple exec tracing (no cache tracking):
#     tasks."ts:check" = {
#       exec = trace.exec "ts:check" "tsc --build tsconfig.all.json";
#     };
#
#     # With cache tracking (emits span even when cached):
#     tasks."pnpm:install:foo" = trace.withStatus "pnpm:install:foo" {
#       exec = "pnpm install";
#       status = "[ -d node_modules ]";
#     };
#   }
#
{ lib }:
let
  traceEnvArgs = ''
    trace_args=()
    _task_traceparent="''${OTEL_TASK_TRACEPARENT:-''${TRACEPARENT:-}}"
    if [ -n "$_task_traceparent" ]; then
      IFS='-' read -r _ _trace_id _parent_span_id _ <<< "$_task_traceparent"
      if [ -n "$_trace_id" ] && [ -n "$_parent_span_id" ]; then
        trace_args=(--trace-id "$_trace_id" --parent-span-id "$_parent_span_id")
      fi
    fi
  '';

  # Wrap a task exec string with otel-span tracing.
  # When OTEL is available, the exec body runs inside an otel-span child span.
  # When OTEL is not available, the exec body runs directly (zero overhead).
  #
  # The span includes task.cached=false (OTEL bool attribute) to distinguish from cached runs.
  #
  # Args:
  #   taskName: string - The span name (e.g., "ts:check", "pnpm:install:genie")
  #   execBody: string - The original exec script body
  #
  # Returns: string - A new exec script that wraps the original with otel-span
  # TRACEPARENT propagation:
  # - Via `dt` wrapper: consume explicit `OTEL_TASK_TRACEPARENT`, because task
  #   runner internals may rewrite `TRACEPARENT` and shell-provided values can be
  #   stale across runs.
  # - During direct `devenv tasks run` usage without `dt`, `TRACEPARENT` can still
  #   be consumed by the runtime's own task wiring as part of the process env.
  # - Neither: otel-span creates a standalone root span (no orphaned parent)
  traceExec = taskName: execBody: ''
    if command -v otel-span >/dev/null 2>&1 && [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
      ${traceEnvArgs}
      otel-span run "dt-task" "${taskName}" "''${trace_args[@]}" --attr "task.cached=false" -- bash -c ${lib.escapeShellArg execBody}
    else
      ${execBody}
    fi
  '';

  # Trace status scripts so cached/skipped decisions become visible in traces.
  traceStatus = taskName: statusBody: ''
    if command -v otel-span >/dev/null 2>&1 && [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
      ${traceEnvArgs}
      _status_start_ns=$(date +%s%N)
      _status_exit=0
      bash -c ${lib.escapeShellArg statusBody} || _status_exit=$?
      _status_end_ns=$(date +%s%N)

      if [ "$_status_exit" -eq 0 ]; then
        _task_cached=true
      else
        _task_cached=false
      fi

      _trace_status_should_emit=true
      if [ -n "''${_task_traceparent:-}" ]; then
        _trace_status_should_emit=false
        _trace_status_cache_dir="''${OTEL_STATUS_SPAN_CACHE_DIR:-''${TMPDIR:-/tmp}/.dt-otel-status-spans}"
        _trace_status_key=$(printf '%s' "''${_trace_id:-na}-''${_parent_span_id:-na}-${taskName}:status" | tr -cs 'A-Za-z0-9._-' '_')
        _trace_status_cache_file="''${_trace_status_cache_dir}/''${_trace_status_key}"

        mkdir -p "''${_trace_status_cache_dir}" >/dev/null 2>&1 || true
        if (set -o noclobber; : > "''${_trace_status_cache_file}") 2>/dev/null; then
          _trace_status_should_emit=true
        fi
      fi

      if [ "$_trace_status_should_emit" = true ]; then
        otel-span run "dt-task" "${taskName}:status" "''${trace_args[@]}" \
          --attr "task.phase=status" \
          --attr "task.cached=$_task_cached" \
          --start-time-ns "$_status_start_ns" \
          --end-time-ns "$_status_end_ns" \
          -- true
      fi

      exit "$_status_exit"
    else
      ${statusBody}
    fi
  '';

  # Wrap a task's exec script with otel-span tracing.
  # Status checks are traced with a lightweight span that records the cached
  # decision (`task.cached=true` when status succeeds, `task.cached=false` otherwise).
  #
  # Args:
  #   taskName: string - The span name (e.g., "pnpm:install:genie")
  #   taskAttrs: attrset - Must contain { exec, status } strings, may contain other attrs
  #
  # Returns: attrset - Modified { exec } with tracing, status and other attrs preserved
  withStatus =
    taskName:
    { exec, status, ... }@attrs:
    attrs
    // {
      exec = ''
        if command -v otel-span >/dev/null 2>&1 && [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
          ${traceEnvArgs}
          otel-span run "dt-task" "${taskName}" "''${trace_args[@]}" --attr "task.cached=false" -- bash -c ${lib.escapeShellArg exec}
        else
          ${exec}
        fi
      '';
      # Status spans are traced to capture cached/skipped decisions.
      status = traceStatus taskName status;
    };
in
{
  exec = traceExec;
  status = traceStatus;
  withStatus = withStatus;
}
