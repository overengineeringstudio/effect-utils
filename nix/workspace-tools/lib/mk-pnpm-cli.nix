# Build CLI binaries using pnpm + bun compile.
#
# This builder stages a dedicated workspace closure for the target package,
# restores a pnpm store from a fixed-output derivation, deploys the package from
# that closure into an isolated directory, and finally compiles the deployed
# entrypoint with Bun.
#
# Design:
# - Dependency fetching stays store-based and deterministic via mk-pnpm-deps.nix
# - The build phase stages only the target package and its workspace closure
# - `pnpm deploy` materializes an isolated node_modules tree for the target
# - The final Bun build runs from the deployed output, not from a raw recursive
#   workspace install
# - Handles `patchedDependencies` by including patches directories in the staged closure
# - Workspace members are automatically parsed from pnpm-workspace.yaml (no manual list needed)
#
# Arguments:
# - name: Derivation name and default binary name.
# - entry: CLI entry file relative to workspaceRoot.
# - packageDir: Package directory relative to workspaceRoot.
# - workspaceRoot: Workspace root (flake input or path).
# - pnpmDepsHash: Hash for the staged pnpm dependency fetch input.
# - lockfileHash: SHA256 of lockfile for staleness check (optional, enables early validation).
# - patchesDir: Patches directory relative to workspaceRoot (null to disable).
# - binaryName: Output binary name (defaults to name).
# - gitRev: Git short revision (defaults to "unknown").
# - commitTs: Git commit timestamp in seconds (defaults to 0).
# - dirty: Whether build includes uncommitted changes (defaults to false).
# - smokeTestArgs: Args for smoke test (defaults to ["--help"]).
# - extraExcludedSourceNames: Extra top-level paths to omit from the staged workspace.
# - extraBunBuildArgs: Extra arguments passed to `bun build` (e.g., --external flags).

{ pkgs }:

{
  name,
  entry,
  packageDir,
  workspaceRoot,
  pnpmDepsHash,
  lockfileHash ? null,
  patchesDir ? "patches",
  binaryName ? name,
  gitRev ? "unknown",
  commitTs ? 0,
  dirty ? false,
  smokeTestArgs ? [ "--help" ],
  extraExcludedSourceNames ? [ ],
  extraBunBuildArgs ? [ ],
}:

