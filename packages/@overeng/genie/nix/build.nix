# Nix derivation that builds genie CLI binary.
# Uses bun build --compile for native platform.
#
# Fallback pattern: oxfmt is appended to PATH via --suffix, so system oxfmt
# takes precedence when available, but bundled oxfmt is used as fallback.
# This avoids formatting churn when oxfmt isn't installed in the environment.
{ pkgs, src, gitRev ? "unknown", commitTs ? 0, dirty ? false }:

let
  mkPnpmCli = import ../../../../nix/workspace-tools/lib/mk-pnpm-cli.nix { inherit pkgs; };
  lockfileHash = "sha256-uo451cE+RbsNgjjyKJtEIZEjTiuNZ1LuwDnYqgRLN70=";
  packageJsonDepsHash = "sha256-osL8B/2iNi2+BrbifKIaTvY7zqcT54dNS6g4RWSzw+Y=";
  unwrapped = mkPnpmCli {
    name = "genie-unwrapped";
    entry = "packages/@overeng/genie/bin/genie.tsx";
    binaryName = "genie";
    packageDir = "packages/@overeng/genie";
    workspaceRoot = src;
    # Managed by `dt nix:hash:genie` — do not edit manually.
    pnpmDepsHash = "sha256-WZUubgXZunmOYARSjnPtIQtV96b1DPRnPLKW4taPydk=";
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
