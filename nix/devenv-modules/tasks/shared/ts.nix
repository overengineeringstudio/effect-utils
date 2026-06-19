# TypeScript tasks
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.ts {})
#     # Or with custom tsconfig:
#     (inputs.effect-utils.devenvModules.tasks.ts { tsconfigFile = "tsconfig.dev.json"; })
#   ];
#
# Provides: ts:check, ts:check:strict, ts:build-watch, ts:build, ts:emit, ts:clean
#
# Dependencies:
#   - genie:run: config files must be generated before tsc can resolve paths
#   - pnpm:install: node_modules must exist for tsc to resolve types
#
# Caching notes:
#   TypeScript's incremental build (--build) uses .tsbuildinfo files to cache
#   results. Use `ts:check` for fast local feedback and `ts:check:strict`
#   when correctness matters more than incremental reuse, such as CI gates or
#   reused automation workspaces that may see dependency-only type changes.
#   `ts:check:strict` inherits the merged `ts:check.after` graph so repo-local
#   generators also run in strict mode.
#   `ts:clean` remains available as a heavier escape hatch when you suspect
#   corrupted build metadata. Ensure all packages are listed in
#   tsconfig.all.json references.
#
# tsBin:
#   Path to the TypeScript build/check binary. Defaults to "tsgo" so normal
#   workspace checks use Nix-managed TypeScript 7.
#
# tscBin:
#   Path to the JavaScript TypeScript compiler. Defaults to "tsc" and is kept
#   for ts:emit and tsconfig parsing helpers that need the JS compiler API.
#
# OTEL tracing:
#   When OTEL is available, ts:check and ts:build run with --extendedDiagnostics
#   --verbose (adds ~3% overhead) and emit per-project child spans with timing
#   attributes (tsc.check_time_s, tsc.parse_time_s, etc.). This applies to both
#   the JS tsc and Effect tsgo, whose build diagnostics share the same shape;
#   tsgo additionally yields a build-level "aggregate" span. The timing
#   scaffolding is stripped from the user's view, but real errors and tsgo's
#   Effect lints are always re-surfaced.
#
# Status checks:
#   - ts:emit uses `tsc --build --dry --noCheck` to skip when no outputs would be produced.
{
  tsconfigFile ? "tsconfig.all.json",
  tsBin ? "tsgo",
  tscBin ? "tsc",
}:
{
  lib,
  pkgs,
  config,
  ...
}:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  inheritedCheckAfter =
    config.tasks."ts:check".after or [
      "genie:run"
      "pnpm:install"
    ];
  emitTsconfigHelper = ''
        generate_emit_tsconfig() {
          local source_tsconfig="$1"
          local target_tsconfig="$2"

          # `tsc --build --dry --noCheck` still treats `noEmit` references as emit
          # work, which made `ts:emit` look perpetually stale. Build a filtered
          # graph just for this task instead of mutating the checked-in config.
          ${pkgs.nodejs}/bin/node - "$source_tsconfig" "$target_tsconfig" <<'NODE'
    const fs = require('node:fs')
    const path = require('node:path')

    const [sourceTsconfig, targetTsconfig] = process.argv.slice(2)

    const loadTypescript = () => {
      try {
        return require(require.resolve('typescript', { paths: [path.dirname(sourceTsconfig), process.cwd()] }))
      } catch (error) {
        throw new Error(
          'Unable to resolve TypeScript while preparing ts:emit: ' +
            String(error?.message ?? error)
        )
      }
    }

    const typescript = loadTypescript()

    const readTsconfig = (filePath) => {
      const parsed = typescript.readConfigFile(filePath, (path) => fs.readFileSync(path, 'utf8'))
      if (parsed.error) {
        const message = typeof parsed.error.messageText === 'string'
          ? parsed.error.messageText
          : JSON.stringify(parsed.error.messageText)
        throw new Error('Failed to parse ' + filePath + ': ' + message)
      }
      return parsed.config
    }

    const resolveReferenceTsconfig = (referencePath) => {
      const resolvedPath = path.resolve(baseDir, referencePath)
      return path.extname(resolvedPath) ? resolvedPath : path.join(resolvedPath, 'tsconfig.json')
    }

    const rootConfig = readTsconfig(sourceTsconfig)
    const baseDir = path.dirname(sourceTsconfig)

    rootConfig.references = (rootConfig.references ?? []).filter((reference) => {
      const refTsconfig = resolveReferenceTsconfig(reference.path)
      if (!fs.existsSync(refTsconfig)) {
        return true
      }

      const refConfig = readTsconfig(refTsconfig)
      return refConfig.compilerOptions?.noEmit !== true
    })

    fs.writeFileSync(targetTsconfig, JSON.stringify(rootConfig))
    NODE
        }
  '';

  # Script that runs the selected TypeScript compiler with --extendedDiagnostics --verbose,
  # parses per-project timing, and emits OTEL child spans.
  # The outer trace.exec wrapper provides the parent ts:check/ts:build span.
  #
  # When OTEL is not available, runs the compiler without diagnostics flags.
  tscWithDiagnostics = compilerBin: tscInvocation: extraArgs: ''
    set -euo pipefail

    _ts_compiler_name="$(${pkgs.coreutils}/bin/basename ${lib.escapeShellArg compilerBin})"

    # Only add diagnostics flags when OTEL tracing is active.
    #
    # Both the JS `tsc` and Effect `tsgo` emit `--build --extendedDiagnostics
    # --verbose` output in the same shape (`Building project '...'` blocks with
    # `Parse time:`/`Check time:`/`Emit time:`/`Total time:`/`Memory used:`), so
    # a single parser below handles both. tsgo additionally emits an aggregate
    # build summary (`Projects in scope:` ... `Aggregate Total time:`); the
    # parser resets the current project on that boundary so the aggregate totals
    # never get attributed to the last project, and emits them as one
    # build-level span instead.
    #
    # tsgo's per-project blocks also carry Effect language-service lints
    # (`warning`/`suggestion TS377...`). On this OTEL path the raw compiler
    # output is captured to a temp file, so those lints are re-surfaced through
    # `filter_diagnostics_noise` on BOTH success and failure — otherwise routing
    # tsgo through this path would silently swallow them.
    if command -v otel-span >/dev/null 2>&1 && [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ] && [ -n "''${TRACEPARENT:-}" ]; then
      _tsc_output="$(mktemp)"
      trap 'rm -f "$_tsc_output"' EXIT

      # Strip the diagnostics/timing scaffolding so only real compiler output
      # (errors, and tsgo's Effect `warning`/`suggestion` lints) is shown.
      # Drops both tsc-style counters/timers and tsgo's extra build-progress and
      # aggregate-summary lines (`Building project`, timestamped project status,
      # `Projects in scope:`, `Aggregate ...`).
      filter_diagnostics_noise() {
        grep -v -E "^([0-9]{1,2}:[0-9]{2}:[0-9]{2} (AM|PM) - |Files:|Lines:|Lines of|Identifiers:|Symbols:|Types:|Instantiations:|Memory used:|Memory allocs:|Assignability|Identity|Subtype|Strict subtype|I/O|Config time:|BuildInfo read time:|Parse time:|ResolveModule|ResolveTypeReference|ResolveLibrary|Program time:|Bind time:|Changes compute time:|Check time:|Emit time:|Total time:|Build time:|Projects in scope:|Projects built:|Timestamps only updates:|Aggregate)" "$1" || true
      }

      _tsc_exit=0
      if [[ "${tscInvocation}" == --build* ]]; then
        ${compilerBin} ${tscInvocation} ${extraArgs} --extendedDiagnostics --verbose > "$_tsc_output" 2>&1 || _tsc_exit=$?
      else
        ${compilerBin} ${tscInvocation} ${extraArgs} > "$_tsc_output" 2>&1 || _tsc_exit=$?
      fi

      # Always re-surface compiler errors and lints to the user. The raw output
      # was captured to a temp file for parsing, so without this the diagnostics
      # path would suppress everything tsgo prints (notably its Effect lints).
      filter_diagnostics_noise "$_tsc_output"

      if [[ "${tscInvocation}" == --build* ]]; then
        # Parse TRACEPARENT to get trace ID and current span ID (our parent)
        IFS='-' read -r _tp_ver _tp_trace _tp_parent _tp_flags <<< "$TRACEPARENT"

        # Parse the diagnostics output for per-project timing
        # Pattern: "Building project '...'" followed by a diagnostics block ending with "Total time: X.XXs"
        _current_project=""
        _diag_block=""
        while IFS= read -r line; do
        # Match "Building project '/path/to/tsconfig.json'..."
        if [[ "$line" =~ "Building project '"(.+)"'" ]]; then
          _current_project="''${BASH_REMATCH[1]}"
          # Strip DEVENV_ROOT prefix for cleaner names
          _current_project="''${_current_project#$DEVENV_ROOT/}"
          # Strip /tsconfig.json suffix
          _current_project="''${_current_project%/tsconfig.json}"
          _diag_block=""
        fi

        # tsgo closes the per-project section with an aggregate build summary
        # ("Projects in scope: ..." ... "Aggregate Total time: ..."). Reset the
        # current project on that boundary so the aggregate timers are never
        # attributed to the last project (which matters for warm builds where an
        # up-to-date project emits no per-project "Total time:" to close itself).
        # The aggregate block is captured separately below. tsc never emits this
        # line, so the reset is a no-op for the JS compiler.
        if [[ "$line" =~ ^"Projects in scope:" ]]; then
          _current_project=""
          _diag_block=""
        fi

        # Accumulate diagnostics lines for the current project
        if [[ -n "$_current_project" ]]; then
          _diag_block="$_diag_block"$'\n'"$line"
        fi

        # Match "Total time:    X.XXs"
        if [[ -n "$_current_project" ]] && [[ "$line" =~ "Total time:"[[:space:]]*([0-9]+\.[0-9]+)"s" ]]; then
          _total_time="''${BASH_REMATCH[1]}"

          # Extract additional timing from the accumulated diagnostics block
          _check_time=$(echo "$_diag_block" | grep "Check time:" | grep -oE '[0-9]+\.[0-9]+' || echo "")
          _parse_time=$(echo "$_diag_block" | grep "Parse time:" | grep -oE '[0-9]+\.[0-9]+' || echo "")
          _emit_time=$(echo "$_diag_block" | grep "Emit time:" | grep -oE '[0-9]+\.[0-9]+' || echo "")
          _files_count=$(echo "$_diag_block" | grep "^Files:" | grep -oE '[0-9]+' || echo "")
          _memory=$(echo "$_diag_block" | grep "Memory used:" | grep -oE '[0-9]+' || echo "")

          # Convert seconds to nanoseconds for span duration
          _total_ms=$(${pkgs.coreutils}/bin/printf "%.0f" "$(echo "$_total_time * 1000" | ${pkgs.bc}/bin/bc)")
          _duration_ns=$(echo "$_total_ms * 1000000" | ${pkgs.bc}/bin/bc)

          # Generate a span ID
          _span_id=$(${pkgs.coreutils}/bin/od -An -tx1 -N8 /dev/urandom | tr -d ' \n')

          # Compute timestamps: span ends "now" and started duration_ns ago
          _end_ns=$(${pkgs.coreutils}/bin/date +%s%N)
          _start_ns=$((_end_ns - _duration_ns))

          # Build attributes JSON
          _attrs='[{"key":"service.name","value":{"stringValue":"tsc-project"}}'
          _attrs="$_attrs"',{"key":"tsc.total_time_s","value":{"doubleValue":'"$_total_time"'}}'
          [ -n "$_check_time" ] && _attrs="$_attrs"',{"key":"tsc.check_time_s","value":{"doubleValue":'"$_check_time"'}}'
          [ -n "$_parse_time" ] && _attrs="$_attrs"',{"key":"tsc.parse_time_s","value":{"doubleValue":'"$_parse_time"'}}'
          [ -n "$_emit_time" ] && _attrs="$_attrs"',{"key":"tsc.emit_time_s","value":{"doubleValue":'"$_emit_time"'}}'
          [ -n "$_files_count" ] && _attrs="$_attrs"',{"key":"tsc.files","value":{"intValue":"'"$_files_count"'"}}'
          [ -n "$_memory" ] && _attrs="$_attrs"',{"key":"tsc.memory_kb","value":{"intValue":"'"$_memory"'"}}'
          _attrs="$_attrs"',{"key":"devenv.root","value":{"stringValue":"'"$DEVENV_ROOT"'"}}]'

          # Emit OTLP span via otel-span emit
          printf '%s\n' '{
            "resourceSpans": [{
              "resource": {
                "attributes": [
                  {"key": "service.name", "value": {"stringValue": "tsc-project"}},
                  {"key": "devenv.root", "value": {"stringValue": "'"$DEVENV_ROOT"'"}}
                ]
              },
              "scopeSpans": [{
                "scope": {"name": "tsc-diagnostics"},
                "spans": [{
                  "traceId": "'"$_tp_trace"'",
                  "spanId": "'"$_span_id"'",
                  "parentSpanId": "'"$_tp_parent"'",
                  "name": "'"$_current_project"'",
                  "kind": 1,
                  "startTimeUnixNano": "'"$_start_ns"'",
                  "endTimeUnixNano": "'"$_end_ns"'",
                  "attributes": '"$_attrs"',
                  "status": {"code": 1}
                }]
              }]
            }]
          }' | otel-span emit

          _current_project=""
          _diag_block=""
        fi
        done < "$_tsc_output"

        # Emit one build-level span from tsgo's aggregate summary, if present.
        # This is the highest-fidelity whole-workspace timing tsgo exposes and is
        # not available from tsc (which has no aggregate block), so it is a
        # tsgo-only enrichment that complements the per-project spans above.
        _agg_total=$(grep "^Aggregate Total time:" "$_tsc_output" | grep -oE '[0-9]+\.[0-9]+' | tail -1 || echo "")
        if [ -n "$_agg_total" ]; then
          _agg_check=$(grep "^Aggregate Check time:" "$_tsc_output" | grep -oE '[0-9]+\.[0-9]+' | tail -1 || echo "")
          _agg_parse=$(grep "^Aggregate Parse time:" "$_tsc_output" | grep -oE '[0-9]+\.[0-9]+' | tail -1 || echo "")
          _agg_emit=$(grep "^Aggregate Emit time:" "$_tsc_output" | grep -oE '[0-9]+\.[0-9]+' | tail -1 || echo "")
          _agg_files=$(grep "^Aggregate Files:" "$_tsc_output" | grep -oE '[0-9]+' | tail -1 || echo "")
          _agg_memory=$(grep "^Aggregate Memory used:" "$_tsc_output" | grep -oE '[0-9]+' | tail -1 || echo "")
          _projects_built=$(grep "^Projects built:" "$_tsc_output" | grep -oE '[0-9]+' | tail -1 || echo "")

          _agg_total_ms=$(${pkgs.coreutils}/bin/printf "%.0f" "$(echo "$_agg_total * 1000" | ${pkgs.bc}/bin/bc)")
          _agg_duration_ns=$(echo "$_agg_total_ms * 1000000" | ${pkgs.bc}/bin/bc)
          _agg_span_id=$(${pkgs.coreutils}/bin/od -An -tx1 -N8 /dev/urandom | tr -d ' \n')
          _agg_end_ns=$(${pkgs.coreutils}/bin/date +%s%N)
          _agg_start_ns=$((_agg_end_ns - _agg_duration_ns))

          _agg_attrs='[{"key":"service.name","value":{"stringValue":"tsc-project"}}'
          _agg_attrs="$_agg_attrs"',{"key":"tsc.aggregate","value":{"boolValue":true}}'
          _agg_attrs="$_agg_attrs"',{"key":"tsc.total_time_s","value":{"doubleValue":'"$_agg_total"'}}'
          [ -n "$_agg_check" ] && _agg_attrs="$_agg_attrs"',{"key":"tsc.check_time_s","value":{"doubleValue":'"$_agg_check"'}}'
          [ -n "$_agg_parse" ] && _agg_attrs="$_agg_attrs"',{"key":"tsc.parse_time_s","value":{"doubleValue":'"$_agg_parse"'}}'
          [ -n "$_agg_emit" ] && _agg_attrs="$_agg_attrs"',{"key":"tsc.emit_time_s","value":{"doubleValue":'"$_agg_emit"'}}'
          [ -n "$_agg_files" ] && _agg_attrs="$_agg_attrs"',{"key":"tsc.files","value":{"intValue":"'"$_agg_files"'"}}'
          [ -n "$_agg_memory" ] && _agg_attrs="$_agg_attrs"',{"key":"tsc.memory_kb","value":{"intValue":"'"$_agg_memory"'"}}'
          [ -n "$_projects_built" ] && _agg_attrs="$_agg_attrs"',{"key":"tsc.projects_built","value":{"intValue":"'"$_projects_built"'"}}'
          _agg_attrs="$_agg_attrs"',{"key":"devenv.root","value":{"stringValue":"'"$DEVENV_ROOT"'"}}]'

          printf '%s\n' '{
            "resourceSpans": [{
              "resource": {
                "attributes": [
                  {"key": "service.name", "value": {"stringValue": "tsc-project"}},
                  {"key": "devenv.root", "value": {"stringValue": "'"$DEVENV_ROOT"'"}}
                ]
              },
              "scopeSpans": [{
                "scope": {"name": "tsc-diagnostics"},
                "spans": [{
                  "traceId": "'"$_tp_trace"'",
                  "spanId": "'"$_agg_span_id"'",
                  "parentSpanId": "'"$_tp_parent"'",
                  "name": "aggregate",
                  "kind": 1,
                  "startTimeUnixNano": "'"$_agg_start_ns"'",
                  "endTimeUnixNano": "'"$_agg_end_ns"'",
                  "attributes": '"$_agg_attrs"',
                  "status": {"code": 1}
                }]
              }]
            }]
          }' | otel-span emit
        fi
      fi

      exit "$_tsc_exit"
    else
      # No OTEL: run without diagnostics overhead
      ${compilerBin} ${tscInvocation} ${extraArgs}
    fi
  '';

  guardedTasks = {
    "ts:check" = {
      guard = tsBin;
      description = "Type check the whole workspace (tsgo --build)";
      exec = trace.exec "ts:check" (tscWithDiagnostics tsBin "--build ${tsconfigFile}" "");
      after = [
        "genie:run"
        "pnpm:install"
      ];
    };
    "ts:check:strict" = {
      guard = tsBin;
      description = "Type check the whole workspace without incremental reuse (tsgo --build --force)";
      exec = trace.exec "ts:check:strict" (tscWithDiagnostics tsBin "--build --force ${tsconfigFile}" "");
      after = inheritedCheckAfter;
    };
    "ts:build" = {
      guard = tsBin;
      description = "Build all packages with type checking (tsgo --build)";
      exec = trace.exec "ts:build" (tscWithDiagnostics tsBin "--build ${tsconfigFile}" "");
      after = [
        "genie:run"
        "pnpm:install"
      ];
    };
  };

  otherTasks = {
    "ts:build-watch" = {
      description = "Build all packages in watch mode (tsgo --build --watch)";
      exec = "${tsBin} --build --watch ${tsconfigFile}";
      after = [
        "genie:run"
        "pnpm:install"
      ];
    };
    "ts:emit" = trace.withStatus "ts:emit" "binary" {
      description = "Emit build outputs without full type checking (tsc --build --noCheck)";
      exec = ''
        set -euo pipefail
        ${emitTsconfigHelper}
        # Create the filtered config next to the source tsconfig so referenced
        # project paths stay relative to the workspace instead of `/tmp`.
        _emit_tmpdir="$(dirname "${tsconfigFile}")"
        _emit_tsconfig="$(mktemp "$_emit_tmpdir/.ts-emit-XXXXXX.json")"
        trap 'rm -f "$_emit_tsconfig"' EXIT
        generate_emit_tsconfig "${tsconfigFile}" "$_emit_tsconfig"
        ${tscWithDiagnostics tscBin "--build \"$_emit_tsconfig\"" "--noCheck"}
      '';
      status = ''
        set -euo pipefail
        ${emitTsconfigHelper}

        # Reuse the same filtered graph for the dry-run status check so warm
        # caching answers the same question as the real emit command.
        _emit_tmpdir="$(dirname "${tsconfigFile}")"
        _emit_tsconfig="$(mktemp "$_emit_tmpdir/.ts-emit-XXXXXX.json")"
        trap 'rm -f "$_emit_tsconfig"' EXIT
        generate_emit_tsconfig "${tsconfigFile}" "$_emit_tsconfig"
        _out="$(${tscBin} --build "$_emit_tsconfig" --dry --noCheck --verbose --pretty false 2>&1)" || exit 1
        # tsc --build --dry reports pending work as:
        # - "A non-dry build would build project ..."
        # - "A non-dry build would update timestamps for output of project ..."
        # and potentially other variants. Treat any of them as "needs emit".
        echo "$_out" | grep -q "A non-dry build would" && exit 1
        exit 0
      '';
      after = [
        "genie:run"
        "pnpm:install"
      ];
    };
    "ts:clean" = {
      description = "Remove TypeScript build artifacts";
      exec = trace.exec "ts:clean" "${tsBin} --build --clean ${tsconfigFile}";
    };
  };
in
{
  packages = [
    pkgs.bc
  ]
  ++ cliGuard.fromTasks guardedTasks;

  tasks = cliGuard.stripGuards (guardedTasks // otherTasks);
}
