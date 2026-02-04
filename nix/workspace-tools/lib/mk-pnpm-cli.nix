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
# - Workspace members are automatically parsed from pnpm-workspace.yaml (no manual list needed)
#
# Arguments:
# - name: Derivation name and default binary name.
# - entry: CLI entry file relative to workspaceRoot.
# - packageDir: Package directory relative to workspaceRoot.
# - workspaceRoot: Workspace root (flake input or path).
# - pnpmDepsHash: Hash for package's pnpm deps (includes all workspace members).
# - lockfileHash: SHA256 of lockfile for staleness check (optional, enables early validation).
# - packageJsonDepsHash: SHA256 of package.json deps fields for fingerprinting (optional).
#                        Not used by the builder itself; accepted for API compatibility.
#                        Used externally by nix:check:quick to detect package.json changes
#                        without lockfile update (e.g., forgetting to run `pnpm install`).
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
  lockfileHash ? null,
  packageJsonDepsHash ? null,
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

  # ==========================================================================
  # Parse workspace members from pnpm-workspace.yaml
  # ==========================================================================
  # Automatically extracts workspace members from pnpm-workspace.yaml instead of
  # requiring manual specification. Handles the YAML flow syntax format:
  #   packages: [., ../tui-core, ../tui-react]
  # And resolves relative paths to workspace-root-relative paths.

  pnpmWorkspaceYamlPath = workspaceRootPath + "/${packageDir}/pnpm-workspace.yaml";
  pnpmWorkspaceYaml = builtins.readFile pnpmWorkspaceYamlPath;

  # Extract "packages: [...]" line
  workspaceLines = lib.splitString "\n" pnpmWorkspaceYaml;
  packagesLine = lib.findFirst (line: lib.hasPrefix "packages:" line) null workspaceLines;

  # Parse the array: "packages: [., ../foo, ../bar]" -> [".", "../foo", "../bar"]
  packagesArrayStr = lib.removePrefix "packages: " packagesLine;
  packagesInner = lib.removeSuffix "]" (lib.removePrefix "[" packagesArrayStr);
  packagesItems = map (s: lib.trim s) (lib.splitString "," packagesInner);

  # Filter out "." (main package itself)
  relativeWorkspaceMembers = builtins.filter (s: s != ".") packagesItems;

  # Resolve relative paths (e.g., "../tui-core") to workspace-root paths (e.g., "packages/@overeng/tui-core")
  resolveRelativePath = basePath: relPath:
    let
      baseParts = lib.splitString "/" basePath;
      relParts = lib.splitString "/" relPath;

      # Count leading ".." segments
      countResult = builtins.foldl'
        (acc: part:
          if acc.done then acc
          else if part == ".." then { count = acc.count + 1; done = false; }
          else { count = acc.count; done = true; }
        )
        { count = 0; done = false; }
        relParts;
      upCount = countResult.count;

      # Get remaining path parts after ".."
      remainingParts = lib.drop upCount relParts;

      # Go up from base path and append remaining
      resolvedBase = lib.take (lib.length baseParts - upCount) baseParts;
    in
    lib.concatStringsSep "/" (resolvedBase ++ remainingParts);

  # Final workspace members list (workspace-root-relative paths)
  workspaceMembers = map (relPath: resolveRelativePath packageDir relPath) relativeWorkspaceMembers;

  # Create filtered source for fetching pnpm deps
  # Includes the main package and ONLY package.json files from workspace members
  # (not full directories) to let pnpm know what deps to fetch without trying
  # to create node_modules in read-only sibling directories
  mkPackageSource = pkgDir:
    lib.cleanSourceWith {
      src = workspaceRootPath;
      filter = path: type:
        let
          relPath = lib.removePrefix (toString workspaceRootPath + "/") (toString path);
          # Include everything under the main package directory
          isInPackage = lib.hasPrefix "${pkgDir}/" relPath || relPath == pkgDir;
          # Include parent directories needed for structure
          parts = lib.splitString "/" pkgDir;
          isParentDir = lib.any (n: relPath == lib.concatStringsSep "/" (lib.take n parts)) (lib.range 1 (lib.length parts));
          # Check if path is under patches directory
          isInPatches = patchesDir != null && (lib.hasPrefix "${patchesDir}/" relPath || relPath == patchesDir);
          # Include workspace member package.json files (not full directories)
          # Also include their parent directories as directories
          isWorkspaceMemberPackageJson = lib.any (memberDir:
            relPath == "${memberDir}/package.json"
          ) workspaceMembers;
          isWorkspaceMemberDir = type == "directory" && lib.any (memberDir:
            relPath == memberDir
          ) workspaceMembers;
          isWorkspaceMemberParentDir = type == "directory" && lib.any (memberDir:
            let memberParts = lib.splitString "/" memberDir;
            in lib.any (n: relPath == lib.concatStringsSep "/" (lib.take n memberParts)) (lib.range 1 (lib.length memberParts - 1))
          ) workspaceMembers;
        in
        type == "directory" || isInPackage || isInPatches || isParentDir ||
        isWorkspaceMemberPackageJson || isWorkspaceMemberDir || isWorkspaceMemberParentDir;
    };

  # Custom pnpm deps fetcher that handles workspace members
  # Standard fetchPnpmDeps fails because workspace member directories are read-only
  # and pnpm tries to create node_modules in them. This fetcher makes the source
  # writable before running pnpm install.
  pnpmDeps = pkgs.stdenvNoCC.mkDerivation {
    pname = "${name}-pnpm-deps";
    version = "0.0.0";

    src = mkPackageSource packageDir;
    sourceRoot = "source/${packageDir}";

    nativeBuildInputs = [
      pkgs.pnpm
      pkgs.nodejs
      pkgs.cacert
      pkgs.zstd
      pkgs.findutils
      pkgs.perl
    ];

    dontConfigure = true;
    dontBuild = true;

    installPhase = ''
      runHook preInstall

      # Make the entire source tree writable (critical for workspace members)
      cd "$NIX_BUILD_TOP/source"
      chmod -R +w .
      cd "$NIX_BUILD_TOP/source/${packageDir}"

      export HOME=$PWD
      export STORE_PATH=$PWD/.pnpm-store

      # Configure pnpm
      pnpm config set store-dir "$STORE_PATH"
      pnpm config set manage-package-manager-versions false
      ${pnpmSupportedArchitecturesScript}

      # Install with network access - this downloads all deps to the store
      # Use --force to skip workspace member validation since we only have package.json files
      pnpm install --frozen-lockfile --ignore-scripts --force

      # Normalize pnpm store metadata (checkedAt timestamps are non-deterministic)
      for indexDir in "$STORE_PATH"/v*/index; do
        if [ -d "$indexDir" ]; then
          find "$indexDir" -type f -name "*.json" -print0 \
            | xargs -0 perl -pi -e 's/"checkedAt":[0-9]+/"checkedAt":0/g'
        fi
      done

      # Create output directory
      mkdir -p $out

      # Archive the pnpm store
      cd $STORE_PATH
      LC_ALL=C TZ=UTC tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -cf - . \
        | zstd -T1 -q -o $out/pnpm-store.tar.zst

      runHook postInstall
    '';

    outputHashMode = "recursive";
    outputHash = pnpmDepsHash;
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
  supportedArchitecturesJson = ''{"os":["linux","darwin"],"cpu":["x64","arm64"]}'';
  pnpmSupportedArchitecturesScript = ''
    # Ensure pnpm resolves binaries for all supported platforms (R5 determinism)
    pnpm config set supportedArchitectures '${supportedArchitecturesJson}'
    sa="$(pnpm config get supportedArchitectures)"
    # pnpm config get returns array notation (os[]=linux) not JSON, so check without quotes
    if ! printf '%s' "$sa" | grep -q 'linux' ||
       ! printf '%s' "$sa" | grep -q 'darwin' ||
       ! printf '%s' "$sa" | grep -q 'x64' ||
       ! printf '%s' "$sa" | grep -q 'arm64'; then
      echo "error: pnpm supportedArchitectures not set as expected"
      echo "  got: $sa"
      exit 1
    fi
  '';

in
pkgs.stdenv.mkDerivation {
  inherit name;

  nativeBuildInputs = [
    pkgs.pnpm
    pkgs.nodejs
    pkgs.bun
    pkgs.cacert
    pkgs.zstd
  ] ++ lib.optionals (lockfileHash != null) [ pkgs.nix ];

  inherit pnpmDeps;

  dontUnpack = true;
  dontFixup = true;

  buildPhase = ''
    set -euo pipefail
    runHook preBuild

    ${if lockfileHash != null then ''
    # Validate lockfile hash (early failure with clear message)
    currentHash="sha256-$(nix-hash --type sha256 --base64 ${workspaceSrc}/${packageDir}/pnpm-lock.yaml)"
    if [ "$currentHash" != "${lockfileHash}" ]; then
      echo ""
      echo "error: lockfileHash is stale (run: dt nix:hash)"
      echo "  expected: ${lockfileHash}"
      echo "  actual:   $currentHash"
      echo ""
      exit 1
    fi
    '' else ""}

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
    ${pnpmSupportedArchitecturesScript}

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
