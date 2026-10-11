{ pkgs }:
let
  lib = pkgs.lib;
  repositoryRoot = ../.;
  workspaceRoot = repositoryRoot + "/rust";

  sharedRustFileset = lib.fileset.unions [
    (workspaceRoot + "/Cargo.toml")
    (workspaceRoot + "/Cargo.lock")
  ];
  sharedRootFiles = [
    (repositoryRoot + "/rust-toolchain.toml")
    (repositoryRoot + "/nix/buck2-stage0-tools.nix")
  ];
  # Coercing a file beneath a flake store root retains that whole root's
  # context. Materialize the bytes instead, so unrelated commits do not change
  # the stage-zero source derivation even when these files are unchanged.
  toolchainFile = pkgs.writeText "rust-toolchain.toml" (
    builtins.readFile (repositoryRoot + "/rust-toolchain.toml")
  );
  recipeFile = pkgs.writeText "buck2-stage0-tools.nix" (builtins.readFile ./buck2-stage0-tools.nix);
  mkCrateFileset = packageRoot: lib.fileset.unions [
    (packageRoot + "/Cargo.toml")
    (lib.fileset.fileFilter (file: file.hasExt "rs") (packageRoot + "/src"))
  ];
  mkRustFileset = definition: lib.fileset.unions (
    [ sharedRustFileset ]
    ++ map mkCrateFileset ([ definition.packageRoot ] ++ definition.dependencyRoots)
  );
  mkSourceInputs = definition: sharedRootFiles ++ lib.fileset.toList (mkRustFileset definition);
  mkSource =
    definition:
    let
      rustSource = lib.fileset.toSource {
        root = workspaceRoot;
        fileset = mkRustFileset definition;
      };
    in
    pkgs.runCommand "buck2-stage0-source" { } ''
      mkdir -p "$out/nix"
      cp -R ${rustSource} "$out/rust"
      cp ${toolchainFile} "$out/rust-toolchain.toml"
      cp ${recipeFile} "$out/nix/buck2-stage0-tools.nix"
    '';

  toolDefinitions = {
    fingerprint = {
      package = "buck2-fingerprint";
      packageRoot = workspaceRoot + "/buck2-tools/fingerprint";
      workspaceMember = "buck2-tools/fingerprint";
      dependencyRoots = [ ];
    };
    archive-tool = {
      package = "buck2-archive-tool";
      packageRoot = workspaceRoot + "/buck2-tools/archive-tool";
      workspaceMember = "buck2-tools/archive-tool";
      dependencyRoots = [ (workspaceRoot + "/buck2-tools/core") ];
    };
    events = {
      package = "buck2-events";
      packageRoot = workspaceRoot + "/buck2-tools/events";
      workspaceMember = "buck2-tools/events";
      dependencyRoots = [ ];
    };
    product = {
      package = "buck2-product";
      packageRoot = workspaceRoot + "/buck2-tools/product";
      workspaceMember = "buck2-tools/product";
      dependencyRoots = [ (workspaceRoot + "/buck2-tools/core") ];
    };
  };

  mkTool =
    {
      package,
      packageRoot,
      workspaceMember,
      dependencyRoots,
      mainProgram ? package,
    }:
    pkgs.rustPlatform.buildRustPackage {
      pname = package;
      version = "0.0.0";
      src = mkSource { inherit packageRoot dependencyRoots; };
      cargoRoot = "rust";
      buildAndTestSubdir = "rust";
      cargoLock.lockFile = workspaceRoot + "/Cargo.lock";
      nativeBuildInputs = [ pkgs.gawk ];
      preBuild = ''
        export RUSTFLAGS="''${RUSTFLAGS:+$RUSTFLAGS }--remap-path-prefix=$NIX_BUILD_TOP=/build"
      '';
      cargoBuildFlags = [
        "--package"
        package
      ];
      # Cargo parses every workspace member before selecting --package. Keep
      # only this crate and its actual path dependencies, with the root lock
      # remaining the dependency authority.
      postPatch = ''
        awk -v members='${builtins.toJSON ([ workspaceMember ] ++ map (root: lib.removePrefix "${toString workspaceRoot}/" (toString root)) dependencyRoots)}' '
          /^members = \[/ { print "members = " members; skipping = 1; next }
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
  fingerprint = mkTool toolDefinitions.fingerprint;
  product = mkTool toolDefinitions.product;
  source-inputs = lib.mapAttrs (_: definition: mkSourceInputs definition) toolDefinitions;
}
