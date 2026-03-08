{ pkgs }:

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
  smokeTestArgs ? [ "--help" ],
  extraBunBuildArgs ? [ ],
}:

let
  lib = pkgs.lib;
  pnpmDepsHelper = import ./mk-pnpm-deps.nix { inherit pkgs; };

  workspaceRootPath =
    if builtins.isAttrs workspaceRoot && builtins.hasAttr "outPath" workspaceRoot then
      workspaceRoot.outPath
    else if builtins.isPath workspaceRoot then
      workspaceRoot
    else
      builtins.toPath workspaceRoot;

  normalizeSourceRoot =
    sourceRoot:
    if builtins.isAttrs sourceRoot && builtins.hasAttr "outPath" sourceRoot then
      sourceRoot.outPath
    else if builtins.isPath sourceRoot then
      sourceRoot
    else
      builtins.toPath sourceRoot;

  workspaceSourceRoots = lib.mapAttrs (_: normalizeSourceRoot) workspaceSources;
  workspaceSourcePrefixes = lib.sort (
    left: right: lib.stringLength left > lib.stringLength right
  ) (builtins.attrNames workspaceSourceRoots);

  resolveSourceFor =
    relPath:
    let
      prefix = lib.findFirst (
        candidate: relPath == candidate || lib.hasPrefix "${candidate}/" relPath
      ) null workspaceSourcePrefixes;
      sourceRoot = if prefix == null then workspaceRootPath else workspaceSourceRoots.${prefix};
      sourceRelPath =
        if prefix == null then
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

  rootPnpmWorkspaceYamlPath = workspaceRootPath + "/pnpm-workspace.yaml";
  rootPnpmWorkspaceYaml = builtins.readFile rootPnpmWorkspaceYamlPath;
  rootPnpmLockPath = workspaceRootPath + "/pnpm-lock.yaml";
  rootPnpmLock = builtins.readFile rootPnpmLockPath;

  packagePnpmWorkspaceYamlPath = workspaceRootPath + "/${packageDir}/pnpm-workspace.yaml";
  packagePnpmWorkspaceYaml = builtins.readFile packagePnpmWorkspaceYamlPath;

  parsePatchedDependencyPaths =
    lockfileYaml:
    let
      lockfileLines = lib.splitString "\n" lockfileYaml;

      dropUntilPatchedDependencies =
        lines:
        if lines == [ ] then
          [ ]
        else if lib.trim (builtins.head lines) == "patchedDependencies:" then
          lib.tail lines
        else
          dropUntilPatchedDependencies (lib.tail lines);

      takePatchedDependenciesBlock =
        lines:
        if lines == [ ] then
          [ ]
        else
          let
            line = builtins.head lines;
            trimmed = lib.trim line;
          in
          if trimmed != "" && !(lib.hasPrefix " " line) then
            [ ]
          else
            [ line ] ++ takePatchedDependenciesBlock (lib.tail lines);
    in
    builtins.filter
      (path: path != "")
      (
        map
          (
            line:
            let
              trimmed = lib.trim line;
            in
            if lib.hasPrefix "path:" trimmed then
              lib.trim (lib.removePrefix "path:" trimmed)
            else
              ""
          )
          (takePatchedDependenciesBlock (dropUntilPatchedDependencies lockfileLines))
      );

  parseWorkspacePackages =
    workspaceYaml:
    let
      workspaceLines = lib.splitString "\n" workspaceYaml;
      packagesLine = lib.findFirst (line: lib.hasPrefix "packages:" line) null workspaceLines;
      packagesLineTrimmed = if packagesLine == null then "" else lib.trim packagesLine;
      isPackagesInline = packagesLine != null && lib.hasPrefix "packages: [" packagesLineTrimmed;

      parsePackagesInline =
        let
          packagesArrayStr = lib.removePrefix "packages: " packagesLine;
          packagesInner = lib.removeSuffix "]" (lib.removePrefix "[" packagesArrayStr);
        in
        map (s: lib.trim s) (lib.splitString "," packagesInner);

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

      parsePackagesMultiline =
        let
          lines = workspaceLinesAfterPackagesHeader;
          firstContentLine = lib.findFirst (line: lib.trim line != "") "" lines;
          isBracketFormat = lib.hasInfix "[" firstContentLine;
        in
        if isBracketFormat then
          let
            takeWhile =
              pred: lst:
              if lst == [ ] then
                [ ]
              else if pred (builtins.head lst) then
                [ (builtins.head lst) ] ++ takeWhile pred (lib.tail lst)
              else
                [ ];
            indentedLines = takeWhile (line: lib.hasPrefix " " line || line == "") lines;
            joined = builtins.concatStringsSep "\n" indentedLines;
            afterOpen = builtins.elemAt (lib.splitString "[" joined) 1;
            inner = builtins.elemAt (lib.splitString "]" afterOpen) 0;
            items = lib.splitString "," inner;
          in
          builtins.filter (s: s != "") (map (s: lib.trim (lib.removeSuffix "," (lib.trim s))) items)
        else
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
    in
    builtins.filter builtins.isString (
      if isPackagesInline then parsePackagesInline else parsePackagesMultiline
    );

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
    in
    dropPackageBlock (dropUntilPackagesHeader (lib.splitString "\n" workspaceYaml));

  formatWorkspaceYaml =
    packageDirs: suffixLines:
    let
      packagesBlock = builtins.concatStringsSep "\n" ([ "packages:" ] ++ map (dir: "  - ${dir}") packageDirs);
      suffix = builtins.concatStringsSep "\n" suffixLines;
    in
    if suffix == "" then
      "${packagesBlock}\n"
    else
      "${packagesBlock}\n\n${suffix}\n";

  workspaceMemberItems = parseWorkspacePackages packagePnpmWorkspaceYaml;
  relativeWorkspaceMembers = builtins.filter (s: s != ".") workspaceMemberItems;

  resolveRelativePath =
    basePath: relPath:
    let
      baseParts = lib.splitString "/" basePath;
      relParts = lib.splitString "/" relPath;
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
      remainingParts = lib.drop upCount relParts;
      resolvedBase = lib.take (lib.length baseParts - upCount) baseParts;
    in
    lib.concatStringsSep "/" (resolvedBase ++ remainingParts);

  resolvedWorkspaceMembers = map (
    relPath:
    let
      dir = resolveRelativePath packageDir relPath;
    in
    {
      inherit dir;
      resolved = resolveSourceFor dir;
    }
  ) relativeWorkspaceMembers;

  workspaceMembers = map (item: item.dir) resolvedWorkspaceMembers;
  workspaceClosureDirs = lib.unique ([ packageDir ] ++ workspaceMembers);
  stagedWorkspaceMembers =
    lib.unique (
      [ packageDir ]
      ++ builtins.filter (
        dir:
        let
          resolved = resolveSourceFor dir;
        in
        resolved.prefix == null
      ) workspaceMembers
    );

  externalInstallRoots =
    builtins.filter
      (root: root.memberDirs != [ ])
      (map
        (
          prefix:
          let
            memberItems = builtins.filter (item: item.resolved.prefix == prefix) resolvedWorkspaceMembers;
            sourceRoot = workspaceSourceRoots.${prefix};
            sourcePnpmWorkspaceYaml = builtins.readFile (sourceRoot + "/pnpm-workspace.yaml");
            sourcePnpmLock = builtins.readFile (sourceRoot + "/pnpm-lock.yaml");
          in
          {
            inherit prefix sourceRoot;
            memberDirs = lib.unique (map (item: item.dir) memberItems);
            sourceRelMemberDirs = lib.unique (map (item: item.resolved.sourceRelPath) memberItems);
            patchedDependencyPaths = parsePatchedDependencyPaths sourcePnpmLock;
            filteredPnpmWorkspaceYaml =
              formatWorkspaceYaml
                (lib.unique (map (item: item.resolved.sourceRelPath) memberItems))
                (workspaceSuffixLines sourcePnpmWorkspaceYaml);
          }
        )
        workspaceSourcePrefixes);

  filteredRootPnpmWorkspaceYaml = formatWorkspaceYaml stagedWorkspaceMembers (workspaceSuffixLines rootPnpmWorkspaceYaml);
  rootPatchedDependencyPaths = parsePatchedDependencyPaths rootPnpmLock;
  stagedPatchFiles =
    lib.unique (
      rootPatchedDependencyPaths
      ++ lib.concatMap (
        root: map (path: "${root.prefix}/${path}") root.patchedDependencyPaths
      ) externalInstallRoots
    );

  rootWorkspaceFiles = [ "package.json" "pnpm-lock.yaml" ];
  optionalRootWorkspaceFiles = [ ".npmrc" "tsconfig.base.json" ];

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
        map
          (
            root:
            builtins.concatStringsSep "\n" (
              (map (file: copyFileCmd "${root.prefix}/${file}") rootWorkspaceFiles)
              ++ (map (file: copyOptionalFileCmd "${root.prefix}/${file}") optionalRootWorkspaceFiles)
              ++ [
                ''
                  mkdir -p "$out/${root.prefix}"
                  cat > "$out/${root.prefix}/pnpm-workspace.yaml" <<'EOF'
${root.filteredPnpmWorkspaceYaml}
EOF
                ''
              ]
            )
          )
          externalInstallRoots
      )
      + builtins.concatStringsSep "\n" (
        if manifestOnly then
          map (dir: copyFileCmd "${dir}/package.json") workspaceClosureDirs
        else
          map copyDirCmd workspaceClosureDirs
      )
      + builtins.concatStringsSep "\n" (map copyFileCmd stagedPatchFiles)
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
    extraInstallRoots = map (root: root.prefix) externalInstallRoots;
    lockfilePaths = [ "pnpm-lock.yaml" ] ++ map (root: "${root.prefix}/pnpm-lock.yaml") externalInstallRoots;
    preInstall = ''
      chmod -R +w .
    '';
  };

  packageJsonPath = workspaceRootPath + "/${packageDir}/package.json";
  packageJson = builtins.fromJSON (builtins.readFile packageJsonPath);
  packageVersion = packageJson.version or "0.0.0";
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
    pkgs.pnpm
    pkgs.nodejs
    pkgs.bun
    pkgs.cacert
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

    ${pnpmDepsHelper.mkRestoreScript { deps = pnpmDeps; }}

    echo "Copying filtered aggregate workspace..."
    cp -r ${workspaceClosureSrc} workspace
    chmod -R +w workspace
    cd workspace

    echo "Installing aggregate workspace..."
    pnpm install --offline --frozen-lockfile --ignore-scripts

    ${builtins.concatStringsSep "\n" (
      map
        (
          root:
          ''
            echo "Installing external workspace root: ${root.prefix}..."
            (
              cd ${lib.escapeShellArg root.prefix}
              pnpm install --offline --frozen-lockfile --ignore-scripts
            )
          ''
        )
        externalInstallRoots
    )}

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
