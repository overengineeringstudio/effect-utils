# Nix derivation that builds megarepo CLI binary.
# Uses bun build --compile for native platform.
#
# TODO: Move shell completion generation into mkPnpmCli helper
# so all CLIs get completions automatically.
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
      throw "Missing megarepo deps hash for system ${pkgs.system}";
  pnpm = import ../../../../nix/pnpm.nix { inherit pkgs; };
  mkPnpmCli = import ../../../../nix/workspace-tools/lib/mk-pnpm-cli.nix { inherit pkgs pnpm; };
  base = mkPnpmCli {
    name = "megarepo";
    entry = "packages/@overeng/megarepo/bin/mr.ts";
    binaryName = "mr";
    packageDir = "packages/@overeng/megarepo";
    workspaceRoot = src;
    # Managed by `dt nix:hash:megarepo` — do not edit manually.
    depsBuilds = {
      "." = {
        hash = selectHashForSystem {
          aarch64-darwin = "sha256-YtZIGkPM4lbXtu0z5iD+xxwvr79mCVdJ3+uOAf6EFTQ=";
          x86_64-darwin = "sha256-YtZIGkPM4lbXtu0z5iD+xxwvr79mCVdJ3+uOAf6EFTQ=";
          x86_64-linux = "sha256-YtZIGkPM4lbXtu0z5iD+xxwvr79mCVdJ3+uOAf6EFTQ=";
          aarch64-linux = "sha256-RSxFgMU1jzuNF6Ak4/Fq2b7RjKGWd3PI4Om4thmfxk8=";
        };
      };
    };
    smokeTestArgs = [ "--help" ];
    inherit gitRev commitTs dirty;
  };
in
pkgs.stdenv.mkDerivation {
  pname = "megarepo-with-completions";
  version = base.version or "0.0.0";
  meta.mainProgram = "mr";
  passthru = {
    inherit (base.passthru) depsBuildEntries depsBuildsByInstallRoot installRoots;
  };

  phases = [ "installPhase" ];

  installPhase = ''
    mkdir -p $out/bin
    cp ${base}/bin/mr $out/bin/mr

    # Generate shell completions
    # TODO: Move this into mkBunCli helper
    mkdir -p $out/share/fish/vendor_completions.d
    mkdir -p $out/share/bash-completion/completions
    mkdir -p $out/share/zsh/site-functions

    $out/bin/mr --completions fish > $out/share/fish/vendor_completions.d/mr.fish
    $out/bin/mr --completions bash > $out/share/bash-completion/completions/mr
    $out/bin/mr --completions zsh > $out/share/zsh/site-functions/_mr
  '';
}