let
  lib = pkgs.lib;

  # Convert workspaceRoot to path
  workspaceRootPath =
    if builtins.isAttrs workspaceRoot && builtins.hasAttr "outPath" workspaceRoot then
      workspaceRoot.outPath
    else if builtins.isPath workspaceRoot then
      workspaceRoot
    else
      builtins.toPath workspaceRoot;

  # ==========================================================================
  # Parse workspace members from pnpm-workspace.yaml
  # ==========================================================================
  # Automatically extracts workspace members from pnpm-workspace.yaml.
  # Handles three YAML array formats:
  #   1. Single-line flow:    packages: [., ../tui-core, ../tui-react]
  #   2. Multi-line bracket:  packages:\n  [\n    .,\n    ../tui-core,\n  ]
  #   3. Block/dash:          packages:\n  - .\n  - ../tui-core
  # Resolves relative paths to workspace-root-relative paths.

  pnpmWorkspaceYamlPath = workspaceRootPath + "/${packageDir}/pnpm-workspace.yaml";
  pnpmWorkspaceYaml = builtins.readFile pnpmWorkspaceYamlPath;

  # Extract "packages: [...]" line
  workspaceLines = lib.splitString "\n" pnpmWorkspaceYaml;
  packagesLine = lib.findFirst (line: lib.hasPrefix "packages:" line) null workspaceLines;

  # Detect format from the "packages:" line content
  packagesLineTrimmed = if packagesLine == null then "" else lib.trim packagesLine;
  isPackagesInline = packagesLine != null && lib.hasPrefix "packages: [" packagesLineTrimmed;

  # Single-line flow: "packages: [., ../foo, ../bar]"
  parsePackagesInline =
    let
      packagesArrayStr = lib.removePrefix "packages: " packagesLine;
      packagesInner = lib.removeSuffix "]" (lib.removePrefix "[" packagesArrayStr);
    in
    map (s: lib.trim s) (lib.splitString "," packagesInner);

  # Collect indented lines after "packages:" header
  workspaceLinesAfterPackagesHeader =
    let
      dropUntilPackagesHeader =
        lines:
        if lines == [ ] then
          [ ]
        else if lib.hasPrefix "packages:" (lib.trim (builtins.head lines)) then
          lib.tail lines
        else
          dropUntilPackagesHeader (lib.tail lines);
    in
    dropUntilPackagesHeader workspaceLines;

  # Multi-line formats (block/dash or multi-line bracket)
  parsePackagesMultiline =
    let
      lines = workspaceLinesAfterPackagesHeader;
      # Check format by looking at the first non-empty indented line
      firstContentLine = lib.findFirst (line: lib.trim line != "") "" lines;
      isBracketFormat = lib.hasInfix "[" firstContentLine;
    in
    if isBracketFormat then
      # Multi-line bracket: "packages:\n  [\n    .,\n    ../foo,\n  ]"
      let
        # Only take indented lines (belonging to the packages block)
        takeWhile = pred: lst:
          if lst == [] then []
          else if pred (builtins.head lst) then [ (builtins.head lst) ] ++ takeWhile pred (lib.tail lst)
          else [];
        indentedLines = takeWhile (line: lib.hasPrefix " " line || line == "") lines;
        joined = builtins.concatStringsSep "\n" indentedLines;
        # Extract everything between [ and ]
        afterOpen = builtins.elemAt (lib.splitString "[" joined) 1;
        inner = builtins.elemAt (lib.splitString "]" afterOpen) 0;
        items = lib.splitString "," inner;
      in
      builtins.filter (s: s != "") (map (s: lib.trim (lib.removeSuffix "," (lib.trim s))) items)
    else
      # Block/dash: "packages:\n  - .\n  - ../foo"
      let
        parseLines =
          remainingLines:
          if remainingLines == [ ] then
            [ ]
          else
            let
              line = lib.trim (builtins.head remainingLines);
              rest = lib.tail remainingLines;
            in
              if line == "" || lib.hasPrefix "#" line then
                parseLines rest
              else if lib.hasPrefix "- " line then
                [ lib.trim (lib.removePrefix "- " line) ] ++ parseLines rest
              else if lib.hasPrefix "-" line then
                [ lib.trim (lib.removePrefix "-" line) ] ++ parseLines rest
              else
                [ ];
      in
      parseLines lines;

  workspaceMemberItems = builtins.filter builtins.isString (
    if isPackagesInline then parsePackagesInline else parsePackagesMultiline
  );

  # Filter out "." (main package itself)
  relativeWorkspaceMembers = builtins.filter (s: s != ".") workspaceMemberItems;

  # Resolve relative paths (e.g., "../tui-core") to workspace-root paths (e.g., "packages/@overeng/tui-core")
  resolveRelativePath =
    basePath: relPath:
    let
      baseParts = lib.splitString "/" basePath;
      relParts = lib.splitString "/" relPath;

      # Count leading ".." segments
      countResult =
        builtins.foldl'
          (
            acc: part:
            if acc.done then
              acc
            else if part == ".." then
              {
                count = acc.count + 1;
                done = false;
              }
            else
              {
                count = acc.count;
                done = true;
              }
          )
          {
            count = 0;
            done = false;
          }
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
  workspaceClosureDirs = [ packageDir ] ++ workspaceMembers;

  parentDirsFor =
    dir:
    let
      parts = lib.splitString "/" dir;
    in
    map (n: lib.concatStringsSep "/" (lib.take n parts)) (lib.range 1 (lib.length parts));

  # Create filtered source for fetching pnpm deps.
  # This keeps the staged fetch input limited to the target lockfile, the
  # target package manifest/workspace config, workspace member manifests, and
  # any referenced patch files.
  mkPackageSource =
    pkgDir:
    lib.cleanSourceWith {
      src = workspaceRootPath;
      filter =
        path: type:
        let
          relPath = lib.removePrefix (toString workspaceRootPath + "/") (toString path);
          baseName = baseNameOf path;
          excludedNames = [
            ".git"
            ".direnv"
            ".devenv"
            ".cache"
            ".turbo"
            ".next"
            ".bun"
            "node_modules"
            "dist"
            "result"
            "coverage"
            "tmp"
            "out"
          ];
          isExcluded = lib.elem baseName excludedNames;
          # For deps fetching, only include deps-relevant files from the main package
          # (source files are only needed in workspaceSrc for the build phase)
          depsRelevantFiles = [ "pnpm-lock.yaml" "package.json" "pnpm-workspace.yaml" ".npmrc" ];
          isPackageDir = relPath == pkgDir && type == "directory";
          isPackageDepsFile = lib.any (fname: relPath == "${pkgDir}/${fname}") depsRelevantFiles;
          # Include parent directories needed for structure
          parts = lib.splitString "/" pkgDir;
          isParentDir = lib.any (n: relPath == lib.concatStringsSep "/" (lib.take n parts)) (
            lib.range 1 (lib.length parts)
          );
          # Check if path is under patches directory
          isInPatches =
            patchesDir != null
            && (
              # Root-level patches dir
              lib.hasPrefix "${patchesDir}/" relPath
              || relPath == patchesDir
              # Workspace-member patches dirs (`packages/.../patches/...`)
              || lib.any
                (
                  memberDir:
                  lib.hasPrefix "${memberDir}/${patchesDir}/" relPath
                  || relPath == "${memberDir}/${patchesDir}"
                )
                workspaceMembers
            );
          # Include workspace member dependency-relevant files (not full source trees)
          # so package-local lockfiles remain available when a workspace package expects
          # self-contained pnpm installs.
          isWorkspaceMemberDepsFile = lib.any (
            memberDir: lib.any (fname: relPath == "${memberDir}/${fname}") depsRelevantFiles
          ) workspaceMembers;
          isWorkspaceMemberDir =
            type == "directory" && lib.any (memberDir: relPath == memberDir) workspaceMembers;
          isWorkspaceMemberParentDir =
            type == "directory"
            && lib.any (
              memberDir:
              let
                memberParts = lib.splitString "/" memberDir;
              in
              lib.any (n: relPath == lib.concatStringsSep "/" (lib.take n memberParts)) (
                lib.range 1 (lib.length memberParts - 1)
              )
            ) workspaceMembers;
        in
        !isExcluded
        && (
          isPackageDir
          || isPackageDepsFile
          || isInPatches
          || isParentDir
          || isWorkspaceMemberDepsFile
          || isWorkspaceMemberDir
          || isWorkspaceMemberParentDir
        );
    };

  # Fetch pnpm dependencies from the staged lockfile + workspace member manifests.
  pnpmDeps = pnpmDepsHelper.mkDeps {
    inherit name pnpmDepsHash;
    src = mkPackageSource packageDir;
    sourceRoot = "source/${packageDir}";
    # Make the entire source tree writable (critical for workspace members
    # whose directories are read-only in the Nix store)
    preInstall = ''
      cd "$NIX_BUILD_TOP/source"
      chmod -R +w .
      cd "$NIX_BUILD_TOP/source/${packageDir}"
    '';
  };

  # Full workspace source for building
  workspaceClosureSrc = lib.cleanSourceWith {
    src = workspaceRootPath;
    filter =
      path: type:
      let
        relPath = lib.removePrefix (toString workspaceRootPath + "/") (toString path);
        baseName = baseNameOf path;
        isInWorkspaceClosure = lib.any (
          dir: relPath == dir || lib.hasPrefix "${dir}/" relPath
        ) workspaceClosureDirs;
        isWorkspaceClosureParent =
          type == "directory"
          && lib.any (dir: lib.elem relPath (parentDirsFor dir)) workspaceClosureDirs;
        isInPatches =
          patchesDir != null
          && (
            lib.hasPrefix "${patchesDir}/" relPath
            || relPath == patchesDir
            || lib.any
              (
                memberDir:
                lib.hasPrefix "${memberDir}/${patchesDir}/" relPath
                || relPath == "${memberDir}/${patchesDir}"
              )
              workspaceMembers
          );
      in
      lib.cleanSourceFilter path type
      && !(lib.elem baseName (
        [
          ".git"
          ".direnv"
          ".devenv"
          ".cache"
          ".turbo"
          ".next"
          ".bun"
          "node_modules"
          "dist"
          "result"
          "coverage"
          "tmp"
          "out"
        ]
        ++ extraExcludedSourceNames
      ))
      && (isInWorkspaceClosure || isWorkspaceClosureParent || isInPatches);
  };

  # Read package.json for version
  packageJsonPath = workspaceRootPath + "/${packageDir}/package.json";
  packageJson = builtins.fromJSON (builtins.readFile packageJsonPath);
  packageVersion = packageJson.version or "0.0.0";
  entryRelativeToPackage =
    if lib.hasPrefix "${packageDir}/" entry then
      lib.removePrefix "${packageDir}/" entry
    else
      throw "mk-pnpm-cli: entry must be inside packageDir (${packageDir}): ${entry}";

  # Build NixStamp JSON for embedding in binary
  # Note: We manually construct the JSON to avoid escaping issues with builtins.toJSON
  # when the string is interpolated into shell scripts and substituteInPlace.
  dirtyStr = if dirty then "true" else "false";
  nixStampJson = ''{\"type\":\"nix\",\"version\":\"${packageVersion}\",\"rev\":\"${gitRev}\",\"commitTs\":${toString commitTs},\"dirty\":${dirtyStr}}'';

  smokeTestArgsStr = lib.escapeShellArgs smokeTestArgs;
  pnpmDepsHelper = import ./mk-pnpm-deps.nix { inherit pkgs; };

in
pkgs.stdenv.mkDerivation {
  inherit name;

  nativeBuildInputs = [
    pkgs.pnpm
    pkgs.nodejs
    pkgs.bun
    pkgs.cacert
    pkgs.zstd
  ]
  ++ lib.optionals (lockfileHash != null) [ pkgs.nix ];

  inherit pnpmDeps;

  dontUnpack = true;
  dontFixup = true;

  buildPhase = ''
    set -euo pipefail
    runHook preBuild

    ${
      if lockfileHash != null then
        ''
          # Validate lockfile hash (early failure with clear message)
          currentHash="sha256-$(nix-hash --type sha256 --base64 ${workspaceClosureSrc}/${packageDir}/pnpm-lock.yaml)"
          if [ "$currentHash" != "${lockfileHash}" ]; then
            echo ""
            echo "error: lockfileHash is stale (run: dt nix:hash)"
            echo "  expected: ${lockfileHash}"
            echo "  actual:   $currentHash"
            echo ""
            exit 1
          fi
        ''
      else
        ""
    }

    ${pnpmDepsHelper.mkRestoreScript { deps = pnpmDeps; }}

    # Copy only the package's workspace closure into the build sandbox.
    echo "Copying workspace closure..."
    cp -r ${workspaceClosureSrc} workspace
    chmod -R +w workspace
    cd workspace

    # Deploy the target package from the staged closure into an isolated output
    # tree. This keeps build-time dependency resolution independent from the
    # raw workspace layout used during development.
    echo "Deploying package closure..."
    deploy_dir="$PWD/.pnpm-deploy"
    rm -rf "$deploy_dir"
    cd ${packageDir}
    pnpm --config.inject-workspace-packages=true \
      --filter . \
      deploy \
      --frozen-lockfile \
      --ignore-scripts \
      "$deploy_dir"
    cd "$deploy_dir"

    # Inject build stamp
    if [ -f "${entryRelativeToPackage}" ]; then
      substituteInPlace "${entryRelativeToPackage}" \
        --replace-quiet "const buildStamp = '__CLI_BUILD_STAMP__'" "const buildStamp = '${nixStampJson}'"
    fi

    # Build the CLI
    echo "Building CLI..."
    mkdir -p output
    bun build ${entryRelativeToPackage} --compile ${lib.concatStringsSep " " extraBunBuildArgs} --outfile=output/${binaryName}

    # Smoke test
    if [ -n "${smokeTestArgsStr}" ]; then
      echo "Running smoke test..."
      ./output/${binaryName} ${smokeTestArgsStr}
    fi

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin
    # We're still in workspace/.pnpm-deploy from buildPhase
    cp output/${binaryName} $out/bin/

    runHook postInstall
  '';
}
