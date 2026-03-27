# Genie (config file generation) tasks
#
# Usage in devenv.nix:
#   imports = [ inputs.effect-utils.devenvModules.tasks.genie ];
#
# Provides: genie:run, genie:watch, genie:check
#
# NOTE: No pnpm:install:genie dependency here — this shared module is used by
# repos where genie may be a Nix package (no pnpm install needed). Repos that
# use source-mode genie via pnpm should add the dependency in their devenv.nix:
#   tasks."genie:run".after = [ "pnpm:install:genie" ];
#   tasks."genie:watch".after = [ "pnpm:install:genie" ];
#   tasks."genie:check".after = [ "pnpm:install:genie" ];
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  cacheRoot = ".direnv/task-cache/genie-run";
  stateFile = "${cacheRoot}/state.hash";
  generatedFilesFile = "${cacheRoot}/generated-files.txt";
  collectGenieGeneratedFiles = ''
    collect_genie_generated_files() {
      ${pkgs.ripgrep}/bin/rg -l \
        --glob '!tmp/**' \
        --glob '!.git/**' \
        --glob '!.direnv/**' \
        --glob '!.devenv/**' \
        --glob '!node_modules/**' \
        '^// Source: .*\.genie\.ts|^# Source: .*\.genie\.ts' . || true
    }
  '';
  computeGenieStateHash = ''
    compute_genie_state_hash() {
      {
        if command -v genie >/dev/null 2>&1; then
          printf 'genie-path %s\n' "$(command -v genie)"
          printf 'genie-version %s\n' "$(genie --version 2>/dev/null | ${pkgs.coreutils}/bin/head -n1 || echo unknown)"
        fi

        # Track both the `.genie.ts` sources and the generated files they own so
        # warm status checks catch manual drift without booting the full CLI.
        ${pkgs.findutils}/bin/find . \
          -type f \
          -name '*.genie.ts' \
          -not -path './.git/*' \
          -not -path './.direnv/*' \
          -not -path './.devenv/*' \
          -not -path './node_modules/*' \
          -print
        ${collectGenieGeneratedFiles}
      } \
        | LC_ALL=C sort -u \
        | while IFS= read -r file; do
            [ -f "$file" ] || continue
            printf '%s\n' "$file"
            ${pkgs.coreutils}/bin/sha256sum "$file" | awk '{print $1}'
          done \
        | ${pkgs.coreutils}/bin/sha256sum \
        | awk '{print $1}'
    }
  '';

  tasks = {
    "genie:run" = {
      guard = "genie";
      description = "Generate config files from .genie.ts sources";
      exec = trace.exec "genie:run" ''
        set -euo pipefail
        mkdir -p ${lib.escapeShellArg cacheRoot}
        ${collectGenieGeneratedFiles}
        ${computeGenieStateHash}
        genie
        cache_value="$(compute_genie_state_hash)"
        tmp_file="$(mktemp)"
        printf "%s" "$cache_value" > "$tmp_file"
        if [ -f ${lib.escapeShellArg stateFile} ] && cmp -s "$tmp_file" ${lib.escapeShellArg stateFile}; then
          rm "$tmp_file"
        else
          mv "$tmp_file" ${lib.escapeShellArg stateFile}
        fi

        generated_tmp_file="$(mktemp)"
        collect_genie_generated_files | LC_ALL=C sort -u > "$generated_tmp_file"
        mv "$generated_tmp_file" ${lib.escapeShellArg generatedFilesFile}
      '';
      status = trace.status "genie:run" "binary" ''
        set -euo pipefail
        if [ "''${DEVENV_SETUP_OUTER_CACHE_HIT:-0}" = "1" ]; then
          # The outer setup fingerprint already covers tracked generated-file
          # drift plus genie binary identity. On that warm path, only prove that
          # the outputs we generated last time still exist.
          [ -f ${lib.escapeShellArg stateFile} ] || exit 1
          [ -f ${lib.escapeShellArg generatedFilesFile} ] || exit 1
          while IFS= read -r file; do
            [ -n "$file" ] || continue
            [ -f "$file" ] || exit 1
          done < ${lib.escapeShellArg generatedFilesFile}
          exit 0
        fi
        [ -f ${lib.escapeShellArg stateFile} ] || exit 1
        ${computeGenieStateHash}
        current_hash="$(compute_genie_state_hash)"
        stored_hash="$(cat ${lib.escapeShellArg stateFile})"
        [ "$current_hash" = "$stored_hash" ]
      '';
    };
    "genie:watch" = {
      guard = "genie";
      description = "Watch and regenerate config files";
      exec = "genie --watch";
    };
    "genie:check" = {
      guard = "genie";
      description = "Check if generated files are up to date (CI)";
      exec = trace.exec "genie:check" "genie --check";
    };
  };
in
{
  packages = cliGuard.fromTasks tasks;
  tasks = cliGuard.stripGuards tasks;
}
