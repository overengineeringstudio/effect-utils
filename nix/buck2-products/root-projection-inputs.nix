# Shared declaration for the product root and prepared tool identity.
{
  pkgs,
  repositoryRoot ? ../..,
  buckInputs ? import ./buck-inputs.nix {
    inherit repositoryRoot;
    inherit (pkgs) lib;
  },
}:
let
  workspacePaths =
    (builtins.fromJSON (builtins.readFile (repositoryRoot + "/package.json"))).workspaces;
  # Store-entry patch attrs eagerly load the patch's owning Buck package.
  patchOwnerPaths = builtins.filter (
    path: builtins.pathExists (repositoryRoot + "/${path}/patches")
  ) workspacePaths;
in
[
  ".buckconfig"
  ".buckroot"
  ".watchmanconfig"
  "BUCK"
  # Root BUCK eagerly coerces these source attrs, even for a toolchain alias.
  "package.json"
  "pnpm-workspace.yaml"
  "rust-toolchain.toml"
  ".oxfmtrc.json"
  ".oxlintrc.json"
  "devenv.lock"
  "devenv.yaml"
  "flake.lock"
  "flake.nix"
  "megarepo.kdl"
  "megarepo.lock"
  "patches/@myobie__pty@0.10.0.patch"
  "patches/effect@4.1.0.patch"
  "genie/buck2/mod.ts"
  "genie/native-dependency-policy.ts"
  "genie/weaver-registry/attributes.yaml"
  "genie/weaver-registry/manifest.yaml"
  "genie/weaver-registry/signals.yaml"
  "genie/weaver-registry/registry.ts"
  "nix/weaver-flake/flake.nix"
]
++ patchOwnerPaths
++ map (file: pkgs.lib.removePrefix "${toString repositoryRoot}/" (toString file)) buckInputs.files
