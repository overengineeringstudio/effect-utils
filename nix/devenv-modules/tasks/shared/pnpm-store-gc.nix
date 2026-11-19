{
  pkgs,
  processEvidenceCommand ? null,
}:
assert processEvidenceCommand == null || pkgs.lib.isDerivation processEvidenceCommand;
let
  collector =
    pkgs.runCommand "pnpm-store-gc-engine"
      (
        {
          nativeBuildInputs = [
            pkgs.rustc
            pkgs.stdenv.cc
          ];
        }
        // pkgs.lib.optionalAttrs (processEvidenceCommand != null) {
          PNPM_GC_PROCESS_EVIDENCE_COMMAND = pkgs.lib.getExe processEvidenceCommand;
        }
      )
      ''
        mkdir -p "$out/bin"
        cp ${./pnpm-store-gc.rs} pnpm-store-gc.rs
        cp ${./pnpm-store-evidence.rs} pnpm-store-evidence.rs
        rustc --edition=2024 -D warnings -O pnpm-store-gc.rs -o "$out/bin/pnpm-store-gc-engine"
      '';
in
pkgs.writeShellApplication {
  name = "pnpm-store-gc";
  runtimeInputs = [
    pkgs.bash
    pkgs.git
    pkgs.nodejs
    pkgs.flock
    pkgs.coreutils
  ];
  text = ''
    # Eligibility observations are private host/user state, not worktree state.
    umask 077
    exec ${collector}/bin/pnpm-store-gc-engine "$@"
  '';
}
