{ pkgs }:
let
  lib = pkgs.lib;
  repositoryRoot = ../.;
  workspaceRoot = repositoryRoot + "/rust";

  sharedFileset = lib.fileset.unions [
    (workspaceRoot + "/Cargo.toml")
    (workspaceRoot + "/Cargo.lock")
    (repositoryRoot + "/rust-toolchain.toml")
    (repositoryRoot + "/nix/buck2-stage0-tools.nix")
    (workspaceRoot + "/buck2-tools/core/Cargo.toml")
    (lib.fileset.fileFilter (file: file.hasExt "rs") (workspaceRoot + "/buck2-tools/core/src"))
  ];
  mkSourceFileset =
    packageRoot:
    lib.fileset.unions [
      sharedFileset
      (packageRoot + "/Cargo.toml")
      (lib.fileset.fileFilter (file: file.hasExt "rs") (packageRoot + "/src"))
    ];
  mkSource =
    packageRoot:
    lib.fileset.toSource {
      root = repositoryRoot;
      fileset = mkSourceFileset packageRoot;
    };

  toolDefinitions = {
    archive-tool = {
      package = "buck2-archive-tool";
      packageRoot = workspaceRoot + "/buck2-tools/archive-tool";
      workspaceMember = "buck2-tools/archive-tool";
    };
    product = {
      package = "buck2-product";
      packageRoot = workspaceRoot + "/buck2-tools/product";
      workspaceMember = "buck2-tools/product";
    };
  };

  mkTool =
    {
      package,
      packageRoot,
      workspaceMember,
      mainProgram ? package,
    }:
    pkgs.rustPlatform.buildRustPackage {
      pname = package;
      version = "0.0.0";
      src = mkSource packageRoot;
      cargoRoot = "rust";
      buildAndTestSubdir = "rust";
      cargoLock.lockFile = workspaceRoot + "/Cargo.lock";
      nativeBuildInputs = [ pkgs.gawk ];
      cargoBuildFlags = [
        "--package"
        package
      ];
      # Cargo parses every workspace member before selecting --package. Narrow
      # this derivation to the shared core and one leaf, preserving fine-grained
      # source invalidation while keeping the root lock as dependency authority.
      postPatch = ''
        awk '
          /^members = \[/ { print "members = [\"buck2-tools/core\", \"${workspaceMember}\"]"; skipping = 1; next }
          skipping && /^\]/ { skipping = 0; next }
          !skipping { print }
        ' rust/Cargo.toml > rust/Cargo.toml.narrow
        mv rust/Cargo.toml.narrow rust/Cargo.toml
      '';
      doCheck = false;
      meta = {
        description = "Nix-realized Buck2 execution capability";
        license = lib.licenses.mit;
        inherit mainProgram;
      };
    };
in
{
  archive-tool = mkTool toolDefinitions.archive-tool;
  source-inputs = lib.mapAttrs (
    _: definition: lib.fileset.toList (mkSourceFileset definition.packageRoot)
  ) toolDefinitions;
  product = mkTool toolDefinitions.product;
}
