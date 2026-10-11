# Rules and root metadata are separate from each product source closure.
{ pkgs, repositoryRoot ? ../.. }:
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
