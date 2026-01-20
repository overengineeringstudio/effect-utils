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
  source = import ./mk-bun-cli/source.nix {
    inherit lib workspaceRoot extraExcludedSourceNames packageDir packageJsonPath gitRev dirty;
  };
  inherit (source) workspaceRootPath workspaceSrc packageJson fullVersion stageWorkspace;

  localDeps = import ./mk-bun-cli/local-deps.nix {
    inherit lib workspaceRootPath packageJson packageDir;
  };
  inherit (localDeps)
    localDependencies
    localDependenciesInstallScript
    localDependenciesCopyScript
    localDependenciesLinkScript;

  bunDeps = import ./mk-bun-cli/bun-deps.nix {
    inherit
      pkgs
      pkgsUnstable
      name
      bunDepsHash
      stageWorkspace
      packageDir
      localDependencies
      localDependenciesInstallScript
      localDependenciesCopyScript;
  };

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
      # Dirty builds avoid symlinking the entire node_modules tree (slow) by
      # resolving dependencies via NODE_PATH and overlaying local file deps.
      mkdir -p "$package_path/node_modules"
      bun_deps="${bunDeps}"
      ${lib.optionalString (localDependencies != []) localDependenciesLinkScript}
      export NODE_PATH="$package_path/node_modules:${bunDeps}/node_modules"
    else
      ln -s "${bunDeps}/node_modules" "$package_path/node_modules"
    fi

    substituteInPlace "$workspace/${entry}" \
      --replace-fail "const buildVersion = '__CLI_VERSION__'" "const buildVersion = '${fullVersion}'"

    # Check for stale bunDepsHash before expensive operations
    if [ -f "${bunDeps}/.source-bun-lock-hash" ]; then
      current_lock_hash=$(sha256sum "$package_path/bun.lock" | cut -d' ' -f1)
      stored_lock_hash=$(cat "${bunDeps}/.source-bun-lock-hash")
      if [ "$current_lock_hash" != "$stored_lock_hash" ]; then
        echo "" >&2
        echo "┌──────────────────────────────────────────────────────────────────┐" >&2
        echo "│  ERROR: bunDepsHash is stale!                                    │" >&2
        echo "│                                                                  │" >&2
        echo "│  bun.lock has changed since the dependency cache was built.     │" >&2
        echo "│  This can cause mysterious build failures with wrong versions.  │" >&2
        echo "│                                                                  │" >&2
        echo "│  Run: mono nix hash --package ${name}                            │" >&2
        echo "└──────────────────────────────────────────────────────────────────┘" >&2
        echo "" >&2
        exit 1
      fi
    fi

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
