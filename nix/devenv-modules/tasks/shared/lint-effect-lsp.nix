# Effect LSP lint tasks using tsgo
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.lint-effect-lsp {
#       tsconfigFile = "tsconfig.all.json";
#     })
#   ];
#
# Provides: lint:check:effect-lsp
#
# Notes:
#   - Requires `tsgo` on PATH (for example via
#     `inputs.effect-utils.packages.${pkgs.system}.effect-tsgo`).
#   - Integrates into `lint:check` by default so `check:quick` picks it up via
#     the existing lint group.
{
  tsconfigFile ? "tsconfig.all.json",
  tsgoBin ? "tsgo",
  after ? [
    "genie:run"
    "pnpm:install"
  ],
}:
{ lib, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
in
{
  tasks = {
    "lint:check:effect-lsp" = {
      description = "Run Effect LSP diagnostics via tsgo";
      exec = trace.exec "lint:check:effect-lsp" "${tsgoBin} --build ${tsconfigFile} --pretty false";
      inherit after;
    };
    "lint:check" = {
      description = lib.mkDefault "Run all lint checks";
      after = lib.mkAfter [ "lint:check:effect-lsp" ];
    };
  };
}
