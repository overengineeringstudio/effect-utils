{ lib, workspaceRootPath, packageJson, packageDir }:

let
  # Collect local file dependencies so dirty builds can overlay them.
  localDependencyMap =
    (packageJson.dependencies or {})
    // (packageJson.devDependencies or {})
    // (packageJson.optionalDependencies or {});

  localDependencies =
    let
      isLocal = value:
        lib.hasPrefix "./" value
        || lib.hasPrefix "../" value
        || lib.hasPrefix "file:" value;
      normalize = value:
        if lib.hasPrefix "file:" value
        then lib.removePrefix "file:" value
        else value;
      normalizeRelativePath = depName: depValue: rootStr: path:
        let
          parts = lib.splitString "/" path;
          step = acc: part:
            if part == "" || part == "."
            then acc
            else if part == ".."
            # Fail fast when a local dependency escapes the workspace root.
            then if acc == []
            then throw "mk-bun-cli: local dependency ${depName} resolves outside the workspace root (value: ${depValue}, path: ${path}, packageDir: ${packageDir}, workspaceRoot: ${rootStr})"
            else lib.init acc
            else acc ++ [part];
        in
        lib.concatStringsSep "/" (lib.foldl' step [] parts);
      toWorkspaceRelPath = depName: depValue:
        let
          rawPath = normalize depValue;
          rootStr = toString workspaceRootPath;
        in
        if lib.hasPrefix "/" rawPath
        then
          if lib.hasPrefix (rootStr + "/") rawPath
          then lib.removePrefix (rootStr + "/") rawPath
          else throw "mk-bun-cli: local dependency ${depName} path ${rawPath} is outside the workspace root ${rootStr}"
        else normalizeRelativePath depName depValue rootStr "${packageDir}/${rawPath}";
    in
    lib.mapAttrsToList
      (depName: depValue: {
        name = depName;
        workspacePath = toWorkspaceRelPath depName depValue;
      })
      (lib.filterAttrs (_: value: isLocal value) localDependencyMap);

  # Install local dependency node_modules inside the bunDeps snapshot so dirty builds
  # can link them without reaching outside the Nix store.
  localDependenciesInstallScript = lib.concatStringsSep "\n" (map
    (dep: ''
      dep_name=${lib.escapeShellArg dep.name}
      dep_rel=${lib.escapeShellArg dep.workspacePath}
      dep_path="$workspace/$dep_rel"
      if [ ! -f "$dep_path/package.json" ]; then
        echo "mk-bun-cli: missing package.json for local dependency $dep_name at $dep_path" >&2
        exit 1
      fi
      if [ ! -f "$dep_path/bun.lock" ]; then
        echo "mk-bun-cli: missing bun.lock for local dependency $dep_name at $dep_path" >&2
        exit 1
      fi

      bun_install_checked "$dep_path" "$dep_name"
    '')
    localDependencies);

  localDependenciesCopyScript = lib.concatStringsSep "\n" (map
    (dep: ''
      dep_name=${lib.escapeShellArg dep.name}
      dep_rel=${lib.escapeShellArg dep.workspacePath}
      dep_path="$PWD/workspace/$dep_rel"
      dep_node_modules="$dep_path/node_modules"
      if [ ! -d "$dep_node_modules" ]; then
        echo "mk-bun-cli: local dependency $dep_name did not produce node_modules" >&2
        exit 1
      fi
      mkdir -p "$out/local-node-modules/$dep_rel"
      cp -R -L "$dep_node_modules" "$out/local-node-modules/$dep_rel/node_modules"
    '')
    localDependencies);

  localDependenciesLinkScript = lib.concatStringsSep "\n" (map
    (dep: ''
      dep_name=${lib.escapeShellArg dep.name}
      dep_rel=${lib.escapeShellArg dep.workspacePath}
      dep_source="$workspace/$dep_rel"
      dep_node_modules_source="$bun_deps/local-node-modules/$dep_rel/node_modules"
      if [ ! -d "$dep_source" ]; then
        echo "mk-bun-cli: local dependency $dep_name not found at $dep_source" >&2
        exit 1
      fi
      if [ ! -d "$dep_node_modules_source" ]; then
        echo "mk-bun-cli: missing node_modules for local dependency $dep_name at $dep_node_modules_source" >&2
        exit 1
      fi

      dep_target="$package_path/node_modules/$dep_name"
      mkdir -p "$(dirname "$dep_target")"
      rm -rf "$dep_target"
      ln -s "$dep_source" "$dep_target"
      case "$dep_source" in
        "$workspace"/*)
          if [ ! -e "$dep_source/node_modules" ]; then
            ln -s "$dep_node_modules_source" "$dep_source/node_modules"
          fi
          ;;
      esac
    '')
    localDependencies);
in
{
  inherit
    localDependencies
    localDependenciesInstallScript
    localDependenciesCopyScript
    localDependenciesLinkScript;
}
