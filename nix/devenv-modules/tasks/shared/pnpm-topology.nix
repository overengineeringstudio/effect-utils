{
  packages,
  globalCache ? true,
  topologyRoot ? ".topologies",
}:
{
  lib,
  config,
  pkgs,
  ...
}:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cache = import ../lib/cache.nix { inherit config; };
  cacheRoot = cache.mkCachePath "pnpm-topology-install";
  flock = "${pkgs.flock}/bin/flock";
  rsync = "${pkgs.rsync}/bin/rsync";
  jq = "${pkgs.jq}/bin/jq";
  rm = "${pkgs.coreutils}/bin/rm";
  ln = "${pkgs.coreutils}/bin/ln";
  mkdir = "${pkgs.coreutils}/bin/mkdir";
  cp = "${pkgs.coreutils}/bin/cp";
  dirnameBin = "${pkgs.coreutils}/bin/dirname";
  find = "${pkgs.findutils}/bin/find";
  sha256sum = "${pkgs.coreutils}/bin/sha256sum";

  sanitize = s: builtins.replaceStrings [ "/" "." "@" ] [ "-" "-" "" ] s;

  baseName =
    path:
    let
      repoStripped =
        let
          m = builtins.match "repos/[^/]+/packages/(.*)" path;
        in
        if m != null then builtins.head m else path;
      stripped = lib.removePrefix "apps/" (lib.removePrefix "packages/" repoStripped);
      m = builtins.match "@[^/]+/(.*)" stripped;
      final = if m != null then builtins.head m else stripped;
    in
    sanitize final;

  disambiguatedName =
    path:
    let
      repoMatch = builtins.match "repos/([^/]+)/(.*)" path;
      repo = if repoMatch == null then null else builtins.elemAt repoMatch 0;
      repoRelative = if repoMatch == null then path else builtins.elemAt repoMatch 1;
      stripped = lib.removePrefix "apps/" (lib.removePrefix "packages/" repoRelative);
      scopeMatch = builtins.match "@([^/]+)/(.*)" stripped;
      scope = if scopeMatch == null then null else builtins.elemAt scopeMatch 0;
      rest = if scopeMatch == null then stripped else builtins.elemAt scopeMatch 1;
      pieces = lib.filter (x: x != null && x != "") [ repo scope rest ];
    in
    sanitize (lib.concatStringsSep "-" pieces);

  baseTaskNames = map baseName packages;
  duplicateBaseTaskNames = lib.filterAttrs (_: names: builtins.length names > 1) (lib.groupBy (n: n) baseTaskNames);
  toName =
    path:
    let
      name = baseName path;
    in
    if (duplicateBaseTaskNames.${name} or null) != null then disambiguatedName path else name;

  packageTaskNames = map toName packages;
  duplicateTaskNames = lib.filterAttrs (_: names: builtins.length names > 1) (lib.groupBy (n: n) packageTaskNames);
  duplicateTaskNameLines = lib.mapAttrsToList (
    taskName: _:
    let
      conflictingPaths = lib.filter (path: toName path == taskName) packages;
    in
    "- ${taskName}: ${lib.concatStringsSep ", " conflictingPaths}"
  ) duplicateTaskNames;
  ensureUniqueTaskNames =
    if duplicateTaskNames == { } then
      true
    else
      throw ''
        pnpm-topology task name collision detected.
        Conflicting task names (derived from package paths):
        ${lib.concatStringsSep "\n" duplicateTaskNameLines}
      '';

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

  trim = s: lib.removeSuffix "\r" (lib.removeSuffix "\n" (lib.trim s));

  parseWorkspaceMembers =
    path:
    let
      yamlPath = "${config.devenv.root}/${path}/pnpm-workspace.yaml";
      hasYaml = builtins.pathExists yamlPath;
      content = if hasYaml then builtins.readFile yamlPath else "";
      lines = lib.splitString "\n" content;
      packagesLine = lib.findFirst (line: lib.hasPrefix "packages:" (lib.trim line)) null lines;
      packagesLineTrimmed = if packagesLine == null then "" else lib.trim packagesLine;
      isPackagesInline = packagesLine != null && lib.hasPrefix "packages: [" packagesLineTrimmed;

      parsePackagesInline =
        let
          packagesArrayStr = lib.removePrefix "packages: " packagesLine;
          packagesInner = lib.removeSuffix "]" (lib.removePrefix "[" packagesArrayStr);
        in
        builtins.filter (s: s != "") (map trim (lib.splitString "," packagesInner));

      dropUntilPackagesHeader =
        remainingLines:
        if remainingLines == [ ] then
          [ ]
        else if lib.hasPrefix "packages:" (lib.trim (builtins.head remainingLines)) then
          lib.tail remainingLines
        else
          dropUntilPackagesHeader (lib.tail remainingLines);

      workspaceLinesAfterPackagesHeader = dropUntilPackagesHeader lines;

      takeIndented =
        remainingLines:
        if remainingLines == [ ] then
          [ ]
        else if lib.hasPrefix " " (builtins.head remainingLines) || builtins.head remainingLines == "" then
          [ (builtins.head remainingLines) ] ++ takeIndented (lib.tail remainingLines)
        else
          [ ];

      parsePackagesMultiline =
        let
          firstContentLine = lib.findFirst (line: lib.trim line != "") "" workspaceLinesAfterPackagesHeader;
          isBracketFormat = lib.hasInfix "[" firstContentLine;
        in
        if isBracketFormat then
          let
            indentedLines = takeIndented workspaceLinesAfterPackagesHeader;
            joined = builtins.concatStringsSep "\n" indentedLines;
            afterOpen = builtins.elemAt (lib.splitString "[" joined) 1;
            inner = builtins.elemAt (lib.splitString "]" afterOpen) 0;
            items = lib.splitString "," inner;
          in
          builtins.filter (s: s != "") (map (s: trim (lib.removeSuffix "," (trim s))) items)
        else
          let
            parseLines =
              remainingLines:
              if remainingLines == [ ] then
                [ ]
              else
                let
                  line = trim (builtins.head remainingLines);
                  rest = lib.tail remainingLines;
                in
                if line == "" || lib.hasPrefix "#" line then
                  parseLines rest
                else if lib.hasPrefix "- " line then
                  [ trim (lib.removePrefix "- " line) ] ++ parseLines rest
                else if lib.hasPrefix "-" line then
                  [ trim (lib.removePrefix "-" line) ] ++ parseLines rest
                else
                  [ ];
          in
          parseLines workspaceLinesAfterPackagesHeader;

      items =
        if !hasYaml then
          [ ]
        else if isPackagesInline then
          parsePackagesInline
        else
          parsePackagesMultiline;
    in
    builtins.filter (item: item != "." && item != "") (map (relPath: resolveRelativePath path relPath) items);

  getPathDepValues =
    deps:
    let
      names = builtins.attrNames deps;
      values = map (name: deps.${name}) names;
    in
    builtins.filter (
      value:
      builtins.isString value
      && (lib.hasPrefix "file:" value || lib.hasPrefix "link:" value)
    ) values;

  getLocalPathDeps =
    path:
    let
      pkgJsonPath = "${config.devenv.root}/${path}/package.json";
      pkgJson = builtins.fromJSON (builtins.readFile pkgJsonPath);
      depValues =
        builtins.concatLists [
          (getPathDepValues (pkgJson.dependencies or { }))
          (getPathDepValues (pkgJson.devDependencies or { }))
          (getPathDepValues (pkgJson.optionalDependencies or { }))
        ];
      resolveSpec =
        spec:
        let
          rel = lib.removePrefix "file:" (lib.removePrefix "link:" spec);
          resolved = resolveRelativePath path rel;
          packageJsonPath' = "${config.devenv.root}/${resolved}/package.json";
        in
        if builtins.pathExists packageJsonPath' then resolved else null;
    in
    builtins.filter (p: p != null) (map resolveSpec depValues);

  supportPathsFor =
    topologyPaths:
    let
      repoRoots = lib.unique (
        builtins.filter (p: p != null) (
          map (
            path:
            let
              match = builtins.match "(repos/[^/]+).*" path;
            in
            if match == null then null else builtins.elemAt match 0
          ) topologyPaths
        )
      );
      maybeSupportPath =
        repoRoot: name:
        let
          relPath = "${repoRoot}/${name}";
        in
        if builtins.pathExists "${config.devenv.root}/${relPath}" then relPath else null;
    in
    lib.unique (
      builtins.filter (p: p != null) (
        builtins.concatLists (
          map (repoRoot: [
            (maybeSupportPath repoRoot "tsconfig.base.json")
            (maybeSupportPath repoRoot "patches")
          ]) repoRoots
        )
      )
    );

  packageNameToPath = builtins.listToAttrs (
    builtins.filter (x: x != null) (
      map (
        path:
        let
          pkgJsonPath = "${config.devenv.root}/${path}/package.json";
          pkgJsonExists = builtins.pathExists pkgJsonPath;
          pkgJson = if pkgJsonExists then builtins.fromJSON (builtins.readFile pkgJsonPath) else { };
          name = pkgJson.name or null;
        in
        if name != null then
          {
            inherit name;
            value = path;
          }
        else
          null
      ) packages
    )
  );

  getInjectedDeps =
    path:
    let
      pkgJsonPath = "${config.devenv.root}/${path}/package.json";
      pkgJson = builtins.fromJSON (builtins.readFile pkgJsonPath);
      depsMeta = pkgJson.dependenciesMeta or { };
      injectedNames = builtins.filter (name: (depsMeta.${name}.injected or false) == true) (builtins.attrNames depsMeta);
    in
    builtins.filter (p: p != null) (map (name: packageNameToPath.${name} or null) injectedNames);

  packagesWithPrev =
    assert ensureUniqueTaskNames;
    lib.imap0 (
      i: path:
      let
        workspaceMembers = parseWorkspaceMembers path;
        localPathDeps = getLocalPathDeps path;
        topologyPeers = lib.unique (workspaceMembers ++ localPathDeps);
      in
      {
        inherit path workspaceMembers localPathDeps topologyPeers;
        supportPaths = supportPathsFor topologyPeers;
        name = toName path;
        prevName = if i == 0 then null else toName (builtins.elemAt packages (i - 1));
        injected = getInjectedDeps path;
      }
    ) packages;

  computeHashFn = ''
    compute_hash() {
      ${sha256sum} | awk '{print $1}'
    }
  '';

  mkComputeCacheHash =
    {
      peerPackageJsons,
      injected,
      resultVar,
    }:
    let
      peerFiles = lib.escapeShellArgs peerPackageJsons;
      injectedSrcs = lib.concatMapStringsSep " " (dep: "\"$DEVENV_ROOT/${dep}/src\"") injected;
    in
    ''
      if [ -f pnpm-lock.yaml ]; then
        base_hash="$(cat package.json pnpm-lock.yaml | compute_hash)"
      else
        base_hash="$(cat package.json | compute_hash)"
      fi

      peer_hash="$(
        for rel in ${peerFiles}; do
          if [ -f "$DEVENV_ROOT/$rel" ]; then
            cat "$DEVENV_ROOT/$rel"
          fi
        done | compute_hash
      )"
      ${if peerPackageJsons == [ ] then "" else ''base_hash="$base_hash $peer_hash"''}

      ${
        if injected == [ ] then
          ''
            ${resultVar}="$base_hash"
          ''
        else
          ''
            injected_hash="$(${find} ${injectedSrcs} -type f \\( -name "*.ts" -o -name "*.tsx" \\) -exec cat {} + 2>/dev/null | compute_hash)"
            ${resultVar}="$base_hash $injected_hash"
          ''
      }
    '';

  cleanExcludeArgs = lib.concatMapStringsSep " " (name: "--exclude=${lib.escapeShellArg name}") [
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

  mkMaterializeScript =
    {
      path,
      name,
      workspaceMembers,
      localPathDeps,
      supportPaths,
    }:
    let
      workspaceArgs = lib.escapeShellArgs workspaceMembers;
      localPathArgs = lib.escapeShellArgs localPathDeps;
      supportArgs = lib.escapeShellArgs supportPaths;
    in
    ''
      topology_dir="$DEVENV_ROOT/${topologyRoot}/${name}"
      package_dir="$topology_dir/${path}"

      copy_tree() {
        local rel="$1"
        ${mkdir} -p "$topology_dir/$(${dirnameBin} "$rel")"
        ${rsync} -aL ${cleanExcludeArgs} "$DEVENV_ROOT/$rel/" "$topology_dir/$rel/"
      }

      copy_support() {
        local rel="$1"
        if [ -d "$DEVENV_ROOT/$rel" ]; then
          copy_tree "$rel"
        elif [ -f "$DEVENV_ROOT/$rel" ]; then
          ${mkdir} -p "$topology_dir/$(${dirnameBin} "$rel")"
          ${cp} "$DEVENV_ROOT/$rel" "$topology_dir/$rel"
        fi
      }

      sanitize_member() {
        local rel="$1"
        local member_dir="$topology_dir/$rel"
        if [ -f "$member_dir/package.json" ]; then
          ${jq} '{name, version, type, exports} | with_entries(select(.value != null))' \
            "$member_dir/package.json" > "$member_dir/package.json.tmp"
          mv "$member_dir/package.json.tmp" "$member_dir/package.json"
        fi
        ${rm} -f "$member_dir/pnpm-lock.yaml" "$member_dir/pnpm-workspace.yaml" "$member_dir/.npmrc"
      }

      ${rm} -rf "$topology_dir"
      copy_tree "${path}"
      for rel in ${workspaceArgs}; do
        copy_tree "$rel"
        sanitize_member "$rel"
      done
      for rel in ${localPathArgs}; do
        copy_tree "$rel"
      done
      for rel in ${supportArgs}; do
        copy_support "$rel"
      done
    '';

  mkInstallTask =
    {
      path,
      name,
      prevName,
      workspaceMembers,
      localPathDeps,
      supportPaths,
      injected,
      ...
    }:
    let
      peerPackageJsons = map (rel: "${rel}/package.json") (lib.unique (workspaceMembers ++ localPathDeps));
      materializeScript = mkMaterializeScript {
        inherit path name workspaceMembers localPathDeps supportPaths;
      };
    in
    {
      "pnpm:install:${name}" = {
        description = "Install dependencies for ${name} via explicit topology projection";
        exec = trace.exec "pnpm:install:${name}" ''
          set -euo pipefail
          mkdir -p "${cacheRoot}"
          hash_file="${cacheRoot}/${name}.hash"

          lockfile="${cacheRoot}/pnpm-install.lock"
          exec 200>"$lockfile"
          if ! ${flock} -w 600 200; then
            echo "[pnpm] Install lock timeout after 600s: $lockfile" >&2
            exit 1
          fi

          ${materializeScript}

          cd "$topology_dir/${path}"
          if [ -n "''${CI:-}" ]; then
            pnpm install --config.confirmModulesPurge=false --frozen-lockfile
          else
            pnpm install --config.confirmModulesPurge=false
          fi

          ${rm} -rf "$DEVENV_ROOT/${path}/node_modules"
          ${ln} -sfn "$topology_dir/${path}/node_modules" "$DEVENV_ROOT/${path}/node_modules"

          ${computeHashFn}
          ${mkComputeCacheHash {
            inherit peerPackageJsons injected;
            resultVar = "cache_value";
          }}
          ${cache.writeCacheFile ''"$hash_file"''}
        '';
        cwd = path;
        after = if prevName == null then [ ] else [ "pnpm:install:${prevName}" ];
        status = trace.status "pnpm:install:${name}" "hash" ''
          set -euo pipefail
          hash_file="${cacheRoot}/${name}.hash"
          if [ ! -L "node_modules" ] && [ ! -d "node_modules" ]; then
            exit 1
          fi
          if [ ! -f "$hash_file" ]; then
            exit 1
          fi
          ${computeHashFn}
          ${mkComputeCacheHash {
            inherit peerPackageJsons injected;
            resultVar = "current_hash";
          }}
          stored_hash="$(cat "$hash_file")"
          if [ "$current_hash" != "$stored_hash" ]; then
            exit 1
          fi
          exit 0
        '';
      };
    };

  topologyPaths = map (pkg: "${topologyRoot}/${pkg.name}") packagesWithPrev;
  nodeModulesPaths = lib.concatMapStringsSep " " (p: "${p}/node_modules") packages;
  lockFilePaths = lib.concatMapStringsSep " " (p: "${p}/pnpm-lock.yaml") packages;
  pnpmStorePath = "${config.devenv.root}/.pnpm-store";

  mkUpdateStep =
    pkg:
    let
      materializeScript = mkMaterializeScript {
        inherit (pkg) path name workspaceMembers localPathDeps supportPaths;
      };
    in
    ''
      echo "Updating ${pkg.path}..."
      (
        set -euo pipefail
        ${materializeScript}
        cd "$topology_dir/${pkg.path}"
        pnpm install --fix-lockfile --config.confirmModulesPurge=false
        ${cp} pnpm-lock.yaml "$DEVENV_ROOT/${pkg.path}/pnpm-lock.yaml"
        ${rm} -rf "$DEVENV_ROOT/${pkg.path}/node_modules"
        ${ln} -sfn "$topology_dir/${pkg.path}/node_modules" "$DEVENV_ROOT/${pkg.path}/node_modules"
      ) || echo "Warning: ${pkg.path} update failed"
    '';

  updateScript = lib.concatStringsSep "\n" (map mkUpdateStep packagesWithPrev);
in
{
  enterShell = lib.mkIf globalCache ''
    export npm_config_cache="$HOME/.cache/pnpm"
  '';

  tasks = lib.mkMerge (
    map mkInstallTask packagesWithPrev
    ++ [
      {
        "pnpm:install" = {
          description = "Install all pnpm dependencies";
          exec = "echo 'All pnpm topology packages installed'";
          after = map (p: "pnpm:install:${toName p}") packages;
        };
        "pnpm:update" = {
          description = "Update all pnpm lockfiles through topology projections";
          after = [ "genie:run" ];
          exec = trace.exec "pnpm:update" ''
            echo "Updating pnpm lockfiles for all topology packages..."
            ${updateScript}
            echo "Lockfiles updated. Run 'dt nix:hash' to update Nix hashes."
          '';
        };
        "pnpm:clean" = {
          description = "Remove node_modules and topology projections for all managed packages";
          exec = trace.exec "pnpm:clean" "rm -rf ${nodeModulesPaths} ${config.devenv.root}/${topologyRoot} ${pnpmStorePath}";
        };
        "pnpm:reset-lock-files" = {
          description = "Remove pnpm lock files for all managed packages (destructive)";
          exec = trace.exec "pnpm:reset-lock-files" "rm -f ${lockFilePaths}";
        };
      }
    ]
  );
}
