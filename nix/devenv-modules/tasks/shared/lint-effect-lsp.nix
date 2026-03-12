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
#   - Intentionally standalone: this is slower than the fast lint/check path, so
#     consumers should opt into aggregating it explicitly if they want it in a
#     broader check group.
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
  };
}
