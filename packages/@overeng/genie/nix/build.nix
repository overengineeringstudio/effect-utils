# Nix derivation that builds genie CLI binary.
# Uses bun build --compile for native platform.
#
# Fallback pattern: oxfmt is appended to PATH via --suffix, so system oxfmt
# takes precedence when available, but bundled oxfmt is used as fallback.
# This avoids formatting churn when oxfmt isn't installed in the environment.
{
  pkgs,
  src,
  gitRev ? "unknown",
  commitTs ? 0,
  dirty ? false,
}:

let
  selectHashForSystem =
    hashes:
    if builtins.hasAttr pkgs.system hashes then
      hashes.${pkgs.system}
    else
      throw "Missing genie deps hash for system ${pkgs.system}";
  pnpm = import ../../../../nix/pnpm.nix { inherit pkgs; };
  mkPnpmCli = import ../../../../nix/workspace-tools/lib/mk-pnpm-cli.nix { inherit pkgs pnpm; };
  unwrapped = mkPnpmCli {
    name = "genie-unwrapped";
    entry = "packages/@overeng/genie/bin/genie.tsx";
    binaryName = "genie";
    packageDir = "packages/@overeng/genie";
    workspaceRoot = src;
    # Managed by `dt nix:hash:genie` — do not edit manually.
    depsBuilds = {
      "." = {
        hash = selectHashForSystem {
          aarch64-darwin = "sha256-50RP0Be+nHX3e40OJfM3pwySAJYfDaEsPWpzVRFlT2c=";
          x86_64-darwin = "sha256-50RP0Be+nHX3e40OJfM3pwySAJYfDaEsPWpzVRFlT2c=";
          x86_64-linux = "sha256-50RP0Be+nHX3e40OJfM3pwySAJYfDaEsPWpzVRFlT2c=";
          aarch64-linux = "sha256-ov9ObT6iptqO97gO/ZqVtEX3rsn7rXD6FWKDmmm8cW0=";
        };
      };
    };
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "genie"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "genie";
    passthru = {
      inherit (unwrapped.passthru) depsBuildEntries depsBuildsByInstallRoot installRoots;
    };
  }
  ''
    mkdir -p $out/bin
    makeWrapper ${unwrapped}/bin/genie $out/bin/genie \
      --suffix PATH : ${pkgs.oxfmt}/bin
  ''
