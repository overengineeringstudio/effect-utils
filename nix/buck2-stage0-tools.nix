{ pkgs }:
let
  lib = pkgs.lib;
  repositoryRoot = ../.;
  workspaceRoot = repositoryRoot + "/rust";

  inventory = builtins.fromJSON (builtins.readFile ./stage0-cargo/inventory.json);
  sharedRootFiles = [
    (repositoryRoot + "/rust-toolchain.toml")
    (repositoryRoot + "/nix/buck2-stage0-tools.nix")
    (repositoryRoot + "/nix/stage0-cargo/inventory.json")
  ];
  # Coercing a file beneath a flake store root retains that whole root's
  # context. Materialize the bytes instead, so unrelated commits do not change
  # the stage-zero source derivation even when these files are unchanged.
  toolchainFile = pkgs.writeText "rust-toolchain.toml" (
    builtins.readFile (repositoryRoot + "/rust-toolchain.toml")
  );
  recipeFile = pkgs.writeText "buck2-stage0-tools.nix" (builtins.readFile ./buck2-stage0-tools.nix);
  mkCrateFileset =
    packageRoot:
    lib.fileset.unions [
      (packageRoot + "/Cargo.toml")
      (lib.fileset.fileFilter (file: file.hasExt "rs") (packageRoot + "/src"))
    ];
  mkRustFileset =
    definition:
    lib.fileset.unions (map (member: mkCrateFileset (workspaceRoot + "/${member}")) definition.members);
  mkSourceInputs = definition: sharedRootFiles ++ lib.fileset.toList (mkRustFileset definition);
  mkSource =
    definition:
    let
      rustSource = lib.fileset.toSource {
        root = workspaceRoot;
        fileset = mkRustFileset definition;
      };
      manifest = pkgs.writeText "Cargo.toml" definition.manifest;
      lock = pkgs.writeText "Cargo.lock" definition.lock;
    in
    pkgs.runCommand "buck2-stage0-source" { } ''
      mkdir -p "$out/nix"
      cp -R ${rustSource} "$out/rust"
      chmod u+w "$out/rust"
      cp ${manifest} "$out/rust/Cargo.toml"
      cp ${lock} "$out/rust/Cargo.lock"
      cp ${toolchainFile} "$out/rust-toolchain.toml"
      cp ${recipeFile} "$out/nix/buck2-stage0-tools.nix"
    '';

  toolDefinitions = inventory.tools;

  mkTool =
    definition:
    pkgs.rustPlatform.buildRustPackage {
      pname = definition.package;
      version = "0.0.0";
      src = mkSource definition;
      cargoRoot = "rust";
      buildAndTestSubdir = "rust";
      cargoLock.lockFile = pkgs.writeText "Cargo.lock" definition.lock;
      preBuild = ''
        export RUSTFLAGS="''${RUSTFLAGS:+$RUSTFLAGS }--remap-path-prefix=$NIX_BUILD_TOP=/build"
      '';
      cargoBuildFlags = [
        "--package"
        definition.package
      ];
      doCheck = false;
      meta = {
        description = "Nix-realized Buck2 execution capability";
        license = lib.licenses.mit;
        mainProgram = definition.package;
      };
    };
  tools = lib.mapAttrs (_: definition: mkTool definition) toolDefinitions;
in
assert inventory.schema == "effect-utils/stage0-cargo/v1";
tools
// {
  metadata-check = import ./stage0-cargo/check.nix { inherit pkgs tools; };
  source-inputs = lib.mapAttrs (_: definition: mkSourceInputs definition) toolDefinitions;
}
