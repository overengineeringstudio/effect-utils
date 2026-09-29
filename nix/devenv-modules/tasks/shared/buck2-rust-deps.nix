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
# If a member path-depends on a Buck-projected crate in another Cargo workspace,
# declare its repository-relative Cargo.toml path in
# `${workspaceRoot}/foreign-packages.json`:
#   { "foreignPackageManifestPaths": ["flakes/rust-shared/crates/otel-bootstrap/Cargo.toml"] }
# The projector and both Reindeer tasks read this same file. Reindeer uses
# a temporary supply-only Cargo manifest derived from the complete resolved
# graph, preserving registry dependencies of foreign first-party crates.
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
  supplyManifest = ../../../../scripts/buck2-rust-supply-manifest.ts;
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
    # Reindeer only inspects Cargo metadata; inherited compiler wrappers may not be on the task PATH.
    unset RUSTC_WRAPPER CARGO_BUILD_RUSTC_WRAPPER
    root="''${DEVENV_ROOT:-$PWD}"
    exec ${pkgs.bash}/bin/bash ${gate} ${mode} \
      "$root" \
      ${lib.escapeShellArg workspaceRoot} \
      ${lib.escapeShellArg thirdPartyBuckPath} \
      ${pkgs.reindeer}/bin/reindeer \
      ${pkgs.cargo}/bin/cargo \
      ${pkgs.rustc}/bin/rustc \
      ${pkgs.bun}/bin/bun \
      ${supplyManifest}
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
