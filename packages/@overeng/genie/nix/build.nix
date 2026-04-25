# Nix derivation that builds genie CLI binary.
# Uses bun build --compile for native platform.
#
# Fallback pattern: oxfmt is appended to PATH via --suffix, so system oxfmt
# takes precedence when available, but bundled oxfmt is used as fallback.
# This avoids formatting churn when oxfmt isn't installed in the environment.
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
  unwrapped = mkPnpmCli {
    name = "genie-unwrapped";
    entry = "packages/@overeng/genie/bin/genie.tsx";
    binaryName = "genie";
    packageDir = "packages/@overeng/genie";
    workspaceRoot = src;
    # Managed by `dt nix:hash:genie` — do not edit manually.
    depsBuilds = {
      "." = {
        hash = "sha256-wC/q9X5zeqqD7vF/6Chg0CzzVWNps1K40dH0m4uoITg=";
      };
    };
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "genie"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "genie";
    passthru = {
      inherit (unwrapped.passthru) depsBuildEntries depsBuildsByInstallRoot installRoots;
    };
  }
  ''
    mkdir -p $out/bin
    makeWrapper ${unwrapped}/bin/genie $out/bin/genie \
      --suffix PATH : ${pkgs.oxfmt}/bin \
      --set GENIE_ACTIONLINT_BIN ${pkgs.actionlint}/bin/actionlint

    # Propagate shell completions from the unwrapped derivation
    for dir in share/fish/vendor_completions.d share/bash-completion/completions share/zsh/site-functions; do
      if [ -d "${unwrapped}/$dir" ]; then
        mkdir -p "$out/$dir"
        ln -s "${unwrapped}/$dir"/* "$out/$dir/"
      fi
    done
  ''
