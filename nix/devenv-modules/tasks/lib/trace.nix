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
  # TRACEPARENT propagation:
  # - Via `dt` wrapper: TRACEPARENT is set by otel-span in the dt script
  # - During shell entry: TRACEPARENT is set by setup:gate via devenv's native
  #   task output → env propagation (devenv.env convention)
  #   Ref: https://github.com/cachix/devenv/blob/main/devenv-tasks/src/task_state.rs#L134-L154
  # - Neither: otel-span creates a standalone root span (no orphaned parent)
  traceExec = taskName: execBody: ''
    if command -v otel-span >/dev/null 2>&1 && [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
      otel-span run "dt-task" "${taskName}" --attr "task.cached=false" -- bash -c ${lib.escapeShellArg execBody}
    else
      ${execBody}
    fi
  '';

  # Wrap a task's exec script with otel-span tracing.
  # Status checks are passed through without tracing (internal machinery).
  #
  # Args:
  #   taskName: string - The span name (e.g., "pnpm:install:genie")
  #   taskAttrs: attrset - Must contain { exec, status } strings, may contain other attrs
  #
  # Returns: attrset - Modified { exec } with tracing, status and other attrs preserved
  withStatus = taskName: { exec, status, ... }@attrs:
    attrs // {
      exec = ''
        if command -v otel-span >/dev/null 2>&1 && [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
          otel-span run "dt-task" "${taskName}" --attr "task.cached=false" -- bash -c ${lib.escapeShellArg exec}
        else
          ${exec}
        fi
      '';
      # Don't trace status checks — they're internal devenv machinery and
      # the overhead isn't worth it (status checks run frequently)
      inherit status;
    };

  # Pass-through for status scripts — status checks are not traced because
  # they're internal devenv machinery and the overhead isn't worth it.
  traceStatus = _taskName: statusBody: statusBody;
in
{
  exec = traceExec;
  status = traceStatus;
  withStatus = withStatus;
}
