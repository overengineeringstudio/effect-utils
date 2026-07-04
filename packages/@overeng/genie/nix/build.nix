# Nix derivation for the Genie CLI.
#
# The builder still compiles the CLI as a package smoke proof, but the public
# executable runs the installed source workspace with Nix-managed Bun. Genie
# dynamically imports downstream `.genie.ts` files, and those imports need
# normal Bun/Node resolver semantics from the target checkout; Bun's compiled
# binary resolver does not provide that contract for arbitrary generated-source
# graphs.
#
# The CLI calls the executable oxfmt interface; the wrapper appends the Nix
# package to PATH so generated-file formatting stays outside the bundled
# JavaScript dependency closure.
{
  pkgs,
  src,
  gitRev ? "unknown",
  commitTs ? 0,
  dirty ? false,
  typeProofCompilerBin,
}:

let
  mkSharedHash = hash: { inherit hash; };
  pnpm = import ../../../../nix/pnpm.nix { inherit pkgs; };
  mkPnpmCli = import ../../../../nix/workspace-tools/lib/mk-pnpm-cli.nix { inherit pkgs pnpm; };
  opentuiCoreNative = import ../../../../nix/opentui-core-native.nix { inherit pkgs; };
  unwrapped = mkPnpmCli {
    name = "genie-unwrapped";
    entry = "packages/@overeng/genie/bin/genie.tsx";
    binaryName = "genie";
    packageDir = "packages/@overeng/genie";
    workspaceRoot = src;
    # Managed by the repo FOD refresh workflow — do not edit manually.
    depsBuilds = {
      "." = mkSharedHash "sha256-0x94Tpg4vw67pBlWy1/jH4/hO6+uRBQA6fATnGOCZ7g=";
    };
    nativeNodePackages = opentuiCoreNative.packages;
    installRuntimeWorkspace = true;
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "genie"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "genie";
    passthru = {
      buildIdentity = {
        inherit gitRev commitTs dirty;
      };
      inherit (unwrapped.passthru)
        depsBuildEntries
        depsBuildsByInstallRoot
        fodHashRepairTargets
        inheritRootPatchedDependenciesScript
        installRoots
        ;
    };
  }
  ''
    mkdir -p $out/bin
    makeWrapper ${pkgs.bun}/bin/bun $out/bin/genie \
      --add-flags ${unwrapped}/libexec/workspace/packages/@overeng/genie/bin/genie.tsx \
      --suffix PATH : ${pkgs.oxfmt}/bin \
      --set GENIE_ACTIONLINT_BIN ${pkgs.actionlint}/bin/actionlint \
      --set GENIE_EXPORT_TYPE_PROOF_COMPILER ${typeProofCompilerBin} \
      --set NODE_PATH ${unwrapped}/libexec/workspace/node_modules

    mkdir -p $out/share/genie
    cat > $out/share/genie/build-identity.json <<'EOF'
    ${builtins.toJSON {
      inherit gitRev commitTs dirty;
      package = "genie";
    }}
    EOF

    # Propagate shell completions from the unwrapped derivation
    for dir in share/fish/vendor_completions.d share/bash-completion/completions share/zsh/site-functions; do
      if [ -d "${unwrapped}/$dir" ]; then
        mkdir -p "$out/$dir"
        ln -s "${unwrapped}/$dir"/* "$out/$dir/"
      fi
    done
  ''
