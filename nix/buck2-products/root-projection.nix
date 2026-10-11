# Rules and root metadata are separate from each product source closure.
{
  pkgs,
  repositoryRoot ? ../..,
}:
let
  workspacePaths =
    (builtins.fromJSON (builtins.readFile (repositoryRoot + "/package.json"))).workspaces;
  # Store-entry patch attrs eagerly load the patch's owning Buck package.
  # Its source attrs are eager too, so retain that package's declared tree,
  # not just the patch file. The existing workspace inventory owns this set.
  patchOwnerPaths = builtins.filter (
    path: builtins.pathExists (repositoryRoot + "/${path}/patches")
  ) workspacePaths;
in
pkgs.lib.fileset.toSource {
  root = repositoryRoot;
  fileset = pkgs.lib.fileset.unions (
    (map (path: repositoryRoot + "/${path}") [
      ".buckconfig"
      ".buckroot"
      ".watchmanconfig"
      "BUCK"
      # Root BUCK eagerly coerces its declared source attrs even when only a
      # conventional toolchain alias is requested. Retain those root inputs,
      # rather than importing unrelated package source trees.
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
      "genie/weaver-registry/attributes.yaml"
      "genie/weaver-registry/manifest.yaml"
      "genie/weaver-registry/signals.yaml"
      "genie/weaver-registry/registry.ts"
      "nix/weaver-flake/flake.nix"
    ])
    ++ map (path: repositoryRoot + "/${path}") patchOwnerPaths
    ++ [
      (pkgs.lib.fileset.fileFilter (
        file:
        file.name == "BUCK"
        || file.hasExt "bzl"
        || file.hasExt "json"
        || (
          file.hasExt "ts"
          && !(pkgs.lib.hasSuffix ".test.ts" file.name)
          && !(pkgs.lib.hasSuffix ".genie.ts" file.name)
        )
      ) (repositoryRoot + "/buck2"))
    ]
  );
}
