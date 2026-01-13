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
# - dirty: When true, copy node_modules and overlay local file deps (defaults to false).
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
  excludedSourceNames = [
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

  sourceFilter = root: path: _type:
    let
      rootStr = toString root;
      pathStr = toString path;
      relPath =
        if pathStr == rootStr
        then ""
        else lib.removePrefix (rootStr + "/") pathStr;
      parts = if relPath == "" then [] else lib.splitString "/" relPath;
      hasExcluded = lib.any (segment: lib.elem segment excludedSourceNames) parts;
    in
    !hasExcluded;

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
    in
    lib.mapAttrsToList
      (depName: depValue: { name = depName; path = normalize depValue; })
      (lib.filterAttrs (_: value: isLocal value) localDependencyMap);

  localDependenciesCopyScript = lib.concatStringsSep "\n" (map
    (dep: ''
      dep_name=${lib.escapeShellArg dep.name}
      dep_rel=${lib.escapeShellArg dep.path}
      if [ -z "$dep_rel" ]; then
        echo "mk-bun-cli: empty path for local dependency $dep_name" >&2
        exit 1
      fi

      case "$dep_rel" in
        /*) dep_source="$dep_rel" ;;
        *) dep_source="$package_path/$dep_rel" ;;
      esac

      if [ ! -d "$dep_source" ]; then
        echo "mk-bun-cli: local dependency $dep_name not found at $dep_source" >&2
        exit 1
      fi

      dep_target="$package_path/node_modules/$dep_name"
      mkdir -p "$(dirname "$dep_target")"
      rm -rf "$dep_target"
      cp -R -L "$dep_source" "$dep_target"
    '')
    localDependencies);

  typecheckTsconfigChecked =
    if typecheck
    then
      if typecheckTsconfig != null
      then typecheckTsconfig
      else "${builtins.dirOf packageJsonPath}/tsconfig.json"
    else typecheckTsconfig;

  smokeTestArgsChecked = lib.escapeShellArgs smokeTestArgs;

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

        package_path="$workspace/${packageDir}"
        if [ ! -f "$package_path/package.json" ]; then
          echo "mk-bun-cli: missing package.json in ${packageDir}" >&2
          exit 1
        fi
        if [ ! -f "$package_path/bun.lock" ]; then
          echo "mk-bun-cli: missing bun.lock in ${packageDir} (dotdot expects self-contained packages)" >&2
          exit 1
        fi

        bun install \
          --cwd "$package_path" \
          --frozen-lockfile \
          --linker=hoisted \
          --backend=copyfile \
          --no-cache
      '';

      installPhase = ''
        set -euo pipefail
        package_path="$PWD/workspace/${packageDir}"
        if [ -d "$package_path/node_modules" ]; then
          mkdir -p "$out"
          cp -R -L "$package_path/node_modules" "$out/node_modules"
        fi
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
      cp -R "${bunDeps}/node_modules" "$package_path/node_modules"
      chmod -R u+w "$package_path/node_modules"
      ${lib.optionalString (localDependencies != []) localDependenciesCopyScript}
    else
      ln -s "${bunDeps}/node_modules" "$package_path/node_modules"
    fi

    substituteInPlace "$workspace/${entry}" \
      --replace-fail "const buildVersion = '__CLI_VERSION__'" "const buildVersion = '${fullVersion}'"

    ${lib.optionalString typecheck ''
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

    if [ -n "${smokeTestArgsChecked}" ]; then
      "$build_output" ${smokeTestArgsChecked}
    else
      "$build_output"
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
