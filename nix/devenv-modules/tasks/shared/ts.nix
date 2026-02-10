# TypeScript tasks
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.ts {})
#     # Or with custom tsconfig:
#     (inputs.effect-utils.devenvModules.tasks.ts { tsconfigFile = "tsconfig.dev.json"; })
#   ];
#
# Provides: ts:check, ts:build-watch, ts:build, ts:clean, and optionally ts:patch-lsp
#
# Dependencies:
#   - genie:run: config files must be generated before tsc can resolve paths
#   - pnpm:install: node_modules must exist for tsc to resolve types
#
# Caching notes:
#   TypeScript's incremental build (--build) uses .tsbuildinfo files to cache
#   results. If you suspect stale cache issues (e.g., cross-package signature
#   changes not detected), run `dt ts:clean` first to clear the cache.
#   Ensure all packages are listed in tsconfig.all.json references.
#
# tscBin:
#   Path to the tsc binary. Use a package-local node_modules/.bin/tsc to pick up
#   the Effect Language Service patch. The Nix-provided tsc is unpatched, so
#   Effect plugin diagnostics are silently skipped unless a patched binary is used.
#
# lspPatchCmd:
#   Command to patch TypeScript with the Effect Language Service plugin. When set,
#   creates a ts:patch-lsp task that runs before ts:check/ts:build-watch/ts:build.
#   This replaces per-package postinstall scripts, centralizing the patch in dt.
#   Example: "packages/@overeng/utils/node_modules/.bin/effect-language-service patch"
#
# lspPatchAfter:
#   Dependencies for the ts:patch-lsp task. Defaults to ["pnpm:install"].
#   For faster startup, specify only the package containing the patch binary:
#   Example: ["pnpm:install:utils"] to depend only on packages/@overeng/utils
#
# OTEL tracing:
#   When OTEL is available, ts:check and ts:build run with --extendedDiagnostics
#   --verbose (adds ~3% overhead) and emit per-project child spans with timing
#   attributes (tsc.check_time_s, tsc.parse_time_s, etc.). The diagnostics
#   output is suppressed from the user — only errors are shown on failure.
#
# Status checks:
#   - ts:emit uses `tsc --build --dry --noCheck` to skip when no outputs would be produced.
#   - ts:patch-lsp can be cached by providing `lspPatchDir` (the TypeScript dir being patched).
{ tsconfigFile ? "tsconfig.all.json", tscBin ? "tsc", lspPatchCmd ? null, lspPatchAfter ? [ "pnpm:install" ], lspPatchDir ? null }:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  lspAfter = if lspPatchCmd != null then [ "ts:patch-lsp" ] else [];

  # Script that runs tsc --build with --extendedDiagnostics --verbose,
  # parses per-project timing, and emits OTEL child spans.
  # The outer trace.exec wrapper provides the parent ts:check/ts:build span.
  #
  # When OTEL is not available, runs plain tsc --build (no diagnostics flags).
  tscWithDiagnostics = tsconfigArg: extraArgs: ''
    set -euo pipefail

    # Only add diagnostics flags when OTEL tracing is active
    if command -v otel-span >/dev/null 2>&1 && [ -n "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ] && [ -n "''${TRACEPARENT:-}" ]; then
      _tsc_output="$(mktemp)"
      trap 'rm -f "$_tsc_output"' EXIT

      _tsc_exit=0
      ${tscBin} --build ${tsconfigArg} ${extraArgs} --extendedDiagnostics --verbose > "$_tsc_output" 2>&1 || _tsc_exit=$?

      # On failure, show the user the error output (filtered to useful lines)
      if [ "$_tsc_exit" -ne 0 ]; then
        # Show errors but filter out diagnostics noise
        grep -v -E "^(Files:|Lines of|Identifiers:|Symbols:|Types:|Instantiations:|Memory used:|Assignability|Identity|Subtype|Strict subtype|I/O|Parse time:|ResolveModule|ResolveTypeReference|ResolveLibrary|Program time:|Bind time:|Check time:|Emit time:|Total time:|Build time:|Aggregate)" "$_tsc_output" || true
      fi

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

          # Emit OTLP span via spool file (near-zero overhead)
          _tsc_payload='{
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
          }'
          _tsc_spool="''${OTEL_SPAN_SPOOL_DIR:-}"
          if [ -n "$_tsc_spool" ] && [ -d "$_tsc_spool" ]; then
            printf '%s\n' "$_tsc_payload" | ${pkgs.jq}/bin/jq -c . >> "$_tsc_spool/spans.jsonl"
          else
            ${pkgs.curl}/bin/curl -s -X POST \
              "$OTEL_EXPORTER_OTLP_ENDPOINT/v1/traces" \
              -H "Content-Type: application/json" \
              -d "$_tsc_payload" \
              --max-time 2 \
              >/dev/null 2>&1 || true
          fi

          _current_project=""
          _diag_block=""
        fi
      done < "$_tsc_output"

      exit "$_tsc_exit"
    else
      # No OTEL: run plain tsc (no diagnostics overhead)
      ${tscBin} --build ${tsconfigArg} ${extraArgs}
    fi
  '';
in
{
  packages = [ pkgs.bc ];

  tasks = {
    "ts:check" = {
      description = "Type check the whole workspace (tsc --build; emits by design with project references)";
      exec = trace.exec "ts:check" (tscWithDiagnostics tsconfigFile "");
      after = [ "genie:run" "pnpm:install" ] ++ lspAfter;
    };
    "ts:build-watch" = {
      description = "Build all packages in watch mode (tsc --build --watch)";
      exec = "${tscBin} --build --watch ${tsconfigFile}";
      after = [ "genie:run" "pnpm:install" ] ++ lspAfter;
    };
    "ts:build" = {
      description = "Build all packages with type checking (tsc --build)";
      exec = trace.exec "ts:build" (tscWithDiagnostics tsconfigFile "");
      after = [ "genie:run" "pnpm:install" ] ++ lspAfter;
    };
    "ts:emit" = trace.withStatus "ts:emit" {
      description = "Emit build outputs without full type checking (tsc --build --noCheck)";
      exec = tscWithDiagnostics tsconfigFile "--noCheck";
      status = ''
        set -euo pipefail

        _out="$(${tscBin} --build ${tsconfigFile} --dry --noCheck --verbose --pretty false 2>&1)" || exit 1
        echo "$_out" | grep -q "A non-dry build would build project" && exit 1
        exit 0
      '';
      after = [ "genie:run" "pnpm:install" ];
    };
    "ts:clean" = {
      description = "Remove TypeScript build artifacts";
      # Use Nix tsc (always available) since clean doesn't need the Effect LSP patch
      exec = trace.exec "ts:clean" "tsc --build --clean ${tsconfigFile}";
    };
  } // (if lspPatchCmd != null then {
    "ts:patch-lsp" =
      if lspPatchDir != null then
        trace.withStatus "ts:patch-lsp" {
          description = "Patch TypeScript with Effect Language Service";
          exec = lspPatchCmd;
          status = ''
            set -euo pipefail

            _tsc_js="${lspPatchDir}/lib/_tsc.js"
            [ -f "$_tsc_js" ] || exit 1
            grep -q "@effect/language-service/embedded-typescript-copy" "$_tsc_js" && exit 0
            exit 1
          '';
          after = lspPatchAfter;
        }
      else
        {
          description = "Patch TypeScript with Effect Language Service";
          exec = trace.exec "ts:patch-lsp" lspPatchCmd;
          after = lspPatchAfter;
        };
  } else {});
}
