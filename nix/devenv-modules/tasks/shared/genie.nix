# Genie (config file generation) tasks
#
# Usage in devenv.nix:
#   imports = [ inputs.effect-utils.devenvModules.tasks.genie ];
#
# Provides: genie:prepare, genie:run, genie:watch, genie:check
#
# NOTE: No pnpm:install:genie dependency here — this shared module is used by
# repos where genie may be a Nix package (no pnpm install needed). Repos that
# use source-mode genie via pnpm should add the dependency in their devenv.nix:
#   tasks."genie:run".after = [ "pnpm:install:genie" ];
#   tasks."genie:watch".after = [ "pnpm:install:genie" ];
#   tasks."genie:check".after = [ "pnpm:install:genie" ];
#
# This is a standard devenv module. Consumers configure it through the
# `effectUtils.genie.*` option namespace instead of raw `_module.args`.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.effectUtils.genie;
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  megarepoStoreEnv = builtins.getEnv "MEGAREPO_STORE";
  genieTaskEnv = lib.optionalAttrs (megarepoStoreEnv != "") {
    MEGAREPO_STORE = megarepoStoreEnv;
  };
  cacheRoot = ".devenv/task-cache/genie-run";
  stateFile = "${cacheRoot}/state.hash";
  generatedFilesFile = "${cacheRoot}/generated-files.txt";
  collectGenieGeneratedFiles = ''
    collect_genie_generated_files() {
      {
        # A colocated `name.ext.genie.ts` source owns `name.ext`. Deriving the
        # output path from the source keeps formats without comments (notably
        # JSON) in the generated-file list and warm-state fingerprint.
        if ${pkgs.git}/bin/git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
          {
            ${pkgs.git}/bin/git ls-files -z --recurse-submodules -- '*.genie.ts' ':(glob)**/*.genie.ts'
            ${pkgs.git}/bin/git ls-files -z --others --exclude-standard -- '*.genie.ts' ':(glob)**/*.genie.ts'
          } | while IFS= read -r -d $'\0' source; do
            output="''${source%.genie.ts}"
            if [ -f "$output" ]; then
              printf '%s\n' "$output"
            fi
          done
        else
          ${pkgs.findutils}/bin/find . \
            -type f \
            -name '*.genie.ts' \
            -not -path './.git/*' \
            -not -path './.devenv/*' \
            -not -path './node_modules/*' \
            -print0 \
            | while IFS= read -r -d $'\0' source; do
                output="''${source%.genie.ts}"
                if [ -f "$output" ]; then
                  printf '%s\n' "$output"
                fi
              done
        fi

        # Retain marker discovery for legacy generators whose outputs are not
        # colocated with an equivalently named `.genie.ts` source.
        ${pkgs.ripgrep}/bin/rg -l \
          --glob '!tmp/**' \
          --glob '!.git/**' \
          --glob '!.devenv/**' \
          --glob '!node_modules/**' \
          '^// Source: .*\.genie\.ts|^# Source: .*\.genie\.ts' . || true
      } | LC_ALL=C sort -u
    }
  '';
  # Enumerate the extra non-`.genie.ts` generator inputs so their content joins
  # the fingerprint. Mirrors the git-tracked/untracked-non-ignored view used for
  # `.genie.ts` sources, with a find fallback outside a git worktree.
  enumerateGenieInputGlobs = lib.optionalString (cfg.extraInputGlobs != [ ]) ''
    if ${pkgs.git}/bin/git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    ${lib.concatMapStringsSep "\n" (glob: ''
      ${pkgs.git}/bin/git ls-files -z -- ${lib.escapeShellArg glob} | tr '\0' '\n'
      ${pkgs.git}/bin/git ls-files -z --others --exclude-standard -- ${lib.escapeShellArg glob} | tr '\0' '\n'
    '') cfg.extraInputGlobs}
    else
    ${lib.concatMapStringsSep "\n" (glob: ''
      ${pkgs.findutils}/bin/find . -type f -path ${lib.escapeShellArg "./${glob}"} \
        -not -path './.git/*' -not -path './.devenv/*' -not -path './node_modules/*' \
        -print 2>/dev/null || true
    '') cfg.extraInputGlobs}
    fi
  '';
  computeGenieStateHash = ''
    ${collectGenieGeneratedFiles}
    compute_genie_state_hash() {
      {
        if command -v genie >/dev/null 2>&1; then
          printf 'genie-path %s\n' "$(command -v genie)"
          printf 'genie-version %s\n' "$(genie --version 2>/dev/null | ${pkgs.coreutils}/bin/head -n1 || echo unknown)"
        fi

        {
          # Track both the `.genie.ts` sources and the generated files they own
          # so warm status checks catch manual drift without booting the full
          # CLI. Follow Git's tracked + untracked/non-ignored view in worktrees.
          if ${pkgs.git}/bin/git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
            ${pkgs.git}/bin/git ls-files -z --recurse-submodules -- '*.genie.ts' ':(glob)**/*.genie.ts' \
              | tr '\0' '\n'
            ${pkgs.git}/bin/git ls-files -z --others --exclude-standard -- '*.genie.ts' ':(glob)**/*.genie.ts' \
              | tr '\0' '\n'
          else
            ${pkgs.findutils}/bin/find . \
              -type f \
              -name '*.genie.ts' \
              -not -path './.git/*' \
              -not -path './.devenv/*' \
              -not -path './node_modules/*' \
              -print
          fi
          ${enumerateGenieInputGlobs}
          collect_genie_generated_files
        } | LC_ALL=C sort -u | while IFS= read -r file; do
          [ -f "$file" ] || continue
          printf '%s\n' "$file"
          ${pkgs.coreutils}/bin/sha256sum "$file" | awk '{print $1}'
        done
      } \
        | ${pkgs.coreutils}/bin/sha256sum \
        | awk '{print $1}'
    }
  '';

  tasks = {
    "genie:prepare" = {
      description = "Run shared prerequisites before invoking genie";
      exec = trace.exec "genie:prepare" "true";
      env = genieTaskEnv;
    };
    "genie:run" = {
      guard = "genie";
      description = "Generate config files from .genie.ts sources";
      after = [ "genie:prepare" ];
      env = genieTaskEnv;
      exec = trace.exec "genie:run" ''
        set -euo pipefail
        mkdir -p ${lib.escapeShellArg cacheRoot}
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
          # the outputs we generated last time still exist. Content drift is
          # intentionally deferred to the next full fingerprint recomputation so
          # shell entry does not have to boot the generator or re-hash every
          # generated file on every hit.
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
      after = [ "genie:prepare" ];
      env = genieTaskEnv;
      exec = trace.exec "genie:watch" "genie --watch";
    };
    "genie:check" = {
      guard = "genie";
      description = "Check if generated files are up to date (CI)";
      after = [ "genie:prepare" ];
      env = genieTaskEnv;
      exec = trace.exec "genie:check" "genie --check";
    };
  };
in
{
  options.effectUtils.genie = {
    package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      description = ''
        Real Genie package used by the guarded `genie` task commands. When set,
        the module owns `bin/genie` and dispatches to this package by absolute
        store path under `DEVENV_TASK_PASSTHROUGH=1`. Leave null only for repos
        that intentionally resolve `genie` from PATH.
      '';
    };

    extraInputGlobs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        Extra non-.genie.ts generator inputs, expressed as git pathspecs/globs,
        that should participate in the `genie:run` warm-cache fingerprint.
      '';
    };
  };

  config = {
    packages = cliGuard.fromTasks {
      inherit tasks;
      reals = lib.optionalAttrs (cfg.package != null) { genie = cfg.package; };
    };
    tasks = cliGuard.stripGuards tasks;
  };
}
