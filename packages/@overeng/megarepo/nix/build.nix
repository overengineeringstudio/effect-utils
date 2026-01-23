# Nix derivation that builds megarepo CLI binary.
# Uses bun build --compile for native platform.
#
# TODO: Move shell completion generation into mkBunCli helper
# so all CLIs get completions automatically.
# TODO: Remove pkgsUnstable param once mk-bun-cli.nix is updated to use single pkgs
{ pkgs, pkgsUnstable ? pkgs, src, gitRev ? "unknown", dirty ? false }:

let
  mkBunCli = import ../../../../nix/workspace-tools/lib/mk-bun-cli.nix { inherit pkgs pkgsUnstable; };
  base = mkBunCli {
    name = "megarepo";
    entry = "packages/@overeng/megarepo/bin/mr.ts";
    binaryName = "mr";
    packageDir = "packages/@overeng/megarepo";
    workspaceRoot = src;
    extraExcludedSourceNames = [ ];
    # TODO: Re-enable typecheck once Effect lint warnings are resolved
    typecheck = false;
    # Smoke test just runs --help which doesn't need git
    smokeTestArgs = [ "--help" ];
    bunDepsHash = "sha256-UnaWL12mtRSo/I4Yn58radxhc7gz1w60t5vrmWSJjBk=";
    dirty = dirty;
    inherit gitRev;
  };
in
pkgs.stdenv.mkDerivation {
  pname = "megarepo-with-completions";
  version = base.version or "0.0.0";

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
