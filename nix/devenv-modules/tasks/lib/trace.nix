# OTEL tracing helpers for devenv tasks
#
# Two cooperating levels (decision 0018 — devenv task cooperation):
#   - TASK level (trace.exec / trace.status / trace.withStatus): otel-span emits
#     the `devenv.task.exec` / `devenv.task.status` span that owns task identity
#     (task.name / task.cached). One task span per task, no generic wrapper above it.
#   - COMMAND level (trace.instr): a task opts a clean concrete command into
#     otel-scrape, which wraps it BENEATH the task span — a named command span
#     (`tsgo`, `oxlint`, `node`, ...) plus adapter records where the structured
#     source contract (decision 0017) is met. otel-scrape no longer blanket-wraps
#     every task (that produced one meaningless generic `bash` span per task).
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
#       exec = trace.exec "ts:check" "tsc --build tsconfig.check.json";
#     };
#
#     # Export values computed inside the traced child to downstream tasks:
#     tasks."setup:gate".exec = trace.execWithExports
#       "setup:gate"
#       [ "DEVENV_SETUP_OUTER_CACHE_HIT" ]
#       "export DEVENV_SETUP_OUTER_CACHE_HIT=1";
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
  otelCanEmitShell = ''command -v "''${OTEL_SPAN_BIN:-otel-span}" >/dev/null 2>&1 && { [ -n "''${OTELITE_HTTP_ENDPOINT:-''${OTEL_EXPORTER_OTLP_ENDPOINT:-}}" ] || { [ -n "''${OTEL_SPAN_SPOOL_DIR:-}" ] && [ -d "''${OTEL_SPAN_SPOOL_DIR:-}" ]; }; }'';

  # Shell condition: an OTEL task trace context is actually ACTIVE — OTEL delivery
  # is available (otelCanEmitShell) AND a well-formed W3C traceparent is present
  # (OTEL_TASK_TRACEPARENT preferred, falling back to TRACEPARENT). This is the
  # single gate that decides whether COMMAND-level instrumentation should engage.
  # tsc (ts.nix) and trace.instr (oxlint/vitest) both gate on THIS exact string so
  # they engage/disengage together: in a non-interactive `devenv tasks run` with no
  # span parent and no OTLP endpoint (e.g. CI), every instrumented command runs
  # bare; under `otel-span run -- devenv tasks run …` the task span exports
  # OTEL_TASK_TRACEPARENT into the task body, so this is true and commands wrap.
  otelTraceContextActive = ''${otelCanEmitShell} && [[ "''${OTEL_TASK_TRACEPARENT:-''${TRACEPARENT:-}}" =~ ^00-[0-9a-fA-F]{32}-[0-9a-fA-F]{16}-[0-9a-fA-F]{2}$ ]]'';
  taskFileStem =
    taskName:
    builtins.replaceStrings
      [
        ":"
        "/"
        " "
        "."
      ]
      [
        "-"
        "-"
        "-"
        "_"
      ]
      taskName;

  # Per-adapter CHILD flags that otel-scrape requires the CALL-SITE to pass to the
  # wrapped program (placed AFTER the program name, before its own args). These are
  # gated together with the otel-scrape prefix so a repo WITHOUT otel-scrape never
  # sees them (decision 0017: a needs-render structured-source flag such as oxlint
  # `--format=json` REPLACES the tool's human stdout, so it must not leak onto the
  # terminal when otel-scrape is not present to re-render — advisor bug fix).
  #   oxlint  -> --format=json        (needs-render: otel-scrape re-renders a summary)
  #   deadnix -> --output-format json (needs-render: NDJSON, otel-scrape re-renders)
  #   vitest  -> (none)               (side-channel: otel-scrape injects --reporter=json)
  #   none    -> (none)               (named-command identity only)
  instrChildFlags =
    adapter:
    if adapter == "oxlint" then
      [ "--format=json" ]
    else if adapter == "deadnix" then
      [
        "--output-format"
        "json"
      ]
    else
      [ ];

  # trace.instr — instrument a CONCRETE command BENEATH a task span (decision 0018).
  #
  # The task level is owned by otel-span (trace.exec/trace.status); otel-scrape no
  # longer blanket-wraps every task shell. Instead a task opts a clean concrete
  # command into otel-scrape instrumentation, yielding a named command span
  # (command.program, argv/cwd hashes, exit, merged process) beneath the task span.
  # otel-scrape joins the task trace via the parent context otel-span exports and
  # itself re-exports OTEL_TASK_TRACEPARENT (its command-span context) so a
  # task-parented sub-span emitter re-parents beneath it (clause 4, done in the
  # Rust wrapper).
  #
  # This emits a shell PRELUDE that defines two bash arrays; the call-site uses them
  # around the concrete argv:
  #
  #   ${trace.instr { adapter = "oxlint"; name = "lint:check:oxlint"; }}
  #   "''${_otel_instr[@]}" oxlint "''${_otel_instr_flags[@]}" --import-plugin ... <files>
  #
  # Both arrays are EMPTY when otel-scrape is absent, `OTEL_SCRAPE_ENABLED=0`, or no
  # OTEL task trace context is active (otelTraceContextActive false), so the concrete
  # command runs completely unchanged (these are SHARED modules that downstream repos
  # import without otel-scrape on PATH — transparency is required — and CI runs them
  # non-interactively with no span parent).
  #
  # adapter: "none" (named identity only), "oxlint", "deadnix", "vitest", or
  # "node-cpuprofile".
  instr =
    {
      adapter ? "none",
      name,
    }:
    let
      flags = instrChildFlags adapter;
      flagsArray = lib.concatMapStringsSep " " (f: lib.escapeShellArg f) flags;
    in
    ''
      _otel_instr=()
      _otel_instr_flags=()
      _otel_scrape_bin="''${OTEL_SCRAPE_BIN:-otel-scrape}"
      # Engage command-level otel-scrape wrapping ONLY when an OTEL task trace
      # context is active (same gate tsc uses — otelTraceContextActive), so a
      # non-interactive run without a span parent / OTLP endpoint keeps oxlint and
      # vitest bare instead of injecting structured-source flags that re-render
      # their output. otel-scrape must additionally be present and enabled.
      if ${otelTraceContextActive} \
        && [ "''${OTEL_SCRAPE_ENABLED:-1}" != "0" ] \
        && command -v "$_otel_scrape_bin" >/dev/null 2>&1; then
        _otel_scrape_summary_dir="''${OTEL_SCRAPE_SUMMARY_DIR:-''${DEVENV_ROOT:-$PWD}/tmp/otel-scrape/summaries}"
        mkdir -p "$_otel_scrape_summary_dir"
        _otel_instr=(
          "$_otel_scrape_bin"
          --adapter ${adapter}
          --service-name "''${OTEL_SCRAPE_SERVICE_NAME:-''${OTEL_SERVICE_NAME:-effect-utils-devenv}}"
          --summary-out "$_otel_scrape_summary_dir/${taskFileStem name}.$$.summary.json"
          --
        )
        _otel_instr_flags=(${flagsArray})
      fi
    '';

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
  #
  # This is the TASK level only (decision 0018): otel-span owns task.name/task.cached.
  # A task that runs a clean concrete command additionally wraps it with trace.instr
  # so otel-scrape owns the command level BENEATH this span (named command span +
  # adapter records where the structured-source contract is met).
  traceExec = taskName: execBody: ''
    if ${otelCanEmitShell}; then
      _otel_project_attr=()
      if [ -n "''${OTEL_DEVENV_PROJECT:-}" ]; then
        _otel_project_attr=(--attr "devenv.project.name=$OTEL_DEVENV_PROJECT")
      fi
      OTEL_EXPORTER_OTLP_ENDPOINT="''${OTELITE_HTTP_ENDPOINT:-''${OTEL_EXPORTER_OTLP_ENDPOINT:-}}" \
        "''${OTEL_SPAN_BIN:-otel-span}" run "effect-utils-devenv" "devenv.task.exec" \
        "''${_otel_project_attr[@]}" \
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

  # Devenv normally persists `tasks.<name>.exports` after the task command
  # returns. A traced exec adds an `otel-span -> bash -c` process boundary, so
  # values exported by the body cannot reach devenv's generated parent-shell
  # epilogue. Persist them from inside the traced body instead.
  #
  # Consumers must not also set the task's `exports` option: doing so would let
  # the generated parent epilogue append stale inherited values after these.
  traceExecWithExports =
    taskName: exportNames: execBody:
    traceExec taskName ''
      ${execBody}

      if [ -n "''${DEVENV_TASK_EXPORTS_FILE:-}" ]; then
        for _effect_utils_export_name in ${lib.concatMapStringsSep " " lib.escapeShellArg exportNames}; do
          if [ -n "''${!_effect_utils_export_name+x}" ]; then
            _effect_utils_export_value_b64="$(printf '%s' "''${!_effect_utils_export_name}" | base64 -w0)"
            printf '%s\0%s\0' \
              "$_effect_utils_export_name" \
              "$_effect_utils_export_value_b64" \
              >> "$DEVENV_TASK_EXPORTS_FILE"
          fi
        done
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
      _otel_project_attr=()
      if [ -n "''${OTEL_DEVENV_PROJECT:-}" ]; then
        _otel_project_attr=(--attr "devenv.project.name=$OTEL_DEVENV_PROJECT")
      fi
      OTEL_EXPORTER_OTLP_ENDPOINT="''${OTELITE_HTTP_ENDPOINT:-''${OTEL_EXPORTER_OTLP_ENDPOINT:-}}" \
        "''${OTEL_SPAN_BIN:-otel-span}" run "effect-utils-devenv" "devenv.task.status" \
        "''${_otel_project_attr[@]}" \
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
      exec = traceExec taskName exec;
      status = traceStatus taskName method status;
    };
in
{
  inherit otelCanEmitShell;
  inherit otelTraceContextActive;
  exec = traceExec;
  execWithExports = traceExecWithExports;
  status = traceStatus;
  withStatus = withStatus;
  instr = instr;
}
