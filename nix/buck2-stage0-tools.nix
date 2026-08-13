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
  resolverFixedFileset = lib.fileset.unions [
    (workspaceRoot + "/Cargo.toml")
    (workspaceRoot + "/Cargo.lock")
    (repositoryRoot + "/rust-toolchain.toml")
    (repositoryRoot + "/nix/buck2-stage0-tools.nix")
    (repositoryRoot + "/flake.lock")
    (repositoryRoot + "/flake.nix")
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
    closure-tool = {
      package = "buck2-closure-tool";
      packageRoot = workspaceRoot + "/buck2-tools/closure-tool";
      workspaceMember = "buck2-tools/closure-tool";
    };
    package-evidence = {
      package = "buck2-package-evidence";
      packageRoot = workspaceRoot + "/buck2-tools/package-evidence";
      workspaceMember = "buck2-tools/package-evidence";
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
        description = "Nix-realized Buck2 stage-0 execution tool";
        license = lib.licenses.mit;
        inherit mainProgram;
      };
    };
in
{
  # This list is also consumed by the lazy devenv resolver. Keeping source
  # selection here makes the Nix derivations the sole stage-0 input authority.
  semantic-inputs = lib.fileset.toList resolverFixedFileset;
  # The resolver performs this census on every invocation, so files added or
  # removed after devenv evaluation still change the stage-0 fingerprint.
  semantic-input-trees = [ (repositoryRoot + "/rust/buck2-tools") ];
  source-inputs = lib.mapAttrs (
    _: definition: lib.fileset.toList (mkSourceFileset definition.packageRoot)
  ) toolDefinitions;
  closure-tool = mkTool toolDefinitions.closure-tool;
  package-evidence = mkTool toolDefinitions.package-evidence;
}
