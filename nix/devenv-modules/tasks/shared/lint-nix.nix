# Nix lint tasks (formatting + dead code + eval warnings)
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.lint-nix {
#       # Eval targets to check for deprecation warnings via abort-on-warn.
#       # Each entry is a flake attribute path that will be evaluated.
#       evalTargets = [
#         ".#nixosConfigurations.myhost.config.system.build.toplevel"
#         ".#homeConfigurations.myuser.activationPackage"
#       ];
#     })
#   ];
#
#   # Without eval checks (format + deadnix only):
#   imports = [ (inputs.effect-utils.devenvModules.tasks.lint-nix {}) ];
#
# Provides: lint:nix, lint:nix:format, lint:nix:deadcode, lint:nix:eval-warnings
#           lint:nix:fix:format
{
  evalTargets ? [ ],
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  git = "${pkgs.git}/bin/git";

  hasEvalTargets = evalTargets != [ ];

  evalScript = pkgs.writeShellScript "lint-nix-eval-warnings" ''
    set -euo pipefail

    failed=false
    for target in "$@"; do
      echo "Evaluating $target..."
      if ! ${pkgs.nix}/bin/nix eval "$target" --raw --option abort-on-warn true 2>/dev/null 1>/dev/null; then
        echo "✗ $target: evaluation warnings detected"
        echo "  Run with --show-trace for details:"
        echo "  nix eval '$target' --raw --option abort-on-warn true --show-trace"
        failed=true
      else
        echo "✓ $target: no warnings"
      fi
    done

    if [ "$failed" = true ]; then
      exit 1
    fi
  '';

  evalTargetsArgs = builtins.concatStringsSep " " (map (t: "'${t}'") evalTargets);

  guardedTasks = {
    "lint:nix:format" = {
      guard = "nixfmt";
      description = "Check Nix formatting with nixfmt";
      # nixfmt exposes no declared structured source (adapters/.experiments/0005),
      # so it opts into otel-scrape as adapter="none" (decision 0018): a timed,
      # named `nixfmt` command span beneath the task span, no parser, stdout
      # untouched. Arrays are empty (command runs bare) without otel-scrape.
      exec = trace.exec "lint:nix:format" ''
        ${trace.instr {
          adapter = "none";
          name = "lint:nix:format";
        }}
        ${git} ls-files '*.nix' | xargs "''${_otel_instr[@]}" nixfmt --check
      '';
    };
    "lint:nix:fix:format" = {
      guard = "nixfmt";
      description = "Fix Nix formatting with nixfmt";
      exec = trace.exec "lint:nix:fix:format" ''
        ${git} ls-files '*.nix' | xargs nixfmt
      '';
    };
    "lint:nix:deadcode" = {
      guard = "deadnix";
      description = "Check for dead Nix code";
      # deadnix has a declared structured source (NDJSON, adapters/03-deadnix), so it
      # opts into otel-scrape as adapter="deadnix" (decision 0017): otel-scrape
      # captures the `--output-format json` stream, parses public-safe records
      # (hashed file + line + a deadnix.findings count), and re-renders a compact
      # summary. The child flag is injected by _otel_instr_flags. Both arrays are
      # empty (deadnix runs bare) without otel-scrape.
      exec = trace.exec "lint:nix:deadcode" ''
        ${trace.instr {
          adapter = "deadnix";
          name = "lint:nix:deadcode";
        }}
        ${git} ls-files '*.nix' | xargs "''${_otel_instr[@]}" deadnix "''${_otel_instr_flags[@]}"
      '';
    };
  };

  otherTasks = {
    # devenv discards a task's stdout, so a GitHub workflow command echoed there
    # never reaches the runner and never becomes an annotation or a log group.
    # stderr is forwarded, so that is where these have to go. Without this guard
    # the mistake is invisible: the emit looks correct and simply does nothing.
    #
    # This enforces a workaround, not a best practice — GitHub documents workflow
    # commands on stdout, and on a plain shell step that works.
    # TODO(cachix/devenv#3038): remove this task once devenv forwards task stdout
    # and the fixed version is pinned everywhere.
    "lint:nix:workflow-commands" = {
      description = "Check GitHub workflow commands in task definitions go to stderr";
      exec = trace.exec "lint:nix:workflow-commands" ''
        offenders=$(${git} ls-files 'nix/devenv-modules/*.nix' 'nix/devenv-modules/*.sh' \
          | xargs grep -nE "(echo|printf)( +-[A-Za-z]+)* +['\"]::" \
          | grep -v '>&2' || true)

        if [ -n "$offenders" ]; then
          echo "Workflow commands must be written to stderr; devenv discards task stdout." >&2
          echo "Append '>&2' to each line below:" >&2
          echo "$offenders" >&2
          exit 1
        fi
      '';
    };
    "lint:nix:eval-warnings" = lib.mkIf hasEvalTargets {
      description = "Check for Nix evaluation warnings (deprecated APIs)";
      exec = trace.exec "lint:nix:eval-warnings" "${evalScript} ${evalTargetsArgs}";
    };
    "lint:nix" = {
      description = "Run all Nix lint checks";
      after = [
        "lint:nix:format"
        "lint:nix:deadcode"
        "lint:nix:workflow-commands"
      ]
      ++ lib.optional hasEvalTargets "lint:nix:eval-warnings";
    };
  };
in
{
  # The nixfmt/deadnix guards own their command names by exec'ing the real
  # binaries via absolute path (see cli-guard.nix), so the reals no longer need
  # to be competing top-level providers — dropping them from `packages` removes
  # the buildEnv collision while the guards keep them reachable.
  packages = cliGuard.fromTasks {
    tasks = guardedTasks;
    reals = {
      nixfmt = pkgs.nixfmt-rfc-style;
      deadnix = pkgs.deadnix;
    };
  };
  tasks = cliGuard.stripGuards (guardedTasks // otherTasks);
}
