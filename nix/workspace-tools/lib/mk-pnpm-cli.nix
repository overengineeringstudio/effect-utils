{ pkgs, pnpm }:

{
  name,
  entry,
  packageDir,
  workspaceRoot,
  workspaceSources ? { },
  depsBuilds,
  binaryName ? name,
  gitRev ? "unknown",
  commitTs ? 0,
  dirty ? false,
  prodInstall ? false,
  smokeTestArgs ? [ "--help" ],
  extraBunBuildArgs ? [ ],
}:

let
  lib = pkgs.lib;
  pnpmDepsHelper = import ./mk-pnpm-deps.nix { inherit pkgs pnpm; };

  coerceSourceRoot =
    sourceRoot:
    if builtins.isAttrs sourceRoot && builtins.hasAttr "outPath" sourceRoot then
      if (sourceRoot.type or null) == "derivation" then sourceRoot.outPath else sourceRoot
    else if builtins.isPath sourceRoot then
      sourceRoot
    else
      builtins.toPath sourceRoot;

  workspaceRootPath = coerceSourceRoot workspaceRoot;

  normalizeSourceRoot =
    prefix: sourceRoot:
    let
      rawPath = coerceSourceRoot sourceRoot;
    in
    builtins.path {
      path = rawPath;
      name = lib.strings.sanitizeDerivationName (lib.replaceStrings [ "/" ] [ "-" ] prefix);
    };

  workspaceSourceRawRoots = lib.mapAttrs (_: coerceSourceRoot) workspaceSources;
  workspaceSourceRoots = lib.mapAttrs normalizeSourceRoot workspaceSources;
  workspaceSourcePrefixesByLengthAsc = lib.sort (
    left: right: lib.stringLength left < lib.stringLength right
  ) (builtins.attrNames workspaceSourceRoots);
  workspaceSourcePrefixesByLengthDesc = lib.reverseList workspaceSourcePrefixesByLengthAsc;

  hasInstallRoot =
    sourceRoot:
    builtins.pathExists (sourceRoot + "/package.json")
    && builtins.pathExists (sourceRoot + "/pnpm-lock.yaml");

  resolveSourceFor =
    relPath:
    let
      matchesPrefix =
        candidate:
        if candidate == "." || candidate == "" then
          true
        else
          relPath == candidate || lib.hasPrefix "${candidate}/" relPath;
      prefix = lib.findFirst matchesPrefix null workspaceSourcePrefixesByLengthDesc;
      sourceRoot = if prefix == null then workspaceRootPath else workspaceSourceRawRoots.${prefix};
      fullSourceRoot = if prefix == null then workspaceRootPath else workspaceSourceRoots.${prefix};
      sourceRelPath =
        if prefix == null then
          relPath
        else if prefix == "." || prefix == "" then
          relPath
        else if relPath == prefix then
          "."
        else
          lib.removePrefix "${prefix}/" relPath;
    in
    {
      inherit prefix;
      inherit sourceRoot fullSourceRoot sourceRelPath;
    };

  snapshotPath =
    namePrefix: path:
    builtins.path {
      path = path;
      name = lib.strings.sanitizeDerivationName (lib.replaceStrings [ "/" ] [ "-" ] namePrefix);
    };

  rawFileSourcePathFor =
    relPath:
    let
      resolved = resolveSourceFor relPath;
    in
    if resolved.sourceRelPath == "." then
      resolved.sourceRoot
    else
      resolved.sourceRoot + "/${resolved.sourceRelPath}";

  absoluteFileSourcePathFor = relPath: snapshotPath relPath (rawFileSourcePathFor relPath);

  absoluteDirectorySourcePathFor =
    relPath:
    let
      resolved = resolveSourceFor relPath;
    in
    if resolved.sourceRelPath == "." then
      resolved.fullSourceRoot
    else
      resolved.fullSourceRoot + "/${resolved.sourceRelPath}";

  # Read workspace closure dirs from the generated package.json ($genie.workspaceClosureDirs).
  # Pre-computed by genie at generation time, avoiding import-from-derivation (IFD).
  # Future alternative: NixOS/nix#15380 (builtins.wasm) could compute this natively at eval time.
  packageJsonPath = absoluteFileSourcePathFor "${packageDir}/package.json";
  packageJson = builtins.fromJSON (builtins.readFile packageJsonPath);
  packageVersion = packageJson.version or "0.0.0";

  rootPnpmWorkspaceYamlPath = workspaceRootPath + "/pnpm-workspace.yaml";
  rootPnpmWorkspaceYaml = builtins.readFile rootPnpmWorkspaceYamlPath;

  workspaceSuffixLines =
    workspaceYaml:
    let
      dropUntilPackagesHeader =
        lines:
        if lines == [ ] then
          throw "mk-pnpm-cli: pnpm-workspace.yaml is missing packages:"
        else if lib.hasPrefix "packages:" (lib.trim (builtins.head lines)) then
          lib.tail lines
        else
          dropUntilPackagesHeader (lib.tail lines);

      dropPackageBlock =
        lines:
        if lines == [ ] then
          [ ]
        else
          let
            line = builtins.head lines;
            trimmed = lib.trim line;
          in
          if trimmed == "" || lib.hasPrefix "-" trimmed || lib.hasPrefix " " line then
            dropPackageBlock (lib.tail lines)
          else
            lines;

      # GVS requires a global pnpm store unavailable inside Nix sandboxes
      stripGvs =
        lines: builtins.filter (l: !(lib.hasPrefix "enableGlobalVirtualStore" (lib.trim l))) lines;
    in
    stripGvs (dropPackageBlock (dropUntilPackagesHeader (lib.splitString "\n" workspaceYaml)));

  formatWorkspaceYaml =
    packageDirs: suffixLines:
    let
      packagesBlock = builtins.concatStringsSep "\n" (
        [ "packages:" ] ++ map (dir: "  - ${dir}") packageDirs
      );
      suffix = builtins.concatStringsSep "\n" suffixLines;
    in
    if suffix == "" then "${packagesBlock}\n" else "${packagesBlock}\n\n${suffix}\n";

  workspaceClosureDirs =
    let
      genieData = packageJson."$genie" or { };
    in
    if !(genieData ? workspaceClosureDirs) then
      throw "mk-pnpm-cli: ${packageDir}/package.json missing $genie.workspaceClosureDirs (run: dt genie:run)"
    else if !(lib.elem packageDir genieData.workspaceClosureDirs) then
      throw "mk-pnpm-cli: $genie.workspaceClosureDirs does not contain packageDir (${packageDir})"
    else
      genieData.workspaceClosureDirs;
  workspaceMembers = builtins.filter (dir: dir != packageDir) workspaceClosureDirs;

  resolvedWorkspaceMembers = map (
    dir:
    let
      resolved = resolveSourceFor dir;
    in
    {
      inherit dir;
      inherit resolved;
      sourcePath =
        if resolved.sourceRelPath == "." then
          resolved.sourceRoot
        else
          resolved.sourceRoot + "/${resolved.sourceRelPath}";
    }
  ) workspaceMembers;
  externalInstallRootItems = builtins.filter (item: item != null) (
    map (
      item:
      let
        prefixRootHasWorkspace =
          item.resolved.prefix != null
          && builtins.pathExists (item.resolved.sourceRoot + "/pnpm-workspace.yaml")
          && hasInstallRoot item.resolved.sourceRoot;
        memberHasInstallRoot = hasInstallRoot item.sourcePath;
      in
      if item.resolved.prefix == null then
        null
      else if prefixRootHasWorkspace then
        {
          installDir = item.resolved.prefix;
          installSourceRoot = item.resolved.sourceRoot;
          memberDir = item.dir;
          sourceRelMemberDir = item.resolved.sourceRelPath;
        }
      else if memberHasInstallRoot then
        {
          installDir = item.dir;
          installSourceRoot = item.sourcePath;
          memberDir = item.dir;
          sourceRelMemberDir = ".";
        }
      else
        null
    ) resolvedWorkspaceMembers
  );

  externalInstallRoots = lib.sort (left: right: left.installDir < right.installDir) (
    map
      (
        installDir:
        let
          items = builtins.filter (item: item.installDir == installDir) externalInstallRootItems;
          installSourceRoot = (builtins.head items).installSourceRoot;
          hasWorkspaceYaml = builtins.pathExists (installSourceRoot + "/pnpm-workspace.yaml");
          sourcePnpmWorkspaceYaml =
            if hasWorkspaceYaml then builtins.readFile (installSourceRoot + "/pnpm-workspace.yaml") else "";
        in
        {
          inherit installDir installSourceRoot;
          inherit sourcePnpmWorkspaceYaml;
          memberDirs = lib.unique (map (item: item.memberDir) items);
          sourceRelMemberDirs = lib.unique (map (item: item.sourceRelMemberDir) items);
          filteredPnpmWorkspaceYaml =
            if hasWorkspaceYaml then
              formatWorkspaceYaml (lib.unique (map (item: item.sourceRelMemberDir) items)) (
                workspaceSuffixLines sourcePnpmWorkspaceYaml
              )
            else
              formatWorkspaceYaml [ "." ] [ ];
        }
      )
      (
        lib.sort (left: right: left < right) (
          lib.unique (map (item: item.installDir) externalInstallRootItems)
        )
      )
  );
  stagedWorkspaceMembers =
    let
      externallyOwnedDirs = lib.concatMap (root: root.memberDirs) externalInstallRoots;
    in
    lib.unique (
      [ packageDir ] ++ builtins.filter (dir: !(lib.elem dir externallyOwnedDirs)) workspaceMembers
    );
  allExternallyOwnedDirs =
    (map (root: root.installDir) externalInstallRoots)
    ++ (lib.concatMap (root: root.memberDirs) externalInstallRoots);
  aggregateOwnedWorkspaceClosureDirs = builtins.filter (
    dir: !(lib.elem dir allExternallyOwnedDirs)
  ) workspaceClosureDirs;

  filteredRootPnpmWorkspaceYaml = formatWorkspaceYaml stagedWorkspaceMembers (
    workspaceSuffixLines rootPnpmWorkspaceYaml
  );

  # These are the files that define dependency identity for the aggregate root.
  # Keep this list narrow so source-only edits do not invalidate prepared deps,
  # but broad enough that any manifest / workspace policy drift still does.
  rootWorkspaceFiles = [
    "package.json"
    "pnpm-lock.yaml"
  ];
  optionalRootWorkspaceFiles = [
    ".npmrc"
    "tsconfig.base.json"
  ];
  installRootScopedPath =
    installDir: relPath: if installDir == "." then relPath else "${installDir}/${relPath}";
  # Expose a stable, CLI-friendly attr key while keeping the real install dir
  # in `dir`. This avoids leaking path separators into flake package names and
  # keeps downstream tooling simple.
  installRootAttrName =
    installDir:
    if installDir == "." then
      "root"
    else
      lib.strings.sanitizeDerivationName (lib.replaceStrings [ "/" ] [ "-" ] installDir);
  installRootDerivationName =
    installDir:
    if installDir == "." then name else "${name}-${lib.replaceStrings [ "/" ] [ "-" ] installDir}";
  installRootMemberDirs =
    root:
    if root ? memberDirs then
      lib.sort (left: right: left < right) root.memberDirs
    else
      [ root.installDir ];
  /**
    Generic identity for a filtered install-root dependency boundary.

    This does not try to name downstream reuse profiles like "tui" or "full".
    Upstream only exposes the authoritative filtered member set plus a stable
    key derived from that set. Downstream repos can then decide whether a
    repeated boundary is worth naming and sharing for amortization.
  */
  installRootProfileKey =
    root:
    builtins.hashString "sha256" (
      builtins.toJSON {
        dir = root.installDir;
        memberDirs = installRootMemberDirs root;
      }
    );

  /**
    `depsBuilds` is the canonical source of truth for prepared pnpm artifacts.

    Each install root gets one fixed-output derivation, and the downstream CLI
    derivation depends on those prepared artifacts directly. That means the
    artifact hash already is the effective dependency fingerprint for downstream
    rebuilds: if the prepared tree changes, the store path changes and the CLI
    rebuilds; if it does not change, the CLI can reuse the cached deps build.

    A second builder-level fingerprint would only help faster preflight stale
    checks. It would not improve correctness, reuse, or downstream invalidation,
    so that concern stays in tooling rather than the builder contract.
  */
  depsBuildEntries = map (
    installDir:
    let
      entry = builtins.getAttr installDir depsBuilds;
    in
    if !(builtins.isAttrs entry && entry ? hash) then
      throw "mk-pnpm-cli: depsBuilds.${installDir} must be { hash = \"sha256-...\"; }"
    else
      {
        dir = installDir;
        hash = entry.hash;
      }
  ) (builtins.attrNames depsBuilds);

  depsBuildHashForInstallRoot =
    installDir:
    if !(builtins.hasAttr installDir depsBuilds) then
      throw "mk-pnpm-cli: depsBuilds is missing an entry for install root ${installDir}"
    else
      (builtins.getAttr installDir depsBuilds).hash;

  copyFileCmd =
    relPath:
    let
      srcPath = absoluteFileSourcePathFor relPath;
    in
    ''
      mkdir -p "$out/$(dirname "${relPath}")"
      cp ${lib.escapeShellArg (toString srcPath)} "$out/${relPath}"
    '';

  copyDirCmd =
    relPath:
    let
      srcPath = absoluteDirectorySourcePathFor relPath;
    in
    ''
      mkdir -p "$out/$(dirname "${relPath}")"
      cp -R ${lib.escapeShellArg (toString srcPath)} "$out/$(dirname "${relPath}")/"
      chmod -R +w "$out/${relPath}"
    '';

  copyOptionalFileCmd =
    relPath:
    let
      rawSrcPath = rawFileSourcePathFor relPath;
      srcPath = snapshotPath relPath rawSrcPath;
    in
    if builtins.pathExists rawSrcPath then
      ''
        if [ -f ${lib.escapeShellArg (toString srcPath)} ]; then
          ${copyFileCmd relPath}
        fi
      ''
    else
      "";

  writeWorkspaceYamlCmd =
    installDir: workspaceYaml:
    let
      targetPath = installRootScopedPath installDir "pnpm-workspace.yaml";
    in
    ''
      mkdir -p "$out/$(dirname "${targetPath}")"
      cat > "$out/${targetPath}" <<'EOF'
      ${workspaceYaml}
      EOF
    '';

  /**
    Parse patch file paths from pnpm-workspace.yaml (pnpm 11+ format).
    In pnpm 11, patchedDependencies are declared in pnpm-workspace.yaml as:
      patchedDependencies:
        name@version: path/to/patch.patch
    The value after `: ` is the patch file path relative to the workspace root.
  */
  parseWorkspacePatchPaths =
    workspaceYamlContent:
    let
      lines = lib.splitString "\n" workspaceYamlContent;
      collect =
        {
          inBlock,
          paths,
        }:
        remaining:
        if remaining == [ ] then
          paths
        else
          let
            line = builtins.head remaining;
            rest = lib.tail remaining;
            trimmed = lib.trim line;
          in
          if !inBlock then
            if lib.hasPrefix "patchedDependencies:" trimmed then
              collect {
                inBlock = true;
                inherit paths;
              } rest
            else
              collect {
                inherit inBlock paths;
              } rest
          else if trimmed == "" then
            paths
          else if builtins.substring 0 1 line != " " && builtins.substring 0 1 line != "\t" then
            paths
          else
            let
              colonIdx = lib.stringLength (builtins.head (builtins.split ":" trimmed));
              value = lib.trim (builtins.substring (colonIdx + 1) (lib.stringLength trimmed) trimmed);
              isPatchPath = lib.hasSuffix ".patch" value;
            in
            if isPatchPath then
              collect {
                inherit inBlock;
                paths = paths ++ [ value ];
              } rest
            else
              collect {
                inherit inBlock paths;
              } rest;
    in
    collect {
      inBlock = false;
      paths = [ ];
    } lines;

  /**
    Copy patch files referenced by a workspace, resolving each patch path to an
    exact staged input so source-only edits outside the patch files themselves
    do not invalidate dependency preparation.
  */
  copyResolvedPatchFilesCmd =
    {
      sourcePrefix ? "",
      workspaceYamlContent,
      targetPrefix,
    }:
    let
      patchPaths = parseWorkspacePatchPaths workspaceYamlContent;
      copyOnePatch =
        relPath:
        let
          sourceRelPath = if sourcePrefix == "" then relPath else "${sourcePrefix}/${relPath}";
          srcPath = absoluteFileSourcePathFor sourceRelPath;
          targetRelPath = if targetPrefix == "" then relPath else "${targetPrefix}/${relPath}";
          srcPathArg = lib.escapeShellArg (toString srcPath);
          targetRelPathArg = lib.escapeShellArg targetRelPath;
        in
        ''
          target_patch=${targetRelPathArg}
          mkdir -p "$out/$(dirname "$target_patch")"
          chmod -R +w "$out/$(dirname "$target_patch")" 2>/dev/null || true
          cp ${srcPathArg} "$out/$target_patch"
        '';
    in
    builtins.concatStringsSep "\n" (map copyOnePatch patchPaths);

  stageExternalInstallRootManifestOnlyCmd =
    root:
    builtins.concatStringsSep "\n" (
      (map (file: copyFileCmd (installRootScopedPath root.installDir file)) rootWorkspaceFiles)
      ++ (map (
        file: copyOptionalFileCmd (installRootScopedPath root.installDir file)
      ) optionalRootWorkspaceFiles)
      ++ (map (dir: copyFileCmd "${dir}/package.json") (
        builtins.filter (dir: dir != root.installDir) root.memberDirs
      ))
      ++ [
        (writeWorkspaceYamlCmd root.installDir root.filteredPnpmWorkspaceYaml)
        (copyResolvedPatchFilesCmd {
          sourcePrefix = root.installDir;
          workspaceYamlContent = root.sourcePnpmWorkspaceYaml;
          targetPrefix = root.installDir;
        })
      ]
    );

  # The aggregate root owns the top-level lockfile plus any workspace members
  # not delegated to nested install roots. It still stages external install-root
  # manifests so the aggregate lockfile can resolve linked workspace packages
  # against the exact member set that will exist in the final composed build.
  rootDepsSrc = pkgs.runCommand "${name}-pnpm-deps-src" { } (
    ''
      set -euo pipefail
      mkdir -p "$out"
    ''
    + builtins.concatStringsSep "\n" (map copyFileCmd rootWorkspaceFiles)
    + builtins.concatStringsSep "\n" (map copyOptionalFileCmd optionalRootWorkspaceFiles)
    + writeWorkspaceYamlCmd "." filteredRootPnpmWorkspaceYaml
    + builtins.concatStringsSep "\n" (
      map (dir: copyFileCmd "${dir}/package.json") aggregateOwnedWorkspaceClosureDirs
    )
    + copyResolvedPatchFilesCmd {
      sourcePrefix = "";
      workspaceYamlContent = rootPnpmWorkspaceYaml;
      targetPrefix = "";
    }
    + builtins.concatStringsSep "\n" (map stageExternalInstallRootManifestOnlyCmd externalInstallRoots)
  );

  # Each external install root gets its own manifest-only derivation and its
  # own prepared deps artifact. This is the key reuse boundary for composed
  # workspaces: root-only changes should not force a full reinstall of
  # `repos/effect-utils`, while changes inside that nested workspace should
  # still invalidate its own prepared tree deterministically.
  externalInstallRootDeps = map (
    root:
    let
      depsSrc = pkgs.runCommand "${installRootDerivationName root.installDir}-pnpm-deps-src" { } (
        ''
          set -euo pipefail
          mkdir -p "$out"
        ''
        + stageExternalInstallRootManifestOnlyCmd root
      );
      lockfilePath = installRootScopedPath root.installDir "pnpm-lock.yaml";
      depsBuild = pnpmDepsHelper.mkDeps {
        name = installRootDerivationName root.installDir;
        src = depsSrc;
        sourceRoot = ".";
        lockfilePaths = [ lockfilePath ];
        preInstall = ''
          chmod -R +w .
        '';
        pnpmDepsHash = depsBuildHashForInstallRoot root.installDir;
      };
    in
    root
    // {
      attrName = installRootAttrName root.installDir;
      inherit depsSrc lockfilePath depsBuild;
    }
  ) externalInstallRoots;

  # Keep the aggregate root as a first-class install root alongside any nested
  # composed roots. Final restoration simply overlays each prepared tree into
  # the full workspace snapshot in a deterministic order.
  rootInstallRoot = {
    attrName = "root";
    installDir = ".";
    lockfilePath = "pnpm-lock.yaml";
    depsSrc = rootDepsSrc;
    depsBuild = pnpmDepsHelper.mkDeps {
      inherit name;
      pnpmDepsHash = depsBuildHashForInstallRoot ".";
      src = rootDepsSrc;
      sourceRoot = ".";
      lockfilePaths = [ "pnpm-lock.yaml" ];
      preInstall = ''
        chmod -R +w .
      '';
    };
  };
  depsInstallRoots = [ rootInstallRoot ] ++ externalInstallRootDeps;
  installRootDirs = map (root: root.installDir) depsInstallRoots;
  unknownDepsBuildDirs = builtins.filter (dir: !(lib.elem dir installRootDirs)) (
    builtins.attrNames depsBuilds
  );
  _validateInstallRootHashContract =
    if unknownDepsBuildDirs != [ ] then
      throw "mk-pnpm-cli: depsBuilds contains unknown install roots"
    else if builtins.length depsInstallRoots == 0 then
      throw "mk-pnpm-cli: expected at least one install root"
    else if builtins.any (installDir: !(builtins.hasAttr installDir depsBuilds)) installRootDirs then
      throw ''
        mk-pnpm-cli: depsBuilds must provide one { hash = "..."; } entry per install root.
        discovered install roots: ${builtins.toJSON installRootDirs}
        provided depsBuild keys: ${builtins.toJSON (builtins.attrNames depsBuilds)}
        example:
          depsBuilds = {
            "." = { hash = "sha256-..."; };
          };
      ''
    else
      true;
  depsBuildsByInstallRoot = builtins.listToAttrs (
    map (root: {
      name = root.attrName;
      value = root.depsBuild;
    }) depsInstallRoots
  );
  depsSrcByInstallRoot = builtins.listToAttrs (
    map (root: {
      name = root.attrName;
      value = root.depsSrc;
    }) depsInstallRoots
  );

  materializeWorkspace =
    {
      nameSuffix,
      manifestOnly,
    }:
    pkgs.runCommand "${name}-${nameSuffix}" { } (
      ''
        set -euo pipefail
        mkdir -p "$out"
      ''
      + builtins.concatStringsSep "\n" (map copyFileCmd rootWorkspaceFiles)
      + builtins.concatStringsSep "\n" (map copyOptionalFileCmd optionalRootWorkspaceFiles)
      + ''
                cat > "$out/pnpm-workspace.yaml" <<'EOF'
        ${filteredRootPnpmWorkspaceYaml}
        EOF
      ''
      + builtins.concatStringsSep "\n" (
        map (
          root:
          builtins.concatStringsSep "\n" (
            (
              # `manifestOnly` is used for dependency preparation, where we want
              # the narrowest possible invalidation boundary. The full workspace
              # snapshot is used later by the actual CLI build, where source
              # files are needed but dependency prep should already be cached.
              if manifestOnly then
                (map (file: copyFileCmd "${root.installDir}/${file}") rootWorkspaceFiles)
                ++ (map (file: copyOptionalFileCmd "${root.installDir}/${file}") optionalRootWorkspaceFiles)
                ++ (map (dir: copyFileCmd "${dir}/package.json") (
                  builtins.filter (dir: dir != root.installDir) root.memberDirs
                ))
              else if lib.elem root.installDir root.memberDirs then
                [ (copyDirCmd root.installDir) ]
              else
                (map (file: copyFileCmd "${root.installDir}/${file}") rootWorkspaceFiles)
                ++ (map (file: copyOptionalFileCmd "${root.installDir}/${file}") optionalRootWorkspaceFiles)
                ++ (map copyDirCmd (builtins.filter (dir: dir != root.installDir) root.memberDirs))
            )
            ++ [
              ''
                                  mkdir -p "$out/${root.installDir}"
                                  cat > "$out/${root.installDir}/pnpm-workspace.yaml" <<'EOF'
                ${root.filteredPnpmWorkspaceYaml}
                EOF
              ''
            ]
          )
        ) externalInstallRoots
      )
      + builtins.concatStringsSep "\n" (
        if manifestOnly then
          map (dir: copyFileCmd "${dir}/package.json") aggregateOwnedWorkspaceClosureDirs
        else
          map copyDirCmd aggregateOwnedWorkspaceClosureDirs
      )
      + copyResolvedPatchFilesCmd {
        sourcePrefix = "";
        workspaceYamlContent = rootPnpmWorkspaceYaml;
        targetPrefix = "";
      }
      + builtins.concatStringsSep "\n" (
        map (
          root:
          copyResolvedPatchFilesCmd {
            sourcePrefix = root.installDir;
            workspaceYamlContent = root.sourcePnpmWorkspaceYaml;
            targetPrefix = root.installDir;
          }
        ) externalInstallRoots
      )
    );

  workspaceClosureSrc = materializeWorkspace {
    nameSuffix = "workspace";
    manifestOnly = false;
  };

  entryRelativeToPackage =
    if lib.hasPrefix "${packageDir}/" entry then
      lib.removePrefix "${packageDir}/" entry
    else
      throw "mk-pnpm-cli: entry must be inside packageDir (${packageDir}): ${entry}";

  dirtyStr = if dirty then "true" else "false";
  nixStampJson = ''{\"type\":\"nix\",\"version\":\"${packageVersion}\",\"rev\":\"${gitRev}\",\"commitTs\":${toString commitTs},\"dirty\":${dirtyStr}}'';
  smokeTestArgsStr = lib.escapeShellArgs smokeTestArgs;

in
assert _validateInstallRootHashContract;
pkgs.stdenv.mkDerivation {
  inherit name;

  nativeBuildInputs = [
    pkgs.bun
    pkgs.nix
    pkgs.nodejs
    pkgs.perl
    pnpm
  ];

  dontUnpack = true;
  dontFixup = true;
  passthru = {
    depsSrc = rootDepsSrc;
    inherit depsSrcByInstallRoot depsBuildsByInstallRoot;
    installRoots = map (root: {
      inherit (root) attrName installDir lockfilePath;
      memberDirs = installRootMemberDirs root;
      profileKey = installRootProfileKey root;
    }) depsInstallRoots;
    depsBuildEntries = map (root: {
      dir = root.installDir;
      attrName = root.attrName;
      memberDirs = installRootMemberDirs root;
      profileKey = installRootProfileKey root;
      hash = depsBuildHashForInstallRoot root.installDir;
    }) depsInstallRoots;
  };

  buildPhase = ''
    set -euo pipefail
    runHook preBuild

    timer_now() {
      perl -MTime::HiRes=time -e 'printf "%.3f", time'
    }

    timer_elapsed() {
      perl -e 'printf "%.3f", $ARGV[1] - $ARGV[0]' "$1" "$(timer_now)"
    }

    format_bytes() {
      numfmt --to=iec-i --suffix=B --format='%.1f' "$1" 2>/dev/null || echo "$1"'B'
    }

    path_bytes() {
      if [ -d "$1" ]; then
        du --apparent-size -sk "$1" 2>/dev/null | awk '{print $1 * 1024}'
      else
        stat -c%s "$1" 2>/dev/null || stat -f%z "$1"
      fi
    }

    log_cli_phase() {
      local phase="$1"
      shift
      echo "cli-build: phase=$phase cli=${binaryName} package=${packageDir} $*"
    }

    buildStartedAt=$(timer_now)
    log_cli_phase "start" "install_roots=${toString (builtins.length depsInstallRoots)}"

    echo "Copying filtered aggregate workspace..."
    workspaceCopyStartedAt=$(timer_now)
    cp -r ${workspaceClosureSrc} workspace
    chmod -R +w workspace
    log_cli_phase "workspace-copy" "duration=$(timer_elapsed "$workspaceCopyStartedAt")s"

    ${builtins.concatStringsSep "\nchmod -R +w workspace\n" (
      map (
        root:
        pnpmDepsHelper.mkRestoreScript {
          deps = root.depsBuild;
          target = "workspace";
          label = root.installDir;
        }
      ) depsInstallRoots
    )}
    chmod -R +w workspace

    cd workspace

    # Keep pnpm itself deterministic for workspace-prep helpers while exposing a
    # shared wrapper for already-installed workspace binaries in postBuild hooks.
    export HOME=$(mktemp -d "$NIX_BUILD_TOP/pnpm-home.XXXXXX")
    export PNPM_HOME="$HOME/.local/share/pnpm"
    export WORKSPACE_ROOT_BIN_DIR="$NIX_BUILD_TOP/workspace/node_modules/.bin"
    mkdir -p "$PNPM_HOME"
    printf '\nmanage-package-manager-versions=false\n' >> .npmrc
    run_workspace_bin() {
      local bin_name="$1"
      shift
      local package_bin_dir="$PWD/node_modules/.bin"

      if [ -x "$package_bin_dir/$bin_name" ]; then
        "$package_bin_dir/$bin_name" "$@"
      elif [ -x "$WORKSPACE_ROOT_BIN_DIR/$bin_name" ]; then
        "$WORKSPACE_ROOT_BIN_DIR/$bin_name" "$@"
      else
        echo "error: workspace binary '$bin_name' not found in $package_bin_dir or $WORKSPACE_ROOT_BIN_DIR" >&2
        exit 127
      fi
    }

    cd ${packageDir}

    if [ -f "${entryRelativeToPackage}" ]; then
      stampStartedAt=$(timer_now)
      substituteInPlace "${entryRelativeToPackage}" \
        --replace-quiet "const buildStamp = '__CLI_BUILD_STAMP__'" "const buildStamp = '${nixStampJson}'"
      log_cli_phase "stamp-build-metadata" "duration=$(timer_elapsed "$stampStartedAt")s entry=${entryRelativeToPackage}"
    fi

    echo "Building CLI..."
    mkdir -p output
    bunBuildStartedAt=$(timer_now)
    bun build ${entryRelativeToPackage} --compile ${lib.concatStringsSep " " extraBunBuildArgs} --outfile=output/${binaryName}
    binaryBytes=$(path_bytes "output/${binaryName}")
    log_cli_phase "bun-build" "duration=$(timer_elapsed "$bunBuildStartedAt")s binary_size=$(format_bytes "$binaryBytes")"

    if [ -n "${smokeTestArgsStr}" ]; then
      echo "Running smoke test..."
      smokeStartedAt=$(timer_now)
      ./output/${binaryName} ${smokeTestArgsStr}
      log_cli_phase "smoke-test" "duration=$(timer_elapsed "$smokeStartedAt")s args=${lib.escapeShellArg (builtins.concatStringsSep " " smokeTestArgs)}"
    fi

    log_cli_phase "build-complete" "duration=$(timer_elapsed "$buildStartedAt")s"

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install_timer_now() {
      perl -MTime::HiRes=time -e 'printf "%.3f", time'
    }

    install_timer_elapsed() {
      perl -e 'printf "%.3f", $ARGV[1] - $ARGV[0]' "$1" "$(install_timer_now)"
    }

    install_format_bytes() {
      numfmt --to=iec-i --suffix=B --format='%.1f' "$1" 2>/dev/null || echo "$1"'B'
    }

    installStartedAt=$(install_timer_now)
    mkdir -p "$out/bin"
    cp "$NIX_BUILD_TOP/workspace/${packageDir}/output/${binaryName}" "$out/bin/"
    installedBytes=$(du --apparent-size -sk "$out/bin/${binaryName}" 2>/dev/null | awk '{print $1 * 1024}')
    installedBytes=''${installedBytes:-0}
    echo "cli-build: phase=install cli=${binaryName} package=${packageDir} duration=$(install_timer_elapsed "$installStartedAt")s installed_size=$(install_format_bytes "$installedBytes")"
    runHook postInstall
  '';
}
