# OTEL tracing helpers for devenv tasks
#
# Wraps task `exec` scripts with `otel-span` to produce native devenv task spans.
#
# When OTEL delivery is available (otel-span on PATH plus either an OTLP
# endpoint or a valid spool dir), each task execution emits an OTLP span under
# the shared effect-utils devenv service.
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
#     # With cache tracking and method attribute:
#     tasks."pnpm:install:foo" = trace.withStatus "pnpm:install:foo" "hash" {
#       exec = "pnpm install";
#       status = "[ -d node_modules ]";
#     };
#
#     # Status with method (binary = calls external program):
#     tasks."genie:run".status = trace.status "genie:run" "binary" "genie --check";
#   }
#
# Status method values:
#   "binary" - calls an external program (e.g. genie --check, mr status, tsc --dry)
#   "hash"   - compares file content hashes
#   "path"   - checks file/directory existence or content
#
{ lib }:
let
  otelCanEmitShell = ''command -v otel-span >/dev/null 2>&1 && { [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ] || { [ -n "''${OTEL_SPAN_SPOOL_DIR:-}" ] && [ -d "''${OTEL_SPAN_SPOOL_DIR:-}" ]; }; }'';

  # Wrap a task exec string with otel-span tracing.
  # When OTEL is available, the exec body runs inside an otel-span child span.
  # When OTEL is not available, the exec body runs directly (zero overhead).
  #
  # The span includes task.cached=false (OTEL bool attribute) to distinguish from cached runs.
  #
  # Trace context propagation is handled by otel-span itself:
  # - otel-span reads OTEL_TASK_TRACEPARENT (preferred, survives devenv re-evaluations)
  #   falling back to TRACEPARENT
  # - otel-span exports both TRACEPARENT and OTEL_TASK_TRACEPARENT for child processes
  traceExec = taskName: execBody: ''
    if ${otelCanEmitShell}; then
      otel-span run "effect-utils-devenv" "devenv.task.exec" \
        --attr "tool.name=devenv" \
        --attr "task.name=${taskName}" \
        --attr "task.phase=exec" \
        --attr "task.cached=false" \
        --attr "span.label=${taskName}" \
        -- bash -c ${lib.escapeShellArg execBody}
    else
      ${execBody}
    fi
  '';

  # Trace status scripts so cached/skipped decisions become visible in traces.
  # The status body runs INSIDE otel-span so sub-programs (e.g. genie --check,
  # mr status) inherit TRACEPARENT and produce sub-traces.
  # --status-attr derives task.cached from exit code (0=true, non-zero=false)
  # and forces span status to OK (status checks aren't errors).
  traceStatus = taskName: method: statusBody: ''
    if ${otelCanEmitShell}; then
      _status_exit=0
      otel-span run "effect-utils-devenv" "devenv.task.status" \
        --attr "tool.name=devenv" \
        --attr "task.name=${taskName}" \
        --attr "task.phase=status" \
        --attr "status.method=${method}" \
        --attr "span.label=${taskName}" \
        --status-attr "task.cached" \
        -- bash -c ${lib.escapeShellArg statusBody} || _status_exit=$?

      exit "$_status_exit"
    else
      ${statusBody}
    fi
  '';

  # Wrap a task's exec and status scripts with otel-span tracing.
  withStatus =
    taskName: method:
    { exec, status, ... }@attrs:
    attrs
    // {
      exec = ''
        if ${otelCanEmitShell}; then
          otel-span run "effect-utils-devenv" "devenv.task.exec" \
            --attr "tool.name=devenv" \
            --attr "task.name=${taskName}" \
            --attr "task.phase=exec" \
            --attr "task.cached=false" \
            --attr "span.label=${taskName}" \
            -- bash -c ${lib.escapeShellArg exec}
        else
          ${exec}
        fi
      '';
      status = traceStatus taskName method status;
    };
in
{
  inherit otelCanEmitShell;
  exec = traceExec;
  status = traceStatus;
  withStatus = withStatus;
}
