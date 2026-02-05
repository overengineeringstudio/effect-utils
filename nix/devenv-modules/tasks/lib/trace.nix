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
#     tasks."ts:check" = {
#       exec = trace.exec "ts:check" "tsc --build tsconfig.all.json";
#     };
#   }
#
{ lib }:
let
  # Wrap a task exec string with otel-span tracing.
  # When OTEL is available, the exec body runs inside an otel-span child span.
  # When OTEL is not available, the exec body runs directly (zero overhead).
  #
  # Args:
  #   taskName: string - The span name (e.g., "ts:check", "pnpm:install:genie")
  #   execBody: string - The original exec script body
  #
  # Returns: string - A new exec script that wraps the original with otel-span
  traceExec = taskName: execBody: ''
    if command -v otel-span >/dev/null 2>&1 && [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
      otel-span "dt-task" "${taskName}" -- bash -c ${lib.escapeShellArg execBody}
    else
      ${execBody}
    fi
  '';
in
{
  exec = traceExec;
}
