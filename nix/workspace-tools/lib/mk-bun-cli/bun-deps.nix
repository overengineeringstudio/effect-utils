{ pkgs
, pkgsUnstable
, name
, bunDepsHash
, stageWorkspace
, packageDir
, localDependencies
, localDependenciesInstallScript
, localDependenciesCopyScript
}:

let
  lib = pkgs.lib;
in
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

    # Store bun.lock hash before install so we can detect staleness later.
    sha256sum "$package_path/bun.lock" | cut -d' ' -f1 > "$PWD/.source-bun-lock-hash"

    bun_install_checked "$package_path" "${name}"

    ${lib.optionalString (localDependencies != []) localDependenciesInstallScript}
  '';

  installPhase = ''
    set -euo pipefail
    package_path="$PWD/workspace/${packageDir}"
    mkdir -p "$out"

    # Copy the source bun.lock hash for staleness detection.
    cp "$PWD/.source-bun-lock-hash" "$out/.source-bun-lock-hash"

    if [ -d "$package_path/node_modules" ]; then
      cp -R -L "$package_path/node_modules" "$out/node_modules"
    fi

    ${lib.optionalString (localDependencies != []) localDependenciesCopyScript}
  '';
}
