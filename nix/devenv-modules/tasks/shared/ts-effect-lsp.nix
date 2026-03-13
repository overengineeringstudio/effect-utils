# Effect LSP TypeScript diagnostics tasks using tsgo
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.ts-effect-lsp {
#       tsconfigFile = "tsconfig.all.json";
#     })
#   ];
#
# Provides: ts:effect-lsp
#
# Notes:
#   - Requires `tsgo` on PATH (for example via
#     `inputs.effect-utils.packages.${pkgs.system}.effect-tsgo`).
#   - Intentionally standalone: this is slower than the fast lint/check path, so
#     consumers should opt into aggregating it explicitly if they want it in a
#     broader check group.
#   - TODO(effect-utils#377): keep this separate only until the repo-wide
#     TypeScript check migrates from `tsc --build` to `Effect-TS/tsgo --build`.
#     Once `ts:check` is tsgo-backed, collapse this into the normal `ts:check`
#     path instead of maintaining a parallel Effect LSP task.
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
    # TODO(effect-utils#377): this should become part of the normal tsgo-backed
    # `ts:check` flow once we stop using `tsc --build` for the main workspace
    # type check.
    "ts:effect-lsp" = {
      description = "Run Effect LSP diagnostics via tsgo";
      exec = trace.exec "ts:effect-lsp" "${tsgoBin} --build ${tsconfigFile} --pretty false";
      inherit after;
    };
  };
}
