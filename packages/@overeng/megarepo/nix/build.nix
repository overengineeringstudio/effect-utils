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
  pnpm = import ../../../../nix/pnpm.nix { inherit pkgs; };
  mkPnpmCli = import ../../../../nix/workspace-tools/lib/mk-pnpm-cli.nix { inherit pkgs pnpm; };
  lockfileHash = null;
  packageJsonDepsHash = "sha256-FGoqoErZGoDmYQhM+hNWWDP+Md+drwGzZwQpX+kJF1k=";
  base = mkPnpmCli {
    name = "megarepo";
    entry = "packages/@overeng/megarepo/bin/mr.ts";
    binaryName = "mr";
    packageDir = "packages/@overeng/megarepo";
    workspaceRoot = src;
    # Managed by `dt nix:hash:megarepo` — do not edit manually.
    pnpmDepsHash = "sha256-qkWtsxmqG1dhyM30OoYldbODIlVDFBa4BnvaI5ns52o=";
    smokeTestArgs = [ "--help" ];
    inherit
      lockfileHash
      gitRev
      commitTs
      dirty
      ;
  };
in
pkgs.stdenv.mkDerivation {
  pname = "megarepo-with-completions";
  version = base.version or "0.0.0";
  meta.mainProgram = "mr";
  passthru = {
    # Mirror the underlying FOD so external tooling can hash-refresh the
    # prepared deps without rebuilding the completion wrapper.
    inherit (base.passthru) pnpmDeps;
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
