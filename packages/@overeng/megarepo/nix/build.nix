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
    # Managed by `dt nix:hash:megarepo` — do not edit manually.
    pnpmDepsHash = "sha256-rxtjjOgNSo4l+7AZWr8AxRIEqZTKCWtNtfoUyLYyqBo=";
    lockfileHash = "sha256-dfX9Xlfmh9/qPwNA6s77j6fxnoP8+v/TkKztJ2dW3vc=";
    packageJsonDepsHash = "sha256-kWcRTxOsjzVCYB7WyHeeXd39iaDM7YmgXuNFOwjxzTA=";
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
