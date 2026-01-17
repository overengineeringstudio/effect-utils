# Dotdot-first Bun CLI builder.
#
# Design goals:
# - Build native Bun binaries from TypeScript quickly and deterministically.
# - Work inside dotdot workspaces (local peer repos + uncommitted changes).
# - Keep builds pure (no --impure) and avoid shipping node_modules.
# - Fail early with clear errors and a smoke test.
#
# Arguments:
# - name: Derivation name and default binary name.
# - entry: CLI entry file relative to workspaceRoot.
# - packageDir: Package directory relative to workspaceRoot.
# - workspaceRoot: Dotdot workspace root (flake input or path).
# - bunDepsHash: Fixed-output hash for Bun deps snapshot.
# - binaryName: Output binary name (defaults to name).
# - packageJsonPath: package.json path relative to workspaceRoot (defaults to <packageDir>/package.json).
# - gitRev: Version suffix (defaults to "unknown").
# - typecheck: Run tsc --noEmit (defaults to true).
# - typecheckTsconfig: Tsconfig path relative to workspaceRoot (defaults to <packageDir>/tsconfig.json).
# - smokeTestArgs: Args for smoke test (defaults to ["--help"]).
# - smokeTestCwd: Relative working directory for the smoke test (defaults to build root).
# - smokeTestSetup: Shell snippet to prepare the smoke test working dir (optional).
# - extraExcludedSourceNames: Extra top-level paths to omit from the staged workspace.
# - dirty: When true, link bunDeps and overlay local file deps (defaults to false).
{ pkgs, pkgsUnstable }:

{
  name,
  entry,
  packageDir,
  workspaceRoot,
  bunDepsHash,
  binaryName ? name,
  packageJsonPath ? "${packageDir}/package.json",
  gitRev ? "unknown",
  typecheck ? true,
  typecheckTsconfig ? null,
  smokeTestArgs ? [ "--help" ],
  smokeTestCwd ? null,
  smokeTestSetup ? null,
  extraExcludedSourceNames ? [],
  dirty ? false,
}:

