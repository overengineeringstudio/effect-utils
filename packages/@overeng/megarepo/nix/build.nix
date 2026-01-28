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
    pnpmDepsHash = "sha256-nXRs3SPrF55GmPswa/X0qs+uEIvE01jmiwzeqcDRALc=";
    localDeps = [
      { dir = "packages/@overeng/utils"; hash = "sha256-MycpokWA4roGBELpRdj5CXjRdPcboktPBLoVWP55rJI="; }
      { dir = "packages/@overeng/cli-ui"; hash = "sha256-ve2v2z7iCkSuHxE6GvjPTXN3OKjfu7EOmSSanw8APg8="; }
      { dir = "packages/@overeng/effect-path"; hash = "sha256-LCb6+D3hRFai59RFFZq0EFy5e+tIqACTJReT1WGNj8w="; }
    ];
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
