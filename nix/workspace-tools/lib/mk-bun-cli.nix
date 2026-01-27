# Megarepo-first Bun CLI builder.
#
# Design goals:
# - Build native Bun binaries from TypeScript quickly and deterministically.
# - Work inside megarepo workspaces (local peer repos + uncommitted changes).
# - Keep builds pure (no --impure) and avoid shipping node_modules.
# - Fail early with clear errors and a smoke test.
#
# Arguments:
# - name: Derivation name and default binary name.
# - entry: CLI entry file relative to workspaceRoot.
# - packageDir: Package directory relative to workspaceRoot.
# - workspaceRoot: Workspace root (flake input or path).
# - bunDepsHash: Fixed-output hash for Bun deps snapshot.
# - depsManager: Dependency installer to use ("bun" or "pnpm").
# - pnpmDepsHash: Fixed-output hash for pnpm deps snapshot.
# - binaryName: Output binary name (defaults to name).
# - packageJsonPath: package.json path relative to workspaceRoot (defaults to <packageDir>/package.json).
# - gitRev: Git short revision (defaults to "unknown").
# - commitTs: Git commit timestamp in seconds (defaults to 0).
# - typecheck: Run tsc --noEmit (defaults to true).
# - typecheckTsconfig: Tsconfig path relative to workspaceRoot (defaults to <packageDir>/tsconfig.json).
# - smokeTestArgs: Args for smoke test (defaults to ["--help"]).
# - smokeTestCwd: Relative working directory for the smoke test (defaults to build root).
# - smokeTestSetup: Shell snippet to prepare the smoke test working dir (optional).
# - extraExcludedSourceNames: Extra top-level paths to omit from the staged workspace.
# - dirty: When true, link bunDeps and overlay local file deps (defaults to false).
{ pkgs }:

{
  name,
  entry,
  packageDir,
  workspaceRoot,
  bunDepsHash ? null,
  depsManager ? "bun",
  pnpmDepsHash ? null,
  binaryName ? name,
  packageJsonPath ? "${packageDir}/package.json",
  gitRev ? "unknown",
  commitTs ? 0,
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
    inherit lib workspaceRoot extraExcludedSourceNames packageDir packageJsonPath gitRev commitTs dirty;
  };
  inherit (source) workspaceRootPath workspaceSrc packageJson baseVersion nixStampJson stageWorkspace;

  localDeps = import ./mk-bun-cli/local-deps.nix {
    inherit lib workspaceRootPath packageJson packageDir depsManager;
  };
  inherit (localDeps)
    localDependencies
    localDependenciesInstallScript
    localDependenciesCopyScript
    localDependenciesLinkPackageScript
    localDependenciesLinkWorkspaceScript;

  bunDeps = import ./mk-bun-cli/bun-deps.nix {
    inherit
      pkgs
      name
      bunDepsHash
      depsManager
      pnpmDepsHash
      stageWorkspace
      packageDir
      localDependencies
      localDependenciesInstallScript
      localDependenciesCopyScript;
  };

  # Skip typechecking in dirty mode (TS6305) and when local deps are present
  # because TypeScript module resolution requires a full node_modules layout.
  typecheckEnabled = typecheck && !dirty && localDependencies == [];

  typecheckTsconfigChecked =
    if typecheckEnabled
    then
      if typecheckTsconfig != null
      then typecheckTsconfig
      else "${builtins.dirOf packageJsonPath}/tsconfig.json"
    else typecheckTsconfig;

  smokeTestArgsChecked = lib.escapeShellArgs smokeTestArgs;
  smokeTestSetupChecked = lib.optionalString (smokeTestSetup != null) smokeTestSetup;
  # Temporary pnpm fallback (see context/workarounds/bun-issues.md).
  isPnpm = depsManager == "pnpm";
  lockFileName = if isPnpm then "pnpm-lock.yaml" else "bun.lock";
  lockHashFile = if isPnpm then ".source-pnpm-lock-hash" else ".source-bun-lock-hash";
  useNodePath = dirty || localDependencies != [];

in
pkgs.stdenv.mkDerivation {
  inherit name;

  nativeBuildInputs = [ pkgs.bun pkgs.cacert ];

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

    if [ ! -f "$package_path/${lockFileName}" ]; then
      echo "mk-bun-cli: missing ${lockFileName} in ${packageDir}" >&2
      exit 1
    fi

    if [ ! -f "$workspace/${entry}" ]; then
      echo "mk-bun-cli: entry not found at ${entry}" >&2
      exit 1
    fi

    if [ -d "$package_path/node_modules" ]; then
      rm -rf "$package_path/node_modules"
    fi

    bun_deps="${bunDeps}"
    if ${lib.boolToString useNodePath}; then
      # Use NODE_PATH resolution when dirty or when local deps need their own node_modules.
      mkdir -p "$package_path/node_modules"
      ${lib.optionalString (localDependencies != []) localDependenciesLinkPackageScript}
      ${lib.optionalString (localDependencies != []) localDependenciesLinkWorkspaceScript}
      if [ -d "$bun_deps/node_modules/@types" ]; then
        rm -rf "$package_path/node_modules/@types"
        ln -s "$bun_deps/node_modules/@types" "$package_path/node_modules/@types"
      fi
      export NODE_PATH="$package_path/node_modules:${bunDeps}/node_modules"
    else
      ln -s "${bunDeps}/node_modules" "$package_path/node_modules"
    fi

    substituteInPlace "$workspace/${entry}" \
      --replace-fail "const buildStamp = '__CLI_BUILD_STAMP__'" "const buildStamp = '${nixStampJson}'"

    # Check for stale bunDepsHash before expensive operations
    if [ -f "${bunDeps}/${lockHashFile}" ]; then
      current_lock_hash=$(sha256sum "$package_path/${lockFileName}" | cut -d' ' -f1)
      stored_lock_hash=$(cat "${bunDeps}/${lockHashFile}")
      if [ "$current_lock_hash" != "$stored_lock_hash" ]; then
        echo "" >&2
        echo "┌──────────────────────────────────────────────────────────────────┐" >&2
        echo "│  ERROR: deps hash is stale!                                      │" >&2
        echo "│                                                                  │" >&2
        echo "│  ${lockFileName} has changed since the dependency cache was built.│" >&2
        echo "│  This can cause mysterious build failures with wrong versions.  │" >&2
        echo "│                                                                  │" >&2
        echo "│  Run: dt nix:hash:${name}                                       │" >&2
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
        tsc_entry="$bun_deps/node_modules/typescript/bin/tsc"
      fi
      if [ ! -f "$tsc_entry" ]; then
        echo "TypeScript entry not found at $tsc_entry" >&2
        exit 1
      fi
      if grep -q '"references"' "$tsconfig_path"; then
        bun "$tsc_entry" --build "$tsconfig_path"
      else
        bun "$tsc_entry" --project "$tsconfig_path" --noEmit
      fi
    ''}

    build_root="$PWD"
    build_output="$build_root/.bun-build/${binaryName}"
    mkdir -p "$(dirname "$build_output")"

    cd "$workspace"
    bun build "${entry}" \
      --compile \
      --outfile="$build_output"
    cd "$build_root"

    bun_binary="${pkgs.bun}/bin/bun"
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
