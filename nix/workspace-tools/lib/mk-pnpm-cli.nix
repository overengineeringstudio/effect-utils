# Build CLI binaries using pnpm + bun compile.
#
# This builder uses nixpkgs' fetchPnpmDeps for deterministic, reproducible
# dependency fetching. Unlike the legacy approach, dependency hashes remain
# stable across source changes (only lockfile changes require hash updates).
#
# Design:
# - Uses fetchPnpmDeps (not our custom bun-deps.nix)
# - Each package has its own pnpm-workspace.yaml listing its workspace members
# - The package's pnpm-lock.yaml contains deps for all workspace members
# - Single fetchPnpmDeps + single pnpm install handles everything
# - Handles `patchedDependencies` by including patches directory in filtered source
#
# Arguments:
# - name: Derivation name and default binary name.
# - entry: CLI entry file relative to workspaceRoot.
# - packageDir: Package directory relative to workspaceRoot.
# - workspaceRoot: Workspace root (flake input or path).
# - pnpmDepsHash: Hash for package's pnpm deps (includes all workspace members).
# - patchesDir: Patches directory relative to workspaceRoot (null to disable).
# - binaryName: Output binary name (defaults to name).
# - gitRev: Git short revision (defaults to "unknown").
# - commitTs: Git commit timestamp in seconds (defaults to 0).
# - dirty: Whether build includes uncommitted changes (defaults to false).
# - smokeTestArgs: Args for smoke test (defaults to ["--help"]).
# - extraExcludedSourceNames: Extra top-level paths to omit from the staged workspace.

{ pkgs }:

{
  name,
  entry,
  packageDir,
  workspaceRoot,
  pnpmDepsHash,
  patchesDir ? "patches",
  binaryName ? name,
  gitRev ? "unknown",
  commitTs ? 0,
  dirty ? false,
  smokeTestArgs ? [ "--help" ],
  extraExcludedSourceNames ? [],
}:

let
  lib = pkgs.lib;

  # Convert workspaceRoot to path
  workspaceRootPath =
    if builtins.isAttrs workspaceRoot && builtins.hasAttr "outPath" workspaceRoot
    then workspaceRoot.outPath
    else if builtins.isPath workspaceRoot
    then workspaceRoot
    else builtins.toPath workspaceRoot;

  # Create filtered source for fetching pnpm deps
  # ONLY includes the main package - workspace members are excluded to avoid
  # pnpm trying to create node_modules in read-only sibling directories
  mkPackageSource = pkgDir:
    lib.cleanSourceWith {
      src = workspaceRootPath;
      filter = path: type:
        let
          relPath = lib.removePrefix (toString workspaceRootPath + "/") (toString path);
          # Only include the main package directory
          isInPackage = lib.hasPrefix "${pkgDir}/" relPath || relPath == pkgDir;
          # Include parent directories needed for structure
          parts = lib.splitString "/" pkgDir;
          isParentDir = lib.any (n: relPath == lib.concatStringsSep "/" (lib.take n parts)) (lib.range 1 (lib.length parts));
          # Check if path is under patches directory
          isInPatches = patchesDir != null && (lib.hasPrefix "${patchesDir}/" relPath || relPath == patchesDir);
        in
        type == "directory" || isInPackage || isInPatches || isParentDir;
    };

  # Fetch pnpm deps - single call since lockfile includes all workspace members
  # Source only includes main package, so pnpm can't try to write to sibling dirs
  # This fetches ALL deps from lockfile (including workspace member deps)
  pnpmDeps = pkgs.fetchPnpmDeps {
    pname = "${name}-pnpm-deps";
    src = mkPackageSource packageDir;
    sourceRoot = "source/${packageDir}";
    hash = pnpmDepsHash;
    # fetcherVersion 3 is for pnpm 9.x/10.x
    fetcherVersion = 3;
  };

  # Full workspace source for building
  workspaceSrc = lib.cleanSourceWith {
    src = workspaceRootPath;
    filter = path: type:
      let
        baseName = baseNameOf path;
      in
      # Exclude common non-essential directories
      lib.cleanSourceFilter path type &&
      !(lib.elem baseName ([
        ".git" ".direnv" ".devenv" ".cache" ".turbo" ".next" ".bun"
        "node_modules" "dist" "result" "coverage" "tmp" "out"
      ] ++ extraExcludedSourceNames));
  };

  # Read package.json for version
  packageJsonPath = workspaceRootPath + "/${packageDir}/package.json";
  packageJson = builtins.fromJSON (builtins.readFile packageJsonPath);
  packageVersion = packageJson.version or "0.0.0";

  # Build NixStamp JSON for embedding in binary
  # Note: We manually construct the JSON to avoid escaping issues with builtins.toJSON
  # when the string is interpolated into shell scripts and substituteInPlace.
  dirtyStr = if dirty then "true" else "false";
  nixStampJson = ''{\"type\":\"nix\",\"version\":\"${packageVersion}\",\"rev\":\"${gitRev}\",\"commitTs\":${toString commitTs},\"dirty\":${dirtyStr}}'';

  smokeTestArgsStr = lib.escapeShellArgs smokeTestArgs;

in
pkgs.stdenv.mkDerivation {
  inherit name;

  nativeBuildInputs = [
    pkgs.pnpm
    pkgs.nodejs
    pkgs.bun
    pkgs.cacert
    pkgs.zstd
  ];

  inherit pnpmDeps;

  dontUnpack = true;
  dontFixup = true;

  buildPhase = ''
    set -euo pipefail
    runHook preBuild

    export HOME=$PWD
    export STORE_PATH=$(mktemp -d)

    # Extract pnpm store
    echo "Extracting pnpm store..."
    zstd -d -c ${pnpmDeps}/pnpm-store.tar.zst | tar -xf - -C $STORE_PATH
    chmod -R +w $STORE_PATH

    # Configure pnpm
    pnpm config set store-dir "$STORE_PATH"
    pnpm config set package-import-method clone-or-copy
    pnpm config set manage-package-manager-versions false

    # Copy workspace source
    echo "Copying workspace source..."
    cp -r ${workspaceSrc} workspace
    chmod -R +w workspace
    cd workspace

    # Install deps for main package and all workspace members recursively
    echo "Installing package deps..."
    cd ${packageDir}
    pnpm install --offline --frozen-lockfile --ignore-scripts --recursive
    patchShebangs .
    cd -

    # Inject build stamp
    if [ -f "${entry}" ]; then
      substituteInPlace "${entry}" \
        --replace-quiet "const buildStamp = '__CLI_BUILD_STAMP__'" "const buildStamp = '${nixStampJson}'"
    fi

    # Build the CLI
    echo "Building CLI..."
    mkdir -p ${packageDir}/output
    bun build ${entry} --compile --outfile=${packageDir}/output/${binaryName}

    # Smoke test
    if [ -n "${smokeTestArgsStr}" ]; then
      echo "Running smoke test..."
      ./${packageDir}/output/${binaryName} ${smokeTestArgsStr}
    fi

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin
    # We're still in workspace/ from buildPhase
    cp ${packageDir}/output/${binaryName} $out/bin/

    runHook postInstall
  '';
}
