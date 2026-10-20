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
        # JSON) in the generated-file list and warm-state fingerprint. This
        # ambient census is freshness evidence only; it does not admit an
        # output as a semantic authority.
        if ${pkgs.git}/bin/git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
          {
            ${pkgs.git}/bin/git ls-files -z --recurse-submodules -- ':(glob)*.genie.ts' ':(glob)**/*.genie.ts'
            ${pkgs.git}/bin/git ls-files -z --others --exclude-standard -- ':(glob)*.genie.ts' ':(glob)**/*.genie.ts'
          } | while IFS= read -r -d $'\0' source; do
            [ -f "$source" ] || continue
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
          --glob '!*.genie.ts' \
          --glob '!**/*.genie.ts' \
          '^// Source: .*\.genie\.ts|^# Source: .*\.genie\.ts' . || true

        # Commentless JSON projections carry the same owner in data. Requiring
        # output-side provenance makes ownership checkable on a fresh checkout
        # even after the structural owner has been deleted.
        ${pkgs.ripgrep}/bin/rg -l \
          --glob '!tmp/**' \
          --glob '!.git/**' \
          --glob '!.devenv/**' \
          --glob '!node_modules/**' \
          --glob '!*.genie.ts' \
          --glob '!**/*.genie.ts' \
          --glob '*.json' \
          '"source"[[:space:]]*:[[:space:]]*"[^"]+\.genie\.ts"' . || true
      } | ${pkgs.gnused}/bin/sed 's#^\./##' | LC_ALL=C sort -u
    }

    assert_current_genie_owners_exist() {
      current_manifest="$1"
      invalid=0
      while IFS= read -r output; do
        [ -n "$output" ] || continue
        structural_owner="$output.genie.ts"
        [ -f "$structural_owner" ] && continue

        declared_owner="$(${pkgs.gnused}/bin/sed -n -E \
          -e 's@^(//|#) Source: (.*\.genie\.ts)[[:space:]]*$@\2@p' \
          -e 's@^[[:space:]]*"source"[[:space:]]*:[[:space:]]*"([^"]+\.genie\.ts)"[,]?[[:space:]]*$@\1@p' \
          "$output" | ${pkgs.coreutils}/bin/head -n 1)"
        if [ -n "$declared_owner" ] \
          && { [ -f "$declared_owner" ] || [ -f "$(dirname "$output")/$declared_owner" ]; }; then
          continue
        fi

        printf 'Genie ownership error: generated output has no current owner: %s\n' "$output" >&2
        invalid=1
      done < "$current_manifest"
      [ "$invalid" -eq 0 ]
    }

    assert_no_orphaned_genie_outputs() {
      retained_manifest="$1"
      current_manifest="$2"
      [ -f "$retained_manifest" ] || return 0

      orphaned=0
      while IFS= read -r output; do
        output="''${output#./}"
        [ -n "$output" ] || continue
        # Older marker census accidentally classified generator sources whose
        # template literals contained a Source marker as generated outputs.
        # Such paths can never be owned outputs and are safe to retire.
        case "$output" in *.genie.ts) continue ;; esac
        if [ -f "$output" ] && ! ${pkgs.gnugrep}/bin/grep -Fqx -- "$output" "$current_manifest"; then
          printf 'Genie ownership error: retained generated output has no current owner: %s\n' "$output" >&2
          orphaned=1
        fi
      done < "$retained_manifest"
      [ "$orphaned" -eq 0 ]
    }
  '';
  # Enumerate the extra non-`.genie.ts` generator inputs so their content joins
  # the fingerprint. Mirrors the git-tracked/untracked-non-ignored view used for
  # `.genie.ts` sources, with a find fallback outside a git worktree.
  enumerateGenieInputGlobs = lib.optionalString (cfg.extraInputGlobs != [ ]) ''
    if ${pkgs.git}/bin/git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    ${lib.concatMapStringsSep "\n" (glob: ''
      ${pkgs.git}/bin/git ls-files -z -- ${lib.escapeShellArg ":(glob)${glob}"} | tr '\0' '\n'
      ${pkgs.git}/bin/git ls-files -z --others --exclude-standard -- ${lib.escapeShellArg ":(glob)${glob}"} | tr '\0' '\n'
    '') cfg.extraInputGlobs}
    else
    ${lib.concatMapStringsSep "\n" (glob: ''
      ${pkgs.ripgrep}/bin/rg --files --hidden \
        --glob ${lib.escapeShellArg glob} \
        --glob '!.git/**' --glob '!.devenv/**' --glob '!node_modules/**' || true
    '') cfg.extraInputGlobs}
    fi
  '';
  computeGenieStateHash = ''
    ${collectGenieGeneratedFiles}
    valid_genie_input_manifest() {
      [ -f "$1" ] || return 1
      IFS= read -r manifest_version < "$1" || return 1
      [ "$manifest_version" = "genie-inputs-v1" ]
    }
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
            ${pkgs.git}/bin/git ls-files -z --recurse-submodules -- ':(glob)*.genie.ts' ':(glob)**/*.genie.ts' \
              | tr '\0' '\n'
            ${pkgs.git}/bin/git ls-files -z --others --exclude-standard -- ':(glob)*.genie.ts' ':(glob)**/*.genie.ts' \
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
          if [ -f ${lib.escapeShellArg "${cacheRoot}/inputs.txt"} ]; then
            { IFS= read -r manifest_version; cat; } < ${lib.escapeShellArg "${cacheRoot}/inputs.txt"}
          fi
          collect_genie_generated_files
        } | LC_ALL=C sort -u | while IFS= read -r file; do
          [ -n "$file" ] || continue
          printf '%s\n' "$file"
          # Resolution identity matters even when linked entrypoint bytes match:
          # its relative imports may resolve to a different source tree.
          if [ -e "$file" ]; then
            ${pkgs.coreutils}/bin/realpath -- "$file"
          fi
          if [ -f "$file" ]; then
            printf 'file\n'
            ${pkgs.coreutils}/bin/sha256sum "$file" | awk '{print $1}'
          elif [ -d "$file" ]; then
            printf 'directory\n'
            ${pkgs.findutils}/bin/find -H "$file" -mindepth 1 -maxdepth 1 -printf '%f %y\0' \
              | LC_ALL=C sort -z \
              | ${pkgs.coreutils}/bin/sha256sum | awk '{print $1}'
          else
            printf 'missing\n'
          fi
        done
      } \
        | ${pkgs.coreutils}/bin/sha256sum \
        | awk '{print $1}'
    }
  '';

  tasks = {
    "genie:prepare" = {
      description = "Run shared prerequisites before invoking genie";
      # Generator imports and the run-status fingerprint can read member sources.
      # Share this prerequisite across run/check/watch and both lint modules.
      after = lib.optionals (builtins.hasAttr "mr:setup" config.tasks) [ "mr:setup" ];
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
        # Older packaged CLIs may not yet record inputs. Never let a previous
        # manifest accidentally authorize caching a run from one of those CLIs.
        input_manifest="$(mktemp "$PWD/${cacheRoot}/inputs.XXXXXX")"
        rm "$input_manifest"
        trap 'rm -f "$input_manifest"' EXIT
        GENIE_INPUT_MANIFEST="$input_manifest" genie

        generated_tmp_file="$(mktemp)"
        collect_genie_generated_files | LC_ALL=C sort -u > "$generated_tmp_file"
        if ! assert_current_genie_owners_exist "$generated_tmp_file"; then
          rm "$generated_tmp_file"
          exit 1
        fi
        if ! assert_no_orphaned_genie_outputs ${lib.escapeShellArg generatedFilesFile} "$generated_tmp_file"; then
          rm "$generated_tmp_file"
          exit 1
        fi
        if ! valid_genie_input_manifest "$input_manifest"; then
          # Product publication can lag this module. Generation still succeeds,
          # but no complete freshness proof means every later status is a miss.
          rm -f ${lib.escapeShellArg stateFile} ${lib.escapeShellArg "${cacheRoot}/inputs.txt"}
          mv "$generated_tmp_file" ${lib.escapeShellArg generatedFilesFile}
          exit 0
        fi
        mv "$input_manifest" ${lib.escapeShellArg "${cacheRoot}/inputs.txt"}

        cache_value="$(compute_genie_state_hash)"
        tmp_file="$(mktemp)"
        printf "%s" "$cache_value" > "$tmp_file"
        if [ -f ${lib.escapeShellArg stateFile} ] && cmp -s "$tmp_file" ${lib.escapeShellArg stateFile}; then
          rm "$tmp_file"
        else
          mv "$tmp_file" ${lib.escapeShellArg stateFile}
        fi

        mv "$generated_tmp_file" ${lib.escapeShellArg generatedFilesFile}
      '';
      status = trace.status "genie:run" "binary" ''
        set -euo pipefail
        # The outer setup fingerprint is not a proof of generator freshness:
        # generators may consult arbitrary paths outside that fingerprint.
        # Always compare the input manifest, including missing paths.
        ${computeGenieStateHash}
        valid_genie_input_manifest ${lib.escapeShellArg "${cacheRoot}/inputs.txt"} || exit 1
        [ -f ${lib.escapeShellArg stateFile} ] || exit 1
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
      exec = trace.exec "genie:check" ''
        set -euo pipefail
        ${collectGenieGeneratedFiles}
        generated_tmp_file="$(mktemp)"
        trap 'rm -f "$generated_tmp_file"' EXIT
        collect_genie_generated_files | LC_ALL=C sort -u > "$generated_tmp_file"
        assert_current_genie_owners_exist "$generated_tmp_file"
        assert_no_orphaned_genie_outputs ${lib.escapeShellArg generatedFilesFile} "$generated_tmp_file"
        genie --check
      '';
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
        Additional generator inputs, expressed as plain Git glob patterns
        without pathspec magic, that participate in the `genie:run` warm-cache
        fingerprint alongside Genie's recorded input manifest. Built-in
        projection inputs are recorded automatically and need no configuration.
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