let
  lib = pkgs.lib;

  # Resolve flake inputs or paths into a concrete filesystem path.
  toPath = source:
    if builtins.isAttrs source && builtins.hasAttr "outPath" source
    then source.outPath
    else if builtins.isPath source
    then source
    else builtins.toPath source;

  workspaceRootPath =
    if workspaceRoot == null
    then throw "mk-bun-cli: workspaceRoot is required"
    else toPath workspaceRoot;

  # Keep the staged workspace lean (skip caches, outputs, and node_modules).
  defaultExcludedSourceNames = [
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
  excludedSourceNames = lib.unique (defaultExcludedSourceNames ++ extraExcludedSourceNames);

  sourceFilter = root: path: type:
    let
      rootStr = toString root;
      pathStr = toString path;
      relPath =
        if pathStr == rootStr
        then ""
        else lib.removePrefix (rootStr + "/") pathStr;
      parts = if relPath == "" then [] else lib.splitString "/" relPath;
      # Only exclude result* at the workspace root to avoid filtering real files.
      topLevel = if parts == [] then "" else builtins.head parts;
      hasExcluded = lib.any
        (segment: lib.elem segment excludedSourceNames)
        parts
        || topLevel == "result";
    in
    lib.cleanSourceFilter path type && !hasExcluded;

  workspaceSrc = lib.cleanSourceWith {
    src = workspaceRootPath;
    filter = sourceFilter workspaceRootPath;
  };

  packageJsonFullPath = workspaceSrc + "/${packageJsonPath}";
  packageJson = builtins.fromJSON (builtins.readFile packageJsonFullPath);
  baseVersion = packageJson.version or "0.0.0";
  fullVersion = if gitRev == "unknown" then baseVersion else "${baseVersion}+${gitRev}";

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
      normalizeRelativePath = path:
        let
          parts = lib.splitString "/" path;
          step = acc: part:
            if part == "" || part == "."
            then acc
            else if part == ".."
            then lib.init acc
            else acc ++ [part];
        in
        lib.concatStringsSep "/" (lib.foldl' step [] parts);
      toWorkspaceRelPath = value:
        let
          rawPath = normalize value;
          rootStr = toString workspaceRootPath;
        in
        if lib.hasPrefix "/" rawPath
        then
          if lib.hasPrefix (rootStr + "/") rawPath
          then lib.removePrefix (rootStr + "/") rawPath
          else throw "mk-bun-cli: local dependency path is outside the workspace root"
        else normalizeRelativePath "${packageDir}/${rawPath}";
    in
    lib.mapAttrsToList
      (depName: depValue: {
        name = depName;
        workspacePath = toWorkspaceRelPath depValue;
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
      dep_node_modules_source="${bunDeps}/local-node-modules/$dep_rel/node_modules"
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

  # Skip typechecking in dirty mode to avoid TS6305 when referenced builds are absent.
  typecheckEnabled = typecheck && !dirty;

  typecheckTsconfigChecked =
    if typecheckEnabled
    then
      if typecheckTsconfig != null
      then typecheckTsconfig
      else "${builtins.dirOf packageJsonPath}/tsconfig.json"
    else typecheckTsconfig;

  smokeTestArgsChecked = lib.escapeShellArgs smokeTestArgs;
  smokeTestSetupChecked = lib.optionalString (smokeTestSetup != null) smokeTestSetup;

  # Stage a writable copy so Bun and tsc can write caches in the sandbox.
  stageWorkspace = ''
    workspace="$PWD/workspace"
    mkdir -p "$workspace"
    (cd "${workspaceSrc}" && tar -cf - .) | (cd "$workspace" && tar -xf -)
    chmod -R u+w "$workspace"
  '';

  bunDeps =
    if bunDepsHash == null
    then throw "mk-bun-cli: bunDepsHash is required"
    else pkgs.stdenvNoCC.mkDerivation {
      name = "${name}-bun-deps";
      nativeBuildInputs = [ pkgsUnstable.bun pkgs.cacert ];

      outputHashMode = "recursive";
      outputHashAlgo = "sha256";
      outputHash = bunDepsHash;

      dontUnpack = true;
      dontFixup = true;
      dontCheckForBrokenSymlinks = true;

      buildPhase = ''
        set -euo pipefail

        export HOME=$PWD
        cache_dir="$PWD/bun-cache"
        mkdir -p "$cache_dir"
        export BUN_INSTALL_CACHE_DIR="$cache_dir"
        export BUN_INSTALL_TMP_DIR="$PWD/bun-tmp"
        export BUN_TMPDIR="$BUN_INSTALL_TMP_DIR"
        export XDG_CACHE_HOME="$cache_dir"
        export NODE_ENV=development
        export NPM_CONFIG_PRODUCTION=false
        export npm_config_production=false
        export NPM_CONFIG_OMIT=
        export npm_config_omit=

        ${stageWorkspace}

        # Wrap bun install to emit actionable hints when lockfiles drift.
        bun_install_checked() {
          local dep_path="$1"
          local dep_name="$2"
          local lock_path="$dep_path/bun.lock"
          local log_name
          log_name="$(printf '%s' "$dep_name" | tr '/@' '__')"
          local bun_log="$PWD/bun-install-$log_name.log"
          if ! bun install \
            --cwd "$dep_path" \
            --frozen-lockfile \
            --linker=hoisted \
            --backend=copyfile \
            --no-cache 2>&1 | tee "$bun_log"; then
            local lock_mtime
            lock_mtime="$(stat -c '%y' "$lock_path" 2>/dev/null || stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$lock_path" 2>/dev/null || echo "unknown")"
            echo "mk-bun-cli: bun install failed for $dep_name" >&2
            echo "mk-bun-cli: bun.lock mtime: $lock_mtime" >&2
            if grep -q "lockfile had changes" "$bun_log"; then
              echo "mk-bun-cli: bun.lock changed while bunDepsHash is frozen" >&2
            fi
            echo "mk-bun-cli: bunDepsHash may be stale; update it (mono nix hash --package ${name})" >&2
            exit 1
          fi
        }

        package_path="$workspace/${packageDir}"
        if [ ! -f "$package_path/package.json" ]; then
          echo "mk-bun-cli: missing package.json in ${packageDir}" >&2
          exit 1
        fi
        if [ ! -f "$package_path/bun.lock" ]; then
          echo "mk-bun-cli: missing bun.lock in ${packageDir} (dotdot expects self-contained packages)" >&2
          exit 1
        fi

        bun_install_checked "$package_path" "${name}"

        ${lib.optionalString (localDependencies != []) localDependenciesInstallScript}
      '';

      installPhase = ''
        set -euo pipefail
        package_path="$PWD/workspace/${packageDir}"
        if [ -d "$package_path/node_modules" ]; then
          mkdir -p "$out"
          cp -R -L "$package_path/node_modules" "$out/node_modules"
        fi

        ${lib.optionalString (localDependencies != []) localDependenciesCopyScript}
      '';
    };

in
pkgs.stdenv.mkDerivation {
  inherit name;

  nativeBuildInputs = [ pkgsUnstable.bun pkgs.cacert ];

  dontStrip = true;
  dontPatchELF = true;
  dontFixup = true;
  dontUnpack = true;

  buildPhase = ''
    set -euo pipefail
    runHook preBuild

    export HOME=$PWD
    tmp_dir="$PWD/tmp"
    mkdir -p "$tmp_dir"
    export TMPDIR="$tmp_dir"
    export TMP="$tmp_dir"
    export TEMP="$tmp_dir"
    export BUN_TMPDIR="$tmp_dir"
    export BUN_INSTALL_CACHE_DIR="$PWD/bun-cache"
    export XDG_CACHE_HOME="$BUN_INSTALL_CACHE_DIR"
    mkdir -p "$BUN_INSTALL_CACHE_DIR"

    ${stageWorkspace}

    package_path="$workspace/${packageDir}"

    if [ ! -f "$package_path/package.json" ]; then
      echo "mk-bun-cli: missing package.json in ${packageDir}" >&2
      exit 1
    fi

    if [ ! -f "$package_path/bun.lock" ]; then
      echo "mk-bun-cli: missing bun.lock in ${packageDir}" >&2
      exit 1
    fi

    if [ ! -f "$workspace/${entry}" ]; then
      echo "mk-bun-cli: entry not found at ${entry}" >&2
      exit 1
    fi

    if [ -d "$package_path/node_modules" ]; then
      rm -rf "$package_path/node_modules"
    fi

    if ${lib.boolToString dirty}; then
      # Symlink deps from the Bun snapshot to avoid copying node_modules.
      mkdir -p "$package_path/node_modules"
      if [ -d "${bunDeps}/node_modules/.bin" ]; then
        ln -s "${bunDeps}/node_modules/.bin" "$package_path/node_modules/.bin"
      fi
      for entry in "${bunDeps}/node_modules/"*; do
        if [ ! -e "$entry" ]; then
          continue
        fi
        entry_name="$(basename "$entry")"
        if [ "$entry_name" = ".bin" ]; then
          continue
        fi
        if [ "$(printf '%s' "$entry_name" | cut -c1)" = "@" ]; then
          mkdir -p "$package_path/node_modules/$entry_name"
          for scoped_entry in "$entry"/*; do
            if [ ! -e "$scoped_entry" ]; then
              continue
            fi
            scoped_name="$(basename "$scoped_entry")"
            if [ ! -e "$package_path/node_modules/$entry_name/$scoped_name" ]; then
              ln -s "$scoped_entry" "$package_path/node_modules/$entry_name/$scoped_name"
            fi
          done
        else
          if [ ! -e "$package_path/node_modules/$entry_name" ]; then
            ln -s "$entry" "$package_path/node_modules/$entry_name"
          fi
        fi
      done
      ${lib.optionalString (localDependencies != []) localDependenciesLinkScript}
    else
      ln -s "${bunDeps}/node_modules" "$package_path/node_modules"
    fi

    substituteInPlace "$workspace/${entry}" \
      --replace-fail "const buildVersion = '__CLI_VERSION__'" "const buildVersion = '${fullVersion}'"

    ${lib.optionalString typecheckEnabled ''
      tsconfig_path="$workspace/${typecheckTsconfigChecked}"
      if [ ! -f "$tsconfig_path" ]; then
        echo "TypeScript config not found: ${typecheckTsconfigChecked}" >&2
        exit 1
      fi

      tsc_entry="$package_path/node_modules/typescript/bin/tsc"
      if [ ! -f "$tsc_entry" ]; then
        echo "TypeScript entry not found at $tsc_entry" >&2
        exit 1
      fi

      bun "$tsc_entry" --project "$tsconfig_path" --noEmit
    ''}

    build_root="$PWD"
    build_output="$build_root/.bun-build/${binaryName}"
    mkdir -p "$(dirname "$build_output")"

    cd "$workspace"
    bun build "${entry}" \
      --compile \
      --outfile="$build_output"
    cd "$build_root"

    bun_binary="${pkgsUnstable.bun}/bin/bun"
    if [ -s "$build_output" ] && cmp -s "$build_output" "$bun_binary"; then
      echo "mk-bun-cli: bun build output matches bun; refusing runtime fallback" >&2
      exit 1
    fi

    if [ ! -s "$build_output" ]; then
      echo "bun build produced an empty ${binaryName} binary" >&2
      exit 1
    fi

    # Allow CLIs to prepare a minimal workspace before smoke testing.
    smoke_test_cwd="$build_root"
    ${lib.optionalString (smokeTestCwd != null) ''
      smoke_test_cwd="$build_root/${smokeTestCwd}"
    ''}
    ${smokeTestSetupChecked}

    if [ -n "${smokeTestArgsChecked}" ]; then
      (cd "$smoke_test_cwd" && "$build_output" ${smokeTestArgsChecked})
    else
      (cd "$smoke_test_cwd" && "$build_output")
    fi

    runHook postBuild
  '';

  installPhase = ''
    set -euo pipefail
    runHook preInstall

    mkdir -p "$out/bin"
    cp ".bun-build/${binaryName}" "$out/bin/${binaryName}"

    runHook postInstall
  '';
}
