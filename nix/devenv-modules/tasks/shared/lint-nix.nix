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
      exec = trace.exec "lint:nix:format" ''
        ${git} ls-files '*.nix' | xargs nixfmt --check
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
      exec = trace.exec "lint:nix:deadcode" ''
        ${git} ls-files '*.nix' | xargs deadnix
      '';
    };
  };

  otherTasks = {
    "lint:nix:eval-warnings" = lib.mkIf hasEvalTargets {
      description = "Check for Nix evaluation warnings (deprecated APIs)";
      exec = trace.exec "lint:nix:eval-warnings" "${evalScript} ${evalTargetsArgs}";
    };
    "lint:nix" = {
      description = "Run all Nix lint checks";
      after = [
        "lint:nix:format"
        "lint:nix:deadcode"
      ]
      ++ lib.optional hasEvalTargets "lint:nix:eval-warnings";
    };
  };
in
{
  packages = [
    pkgs.nixfmt-rfc-style
    pkgs.deadnix
  ]
  ++ cliGuard.fromTasks guardedTasks;
  tasks = cliGuard.stripGuards (guardedTasks // otherTasks);
}
