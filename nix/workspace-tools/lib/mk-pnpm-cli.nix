{ pkgs, pnpm }:

{
  name,
  entry,
  packageDir,
  workspaceRoot,
  workspaceSources ? { },
  pnpmDepsHash,
  lockfileHash ? null,
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

  workspaceRootPath =
    if builtins.isAttrs workspaceRoot && builtins.hasAttr "outPath" workspaceRoot then
      workspaceRoot.outPath
    else if builtins.isPath workspaceRoot then
      workspaceRoot
    else
      builtins.toPath workspaceRoot;

  normalizeSourceRoot =
    prefix: sourceRoot:
    let
      rawPath =
        if builtins.isAttrs sourceRoot && builtins.hasAttr "outPath" sourceRoot then
          sourceRoot.outPath
        else if builtins.isPath sourceRoot then
          sourceRoot
        else
          builtins.toPath sourceRoot;
      normalizedPathString = builtins.unsafeDiscardStringContext (toString rawPath);
    in
    builtins.path {
      path = normalizedPathString;
      name = lib.replaceStrings [ "/" ] [ "-" ] prefix;
    };

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
      sourceRoot = if prefix == null then workspaceRootPath else workspaceSourceRoots.${prefix};
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
      inherit sourceRoot sourceRelPath;
    };

  absoluteSourcePathFor =
    relPath:
    let
      resolved = resolveSourceFor relPath;
    in
    if resolved.sourceRelPath == "." then
      resolved.sourceRoot
    else
      resolved.sourceRoot + "/${resolved.sourceRelPath}";

  # Read workspace closure dirs from the generated package.json ($genie.workspaceClosureDirs).
  # Pre-computed by genie at generation time, avoiding import-from-derivation (IFD).
  # Future alternative: NixOS/nix#15380 (builtins.wasm) could compute this natively at eval time.
  packageJsonPath = absoluteSourcePathFor "${packageDir}/package.json";
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
      stripGvs = lines: builtins.filter (l: !(lib.hasPrefix "enableGlobalVirtualStore" (lib.trim l))) lines;
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

  rootLockfileContent = builtins.readFile (absoluteSourcePathFor "pnpm-lock.yaml");
  rootWorkspaceFiles = [
    "package.json"
    "pnpm-lock.yaml"
  ];
  optionalRootWorkspaceFiles = [
    ".npmrc"
    "tsconfig.base.json"
  ];

  copyFileCmd =
    relPath:
    let
      srcPath = absoluteSourcePathFor relPath;
    in
    ''
      mkdir -p "$out/$(dirname "${relPath}")"
      cp ${lib.escapeShellArg (toString srcPath)} "$out/${relPath}"
    '';

  copyDirCmd =
    relPath:
    let
      srcPath = absoluteSourcePathFor relPath;
    in
    ''
      mkdir -p "$out/$(dirname "${relPath}")"
      cp -R ${lib.escapeShellArg (toString srcPath)} "$out/$(dirname "${relPath}")/"
      chmod -R +w "$out/${relPath}"
    '';

  copyOptionalFileCmd =
    relPath:
    let
      srcPath = absoluteSourcePathFor relPath;
    in
    ''
      if [ -f ${lib.escapeShellArg (toString srcPath)} ]; then
        ${copyFileCmd relPath}
      fi
    '';

  /**
    Parse patchedDependencies path: entries from a pnpm-lock.yaml string (pure Nix).
  */
  parsePatchPaths =
    lockfileContent:
    let
      lines = lib.splitString "\n" lockfileContent;
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
            collect {
              inherit inBlock paths;
            } rest
          else if builtins.substring 0 1 line != " " && builtins.substring 0 1 line != "\t" then
            paths
          else if lib.hasPrefix "path:" trimmed then
            collect {
              inherit inBlock;
              paths = paths ++ [ (lib.trim (lib.removePrefix "path:" trimmed)) ];
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
    Copy patch files from a lockfile, resolving source paths through workspaceSources.
    Each patch path is resolved at Nix eval time via absoluteSourcePathFor so that
    patches under workspaceSources prefixes are found in the correct source root.

    Note: the resolved source root (via builtins.path) snapshots the whole matched
    source tree, so this has the same invalidation scope as other copyFileCmd calls.
  */
  copyResolvedPatchFilesCmd =
    {
      lockfileContent,
      targetPrefix,
    }:
    let
      patchPaths = parsePatchPaths lockfileContent;
      copyOnePatch =
        relPath:
        let
          srcPath = absoluteSourcePathFor relPath;
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

  /**
    Copy patch files from an external install root's lockfile.
    These are self-contained (source and target share the same root), so shell-time
    awk parsing is fine — no workspaceSources resolution needed.
  */
  copyPatchedDependencyFilesCmd =
    {
      sourceRoot,
      targetPrefix,
    }:
    let
      sourceRootArg = lib.escapeShellArg (toString sourceRoot);
      targetPrefixArg = lib.escapeShellArg targetPrefix;
    in
    ''
      source_root=${sourceRootArg}
      target_prefix=${targetPrefixArg}

      if [ -f "$source_root/pnpm-lock.yaml" ]; then
        awk '
          /^patchedDependencies:/ { in_block = 1; next }
          in_block && $0 ~ /^[^[:space:]]/ { exit }
          in_block {
            line = $0
            sub(/^[[:space:]]+/, "", line)
            if (index(line, "path:") == 1) {
              sub(/^path:[[:space:]]*/, "", line)
              print line
            }
          }
        ' "$source_root/pnpm-lock.yaml" | while IFS= read -r rel_path; do
          [ -n "$rel_path" ] || continue

          target_rel_path="$rel_path"
          if [ -n "$target_prefix" ]; then
            target_rel_path="$target_prefix/$target_rel_path"
          fi

          mkdir -p "$out/$(dirname "$target_rel_path")"
          chmod -R +w "$out/$(dirname "$target_rel_path")" 2>/dev/null || true
          cp "$source_root/$rel_path" "$out/$target_rel_path"
        done
      fi
    '';

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
        lockfileContent = rootLockfileContent;
        targetPrefix = "";
      }
      + builtins.concatStringsSep "\n" (
        map (
          root:
          copyPatchedDependencyFilesCmd {
            sourceRoot = root.installSourceRoot;
            targetPrefix = root.installDir;
          }
        ) externalInstallRoots
      )
    );

  depsSrc = materializeWorkspace {
    nameSuffix = "pnpm-deps-src";
    manifestOnly = true;
  };

  workspaceClosureSrc = materializeWorkspace {
    nameSuffix = "workspace";
    manifestOnly = false;
  };

  pnpmDeps = pnpmDepsHelper.mkDeps {
    inherit name pnpmDepsHash;
    src = depsSrc;
    sourceRoot = ".";
    lockfilePaths = lib.sort (left: right: left < right) (
      [ "pnpm-lock.yaml" ] ++ map (root: "${root.installDir}/pnpm-lock.yaml") externalInstallRoots
    );
    preInstall = ''
      chmod -R +w .
    '';
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
pkgs.stdenv.mkDerivation {
  inherit name pnpmDeps;

  nativeBuildInputs = [
    pkgs.bun
    pkgs.nodejs
    # Downstream packages still use `pnpm exec ...` in postBuild hooks for
    # asset builds. Prepared-tree restore removes install-time pnpm work, but
    # the builder should still provide the package manager for those hooks.
    pnpm
    pkgs.zstd
  ]
  ++ lib.optionals (lockfileHash != null) [ pkgs.nix ];

  dontUnpack = true;
  dontFixup = true;

  buildPhase = ''
    set -euo pipefail
    runHook preBuild

    ${
      if lockfileHash != null then
        ''
          currentHash="sha256-$(nix-hash --type sha256 --base64 ${workspaceClosureSrc}/pnpm-lock.yaml)"
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

    echo "Copying filtered aggregate workspace..."
    cp -r ${workspaceClosureSrc} workspace
    chmod -R +w workspace
    ${pnpmDepsHelper.mkRestoreScript {
      deps = pnpmDeps;
      target = "workspace";
    }}
    chmod -R +w workspace

    cd workspace

    # Some downstream packages run `pnpm exec ...` in postBuild hooks for asset
    # pipelines. Keep those hooks sandbox-safe and deterministic by giving pnpm a
    # writable HOME and disabling its package-manager self-bootstrap behavior.
    export HOME=$(mktemp -d "$NIX_BUILD_TOP/pnpm-home.XXXXXX")
    export PNPM_HOME="$HOME/.local/share/pnpm"
    mkdir -p "$PNPM_HOME"
    printf '\nmanage-package-manager-versions=false\n' >> .npmrc

    cd ${packageDir}

    if [ -f "${entryRelativeToPackage}" ]; then
      substituteInPlace "${entryRelativeToPackage}" \
        --replace-quiet "const buildStamp = '__CLI_BUILD_STAMP__'" "const buildStamp = '${nixStampJson}'"
    fi

    echo "Building CLI..."
    mkdir -p output
    bun build ${entryRelativeToPackage} --compile ${lib.concatStringsSep " " extraBunBuildArgs} --outfile=output/${binaryName}

    if [ -n "${smokeTestArgsStr}" ]; then
      echo "Running smoke test..."
      ./output/${binaryName} ${smokeTestArgsStr}
    fi

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/bin"
    cp "$NIX_BUILD_TOP/workspace/${packageDir}/output/${binaryName}" "$out/bin/"
    runHook postInstall
  '';
}
