{ pkgs }:
let
  collector = pkgs.runCommand "pnpm-store-gc-engine" {
    nativeBuildInputs = [
      pkgs.rustc
      pkgs.stdenv.cc
    ];
  } ''
    mkdir -p "$out/bin"
    rustc --edition=2024 -D warnings -O ${./pnpm-store-gc.rs} -o "$out/bin/pnpm-store-gc-engine"
  '';
in
pkgs.writeShellApplication {
  name = "pnpm-store-gc";
  runtimeInputs = [
    pkgs.bash
    pkgs.git
    pkgs.gh
    pkgs.flock
  ] ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin [ pkgs.lsof ];
  text = ''
    # Eligibility observations are private host/user state, not worktree state.
    umask 077
    exec ${collector}/bin/pnpm-store-gc-engine "$@"
  '';
}
