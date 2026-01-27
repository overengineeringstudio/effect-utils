# Build CLI binaries using pnpm + bun compile.
#
# This builder uses nixpkgs' fetchPnpmDeps for deterministic, reproducible
# dependency fetching. Unlike the legacy approach, dependency hashes remain
# stable across source changes (only lockfile changes require hash updates).
#
# Design:
# - Uses fetchPnpmDeps (not our custom bun-deps.nix)
# - Handles per-package lockfiles (not pnpm workspaces)
# - Handles local `link:` dependencies by fetching deps for each and combining stores
# - Handles `patchedDependencies` by including patches directory in filtered source
# - Uses `rsync` to merge multiple pnpm stores (content-addressed = duplicates are identical)
#
# Arguments:
# - name: Derivation name and default binary name.
# - entry: CLI entry file relative to workspaceRoot.
# - packageDir: Package directory relative to workspaceRoot.
# - workspaceRoot: Workspace root (flake input or path).
# - pnpmDepsHash: Hash for main package's pnpm deps.
# - localDeps: List of { dir, hash } for local link: dependencies.
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
  localDeps ? [],
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

  # Create filtered source for a package that includes:
  # - The package itself
  # - The patches directory (if it exists and patchesDir is set)
  # This preserves directory structure so relative patch paths work
  mkPackageSource = pkgDir:
    lib.cleanSourceWith {
      src = workspaceRootPath;
      filter = path: type:
        let
          relPath = lib.removePrefix (toString workspaceRootPath + "/") (toString path);
          # Check if path is under the package directory
          isInPackage = lib.hasPrefix "${pkgDir}/" relPath || relPath == pkgDir;
          # Check if path is under patches directory
          isInPatches = patchesDir != null && (lib.hasPrefix "${patchesDir}/" relPath || relPath == patchesDir);
          # Include parent directories needed for structure
          parts = lib.splitString "/" pkgDir;
          isParentDir = lib.any (n: relPath == lib.concatStringsSep "/" (lib.take n parts)) (lib.range 1 (lib.length parts));
        in
        type == "directory" || isInPackage || isInPatches || isParentDir;
    };

  # Fetch pnpm deps for a single package
  mkPnpmDeps = { dir, hash }:
    pkgs.fetchPnpmDeps {
      pname = "${name}-${builtins.replaceStrings ["/"] ["-"] dir}";
      src = mkPackageSource dir;
      sourceRoot = "source/${dir}";
      inherit hash;
      # fetcherVersion 3 is for pnpm 9.x/10.x
      fetcherVersion = 3;
    };

  # Main package deps
  mainDeps = mkPnpmDeps { dir = packageDir; hash = pnpmDepsHash; };

  # Local dependency deps
  localDepsList = map mkPnpmDeps localDeps;

  # Combine all pnpm stores into one
  # Since pnpm stores are content-addressed, duplicates are identical
  # We use rsync to merge (handles duplicates gracefully)
  combinedDeps = if localDeps == []
    then mainDeps
    else pkgs.runCommand "${name}-combined-pnpm-deps" {
      nativeBuildInputs = [ pkgs.zstd pkgs.rsync ];
    } ''
      mkdir -p $out
      STORE=$(mktemp -d)

      # Extract and merge all stores
      # Use rsync to handle duplicates gracefully (content-addressed = identical files)
      ${lib.concatMapStringsSep "\n" (deps: ''
        echo "Extracting ${deps.name}..."
        TEMP_EXTRACT=$(mktemp -d)
        zstd -d -c ${deps}/pnpm-store.tar.zst | tar -xf - -C $TEMP_EXTRACT
        chmod -R +w $TEMP_EXTRACT
        rsync -a $TEMP_EXTRACT/ $STORE/
        rm -rf $TEMP_EXTRACT
      '') ([mainDeps] ++ localDepsList)}

      echo "Combined store has $(find $STORE -type f | wc -l) files"

      # Create combined tarball
      echo "Creating combined store tarball..."
      tar --sort=name \
        --mtime="@$SOURCE_DATE_EPOCH" \
        --owner=0 --group=0 --numeric-owner \
        --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
        --zstd -cf $out/pnpm-store.tar.zst -C $STORE .
    '';

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
  nixStampJson = builtins.toJSON {
    type = "nix";
    version = packageVersion;
    rev = gitRev;
    commitTs = commitTs;
    dirty = dirty;
  };

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

  pnpmDeps = combinedDeps;

  dontUnpack = true;
  dontFixup = true;

  buildPhase = ''
    set -euo pipefail
    runHook preBuild

    export HOME=$PWD
    export STORE_PATH=$(mktemp -d)

    # Extract pnpm store
    echo "Extracting pnpm store..."
    zstd -d -c ${combinedDeps}/pnpm-store.tar.zst | tar -xf - -C $STORE_PATH
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

    # Install deps for main package
    echo "Installing main package deps..."
    cd ${packageDir}
    pnpm install --offline --frozen-lockfile --ignore-scripts
    patchShebangs node_modules
    cd -

    # Install deps for local dependencies
    ${lib.concatMapStringsSep "\n" (dep: ''
      echo "Installing deps for ${dep.dir}..."
      cd ${dep.dir}
      pnpm install --offline --frozen-lockfile --ignore-scripts
      patchShebangs node_modules
      cd -
    '') localDeps}

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
