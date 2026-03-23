# Nix derivation that builds genie CLI binary.
# Uses bun build --compile for native platform.
#
# Fallback pattern: oxfmt is appended to PATH via --suffix, so system oxfmt
# takes precedence when available, but bundled oxfmt is used as fallback.
# This avoids formatting churn when oxfmt isn't installed in the environment.
{ pkgs, src, gitRev ? "unknown", commitTs ? 0, dirty ? false }:

let
  mkPnpmCli = import ../../../../nix/workspace-tools/lib/mk-pnpm-cli.nix { inherit pkgs; };
  lockfileHash = "sha256-P4/K531J1XpG/Emx8wcwi5nQNuggfTjfxhM9FSzsvGA=";
  packageJsonDepsHash = "sha256-YWB19I7bkalSkvuA1tR9753CiQGIb41ObaHLdXJlP9o=";
  unwrapped = mkPnpmCli {
    name = "genie-unwrapped";
    entry = "packages/@overeng/genie/bin/genie.tsx";
    binaryName = "genie";
    packageDir = "packages/@overeng/genie";
    workspaceRoot = src;
    # Managed by `dt nix:hash:genie` — do not edit manually.
    pnpmDepsHash = "sha256-aLZKchg9gVOzD0etSAaLJiAxkJ+MkGafqOUgiFtVXiA=";
    inherit lockfileHash gitRev commitTs dirty;
  };
in
pkgs.runCommand "genie" {
  nativeBuildInputs = [ pkgs.makeWrapper ];
  meta.mainProgram = "genie";
} ''
  mkdir -p $out/bin
  makeWrapper ${unwrapped}/bin/genie $out/bin/genie \
    --suffix PATH : ${pkgs.oxfmt}/bin
''
