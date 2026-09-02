#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

source="$tmpdir/source"
mkdir -p "$source/nix/devenv-modules/tasks/shared" "$source/nix/devenv-modules/tasks/lib"
cp "$ROOT/nix/devenv-modules/tasks/shared/workflow-report-module.nix" \
  "$source/nix/devenv-modules/tasks/shared/workflow-report-module.nix"
cp "$ROOT/nix/devenv-modules/tasks/lib/trace.nix" \
  "$source/nix/devenv-modules/tasks/lib/trace.nix"

nix eval --impure --expr "
  let
    flake = builtins.getFlake (toString $ROOT);
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    moduleSource = builtins.path {
      path = $source;
      name = \"workflow-report-module-source\";
    };
    evaluated = pkgs.lib.evalModules {
      specialArgs = { inherit pkgs; };
      modules = [
        ({ ... }: {
          options.tasks = pkgs.lib.mkOption {
            type = pkgs.lib.types.attrsOf pkgs.lib.types.anything;
            default = { };
          };
        })
        (moduleSource + \"/nix/devenv-modules/tasks/shared/workflow-report-module.nix\")
        {
          effectUtils.workflowReport.ciToolsBin = \"/ci-tools\";
        }
      ];
    };
  in evaluated.config.tasks.\"workflow-report:publish\".exec
" >/dev/null

echo "workflow-report module store-source test passed"
