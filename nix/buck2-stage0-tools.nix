{ pkgs }:
let
  lib = pkgs.lib;
  repositoryRoot = ../.;
  workspaceRoot = repositoryRoot + "/rust";

  sharedRustFileset = lib.fileset.unions [
    (workspaceRoot + "/Cargo.toml")
    (workspaceRoot + "/Cargo.lock")
    (workspaceRoot + "/buck2-tools/core/Cargo.toml")
    (lib.fileset.fileFilter (file: file.hasExt "rs") (workspaceRoot + "/buck2-tools/core/src"))
  ];
  sharedRootFiles = [
    (repositoryRoot + "/rust-toolchain.toml")
    (repositoryRoot + "/nix/buck2-stage0-tools.nix")
  ];
  mkRustFileset =
    packageRoot:
    lib.fileset.unions [
      sharedRustFileset
      (packageRoot + "/Cargo.toml")
      (lib.fileset.fileFilter (file: file.hasExt "rs") (packageRoot + "/src"))
    ];
  mkSourceInputs = packageRoot: sharedRootFiles ++ lib.fileset.toList (mkRustFileset packageRoot);
  mkSource =
    packageRoot:
    let
      rustSource = lib.fileset.toSource {
        root = workspaceRoot;
        fileset = mkRustFileset packageRoot;
      };
    in
    pkgs.runCommand "buck2-stage0-source" { } ''
      mkdir -p "$out/nix"
      cp -R ${rustSource} "$out/rust"
      cp ${repositoryRoot + "/rust-toolchain.toml"} "$out/rust-toolchain.toml"
      cp ${repositoryRoot + "/nix/buck2-stage0-tools.nix"} "$out/nix/buck2-stage0-tools.nix"
    '';

  toolDefinitions = {
    archive-tool = {
      package = "buck2-archive-tool";
      packageRoot = workspaceRoot + "/buck2-tools/archive-tool";
      workspaceMember = "buck2-tools/archive-tool";
    };
    events = {
      package = "buck2-events";
      packageRoot = workspaceRoot + "/buck2-tools/events";
      workspaceMember = "buck2-tools/events";
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
  events = mkTool toolDefinitions.events;
  source-inputs = lib.mapAttrs (_: definition: mkSourceInputs definition.packageRoot) toolDefinitions;
  product = mkTool toolDefinitions.product;
}
