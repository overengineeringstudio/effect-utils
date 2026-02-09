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
  # Wrap a task exec string with otel-span tracing.
  # When OTEL is available, the exec body runs inside an otel-span child span.
  # When OTEL is not available, the exec body runs directly (zero overhead).
  #
  # The span includes task.cached=false attribute to distinguish from cached runs.
  #
  # Args:
  #   taskName: string - The span name (e.g., "ts:check", "pnpm:install:genie")
  #   execBody: string - The original exec script body
  #
  # Returns: string - A new exec script that wraps the original with otel-span
  traceExec = taskName: execBody: ''
    if command -v otel-span >/dev/null 2>&1 && [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
      otel-span "dt-task" "${taskName}" --attr "task.cached=false" -- bash -c ${lib.escapeShellArg execBody}
    else
      ${execBody}
    fi
  '';

  # Wrap a task's exec and status scripts to track cache hits.
  # When the status check passes (task is cached), emits a minimal span with task.cached=true.
  # When the task runs, emits a normal span with task.cached=false.
  #
  # Args:
  #   taskName: string - The span name (e.g., "pnpm:install:genie")
  #   taskAttrs: attrset - Must contain { exec, status } strings, may contain other attrs
  #
  # Returns: attrset - Modified { exec, status } with tracing, other attrs preserved
  #
  # Note: The status script emits a span only when cached (exit 0).
  # This adds minimal overhead since otel-span with "true" is fast (~5ms).
  withStatus = taskName: { exec, status, ... }@attrs:
    attrs // {
      exec = ''
        if command -v otel-span >/dev/null 2>&1 && [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
          otel-span "dt-task" "${taskName}" --attr "task.cached=false" -- bash -c ${lib.escapeShellArg exec}
        else
          ${exec}
        fi
      '';
      status = ''
        _trace_status_exit=0
        (${status}) || _trace_status_exit=$?
        if [ "$_trace_status_exit" -eq 0 ]; then
          # Task is cached - emit a minimal span to record it
          if command -v otel-span >/dev/null 2>&1 && [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
            otel-span "dt-task" "${taskName}" --attr "task.cached=true" -- true 2>/dev/null || true
          fi
        fi
        exit "$_trace_status_exit"
      '';
    };

  # Wrap only the status script to emit a span when cached.
  # Use this when exec is already wrapped with trace.exec or doesn't need tracing.
  #
  # Args:
  #   taskName: string - The span name
  #   statusBody: string - The original status script body
  #
  # Returns: string - Modified status script that emits span when cached
  #
  # Note: Spans are emitted even without TRACEPARENT (as orphan spans) so they
  # still appear in queries. This is necessary because devenv runs status checks
  # before dt sets up the parent trace context.
  traceStatus = taskName: statusBody: ''
    _trace_status_exit=0
    (${statusBody}) || _trace_status_exit=$?
    if [ "$_trace_status_exit" -eq 0 ]; then
      # Task is cached - emit a minimal span to record it
      if command -v otel-span >/dev/null 2>&1 && [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
        otel-span "dt-task" "${taskName}" --attr "task.cached=true" -- true 2>/dev/null || true
      fi
    fi
    exit "$_trace_status_exit"
  '';
in
{
  exec = traceExec;
  status = traceStatus;
  withStatus = withStatus;
}
