# Generate or verify one non-vendored Reindeer graph without repo-local gate logic.
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.buck2-rust-deps {
#       workspaceRoot = "crates/tool";
#       thirdPartyBuckPath = "vendor/cargo/BUCK";
#       taskPrefix = "buck2:rust-deps:tool";
#     })
#   ];
#
# Provides `${taskPrefix}:generate` and `${taskPrefix}:check`.
{
  workspaceRoot,
  thirdPartyBuckPath ? "${workspaceRoot}/third-party/BUCK",
  taskPrefix ? "buck2:rust-deps",
}:
{
  pkgs,
  lib,
  ...
}:
let
  trace = import ../lib/trace.nix { inherit lib; };
  gate = ../../../../scripts/buck2-rust-deps.sh;
  workspaceSegments = lib.splitString "/" workspaceRoot;
  validRelativePath =
    workspaceRoot != ""
    && !(lib.hasPrefix "/" workspaceRoot)
    && !(lib.hasInfix "\\" workspaceRoot)
    && builtins.all (segment: segment != "" && segment != "..") workspaceSegments;
  validTaskPrefix =
    builtins.isString taskPrefix && builtins.match "^[a-z0-9][a-z0-9:-]*$" taskPrefix != null;
  script = mode: ''
    set -euo pipefail
    root="''${DEVENV_ROOT:-$PWD}"
    exec ${pkgs.bash}/bin/bash ${gate} ${mode} \
      "$root" \
      ${lib.escapeShellArg workspaceRoot} \
      ${lib.escapeShellArg thirdPartyBuckPath} \
      ${pkgs.reindeer}/bin/reindeer \
      ${pkgs.cargo}/bin/cargo \
      ${pkgs.rustc}/bin/rustc \
      ${pkgs.bun}/bin/bun
  '';
in
assert lib.assertMsg validRelativePath
  "buck2-rust-deps: workspaceRoot must be a normalized repository-relative path";
assert lib.assertMsg validTaskPrefix "buck2-rust-deps: taskPrefix must match ^[a-z0-9][a-z0-9:-]*$";
{
  tasks."${taskPrefix}:generate" = {
    description = "Regenerate the non-vendored Reindeer graph for ${workspaceRoot}";
    exec = trace.exec "${taskPrefix}:generate" (script "generate");
  };

  tasks."${taskPrefix}:check" = {
    description = "Verify the non-vendored Reindeer graph for ${workspaceRoot}";
    exec = trace.exec "${taskPrefix}:check" (script "check");
  };
}
