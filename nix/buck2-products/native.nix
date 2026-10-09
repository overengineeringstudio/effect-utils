# Native products for the evaluating host platform. Rust products use the
# pinned Cargo archive projection; the TypeScript API server uses pnpm archives.
# Every product is independently realized and validated by importNative.
{
  pkgs,
  mkBuckProductFromSource,
  capabilities,
  pnpmArchives,
  repositoryRoot ? ../..,
}:

let
  inventory = builtins.fromJSON (builtins.readFile ./native-targets.json);
  # Native shell products are source-addressed, not HEAD-addressed. Keep the
  # ordinary repository Buck root as a separate, declared rules input; package
  # source closures come from the committed Genie inventory below.
  rootProjection = pkgs.lib.fileset.toSource {
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
  };
  cargoArchives = import ../workspace-tools/lib/buck2-cargo-archives.nix {
    inherit pkgs;
    thirdPartyBuckFiles = [ (repositoryRoot + "/rust/third-party/BUCK") ];
  };
  validProduct =
    product:
    builtins.isAttrs product
    &&
      builtins.attrNames product == (
        pkgs.lib.optional (product ? cargoWorkspaceRoot) "cargoWorkspaceRoot"
        ++ [
          "kind"
          "name"
          "outputName"
          "sourcePaths"
          "target"
          "version"
        ]
      )
    && product.kind == "native"
    && builtins.isString product.name
    && builtins.match "[A-Za-z0-9][A-Za-z0-9._+-]*" product.name != null
    && product.outputName == "artifact.tar"
    && builtins.isString product.target
    &&
      builtins.match "effect_utils//packages/@overeng/[A-Za-z0-9._-]+:[A-Za-z0-9._+-]+" product.target
      != null
    && builtins.isString product.version
    && product.version != ""
    && (
      !(product ? cargoWorkspaceRoot)
      || (builtins.isString product.cargoWorkspaceRoot && product.cargoWorkspaceRoot == "rust")
    );
  names = map (product: product.name) inventory.products;
  targets = map (product: product.target) inventory.products;
in
assert
  builtins.attrNames inventory == [
    "products"
    "schema"
    "schemaVersion"
  ]
  && inventory.schema == "effect-utils/buck-native-targets/v1"
  && inventory.schemaVersion == 1
  && builtins.isList inventory.products
  && builtins.all validProduct inventory.products
  && builtins.length names == builtins.length (pkgs.lib.unique names)
  && builtins.length targets == builtins.length (pkgs.lib.unique targets)
  || throw "buck2-products: generated native target inventory is invalid";
builtins.listToAttrs (
  map (product: {
    inherit (product) name;
    value = mkBuckProductFromSource {
      inherit
        capabilities
        pnpmArchives
        product
        repositoryRoot
        rootProjection
        ;
      sourcePaths = product.sourcePaths;
      # producerCommit is deliberately absent: unrelated commits must keep the
      # exact source product and its validated native import substitutable.
      cargoArchives = if product ? cargoWorkspaceRoot then cargoArchives else null;
      importNative = true;
      # The platform TypeScript server is fully static on Linux; Rust CLIs
      # and the Darwin server use the dynamic runtime inspector.
      runtimeKind =
        if product.name == "typescript-api-server" && pkgs.stdenv.hostPlatform.isLinux then
          "elf-static"
        else
          null;
    };
  }) inventory.products
)
