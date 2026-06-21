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
#   attributes (tsc.check_time_s, tsc.parse_time_s, etc.). The diagnostics
#   output is suppressed from the user — only errors are shown on failure.
#
# Status checks:
#   - ts:emit uses `tsc --build --dry --noCheck` to skip when no outputs would be produced.
{
  tsconfigFile ? "tsconfig.all.json",
  tsBin ? "tsgo",
  tscBin ? "tsc",
  # Real derivation/path backing the `tsBin` guard. When set, the guard owns
  # `bin/<tsBin>` and exec's this by absolute path under passthrough so the real
  # need not be a competing top-level provider (see cli-guard.nix).
  tsBinPkg ? null,
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

    # Only add diagnostics flags when OTEL tracing is active. Keep tsgo on the
    # plain compiler path: Effect tsgo emits language-service diagnostics that
    # are useful to display directly, and its verbose build output is not stable
    # enough for the tsc diagnostics parser below.
    if command -v otel-span >/dev/null 2>&1 && [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ] && [ -n "''${TRACEPARENT:-}" ] && [ "$_ts_compiler_name" != "tsgo" ]; then
      _tsc_output="$(mktemp)"
      trap 'rm -f "$_tsc_output"' EXIT

      _tsc_exit=0
      if [[ "${tscInvocation}" == --build* ]]; then
        ${compilerBin} ${tscInvocation} ${extraArgs} --extendedDiagnostics --verbose > "$_tsc_output" 2>&1 || _tsc_exit=$?
      else
        ${compilerBin} ${tscInvocation} ${extraArgs} > "$_tsc_output" 2>&1 || _tsc_exit=$?
      fi

      # On failure, show the user the error output (filtered to useful lines)
      if [ "$_tsc_exit" -ne 0 ]; then
        # Show errors but filter out diagnostics noise
        grep -v -E "^(Files:|Lines of|Identifiers:|Symbols:|Types:|Instantiations:|Memory used:|Assignability|Identity|Subtype|Strict subtype|I/O|Parse time:|ResolveModule|ResolveTypeReference|ResolveLibrary|Program time:|Bind time:|Check time:|Emit time:|Total time:|Build time:|Aggregate)" "$_tsc_output" || true
      fi

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
  ++ cliGuard.fromTasks {
    tasks = guardedTasks;
    reals = lib.optionalAttrs (tsBinPkg != null) { ${tsBin} = tsBinPkg; };
  };

  tasks = cliGuard.stripGuards (guardedTasks // otherTasks);
}
