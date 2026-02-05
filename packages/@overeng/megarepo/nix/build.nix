# Nix derivation that builds megarepo CLI binary.
# Uses bun build --compile for native platform.
#
# TODO: Move shell completion generation into mkPnpmCli helper
# so all CLIs get completions automatically.
{ pkgs, src, gitRev ? "unknown", commitTs ? 0, dirty ? false }:

let
  mkPnpmCli = import ../../../../nix/workspace-tools/lib/mk-pnpm-cli.nix { inherit pkgs; };
  base = mkPnpmCli {
    name = "megarepo";
    entry = "packages/@overeng/megarepo/bin/mr.ts";
    binaryName = "mr";
    packageDir = "packages/@overeng/megarepo";
    workspaceRoot = src;
    # Patches are in packages/@overeng/utils/patches/ (referenced by pnpm-lock.yaml)
    patchesDir = "packages/@overeng/utils/patches";
    # Pnpm store differs across platforms due to optional/os-specific deps.
    pnpmDepsHash =
      if pkgs.stdenv.isDarwin
      then "sha256-nRY4sF0CreFriGwuA60Gndd0rTKXVJtVc0+F9Fc/mYk="
      else "sha256-2q+5YiwberB0qQbZ4byJpXFbVeju94FL0ZZhXf9yB/I=";
    lockfileHash = "sha256-raPeotA57lO9N0y4w9t6fXFF8KSVvj4kGthXZhqIoY0=";
    packageJsonDepsHash = "sha256-tGkiG+aEO0TUw/SVvU9T0cgD4nMjENqRioocT5w3XMQ=";
    smokeTestArgs = [ "--help" ];
    inherit gitRev commitTs dirty;
  };
in
pkgs.stdenv.mkDerivation {
  pname = "megarepo-with-completions";
  version = base.version or "0.0.0";
  meta.mainProgram = "mr";

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
