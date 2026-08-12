{ pkgs }:
let
  lib = pkgs.lib;
  repositoryRoot = ../.;
  workspaceRoot = repositoryRoot + "/rust";
  workspace = builtins.fromTOML (builtins.readFile (workspaceRoot + "/Cargo.toml"));
  memberManifests = map (member: workspaceRoot + "/${member}/Cargo.toml") workspace.workspace.members;

  mkSource =
    packageRoot:
    lib.fileset.toSource {
      root = repositoryRoot;
      fileset = lib.fileset.unions (
        [
          (workspaceRoot + "/Cargo.toml")
          (workspaceRoot + "/Cargo.lock")
          (repositoryRoot + "/rust-toolchain.toml")
          (lib.fileset.fileFilter (file: file.hasExt "rs") (packageRoot + "/src"))
          (lib.fileset.fileFilter (file: file.hasExt "rs") (workspaceRoot + "/buck2-tools/core/src"))
        ]
        ++ memberManifests
      );
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
  closure-tool = mkTool {
    package = "buck2-closure-tool";
    packageRoot = workspaceRoot + "/buck2-tools/closure-tool";
    workspaceMember = "buck2-tools/closure-tool";
  };
  package-evidence = mkTool {
    package = "buck2-package-evidence";
    packageRoot = workspaceRoot + "/buck2-tools/package-evidence";
    workspaceMember = "buck2-tools/package-evidence";
  };
  portable-toolchain = mkTool {
    package = "buck2-portable-toolchain";
    packageRoot = workspaceRoot + "/buck2-tools/portable-toolchain";
    workspaceMember = "buck2-tools/portable-toolchain";
  };
  portable-toolchain-fixture = mkTool {
    package = "buck2-portable-toolchain-fixture";
    packageRoot = workspaceRoot + "/buck2-tools/portable-toolchain-fixture";
    workspaceMember = "buck2-tools/portable-toolchain-fixture";
  };
}
