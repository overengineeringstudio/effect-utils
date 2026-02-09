# Build pre-bundled @overeng/oxc-config JS plugin for oxlint.
#
# Bundles the custom overeng rules + eslint-plugin-storybook into a single
# self-contained JS file usable as an oxlint jsPlugin without node_modules.
# Imported by oxlint-npm.nix when src is provided.
#
# =============================================================================
# Updating the pnpmDepsHash (after changing oxc-config's dependencies)
# =============================================================================
#
# 1. Run: nix build .#oxlint-npm 2>&1
#    (the FOD will fail with expected vs actual hash)
#
# 2. Update pnpmDepsHash below with the actual hash from the error
#
# =============================================================================
{
  pkgs,
  bun,
  src,
}:

let
  lib = pkgs.lib;
  pnpmPlatform = import ./workspace-tools/lib/pnpm-platform.nix;
  packageDir = "packages/@overeng/oxc-config";
  pnpmDepsHash = "sha256-38BuFU/nIAMeSZLFFalgmbHM+uIVafwer1Hc/vnezmA=";

  srcPath =
    if builtins.isAttrs src && builtins.hasAttr "outPath" src then
      src.outPath
    else if builtins.isPath src then
      src
    else
      builtins.toPath src;

  # Filtered source: only the package directory (for pnpm dep fetching)
  mkPackageSrc = lib.cleanSourceWith {
    src = srcPath;
    filter =
      path: type:
      let
        relPath = lib.removePrefix (toString srcPath + "/") (toString path);
      in
      lib.hasPrefix "${packageDir}/" relPath
      || relPath == packageDir
      || (
        type == "directory"
        && lib.any (n: relPath == lib.concatStringsSep "/" (lib.take n (lib.splitString "/" packageDir))) (
          lib.range 1 (lib.length (lib.splitString "/" packageDir))
        )
      );
  };

  # Fetch pnpm dependencies (fixed-output derivation with network access)
  pnpmDeps = pkgs.stdenvNoCC.mkDerivation {
    pname = "oxc-config-pnpm-deps";
    version = "0.0.0";

    src = mkPackageSrc;
    sourceRoot = "source/${packageDir}";

    nativeBuildInputs = [
      pkgs.pnpm
      pkgs.nodejs
      pkgs.cacert
      pkgs.zstd
      pkgs.findutils
      pkgs.perl
    ];

    dontConfigure = true;
    dontBuild = true;

    installPhase = ''
      runHook preInstall

      export HOME=$PWD
      export STORE_PATH=$PWD/.pnpm-store
      export NPM_CONFIG_PRODUCTION=false
      export npm_config_production=false
      export NODE_ENV=development
      export CI=true

      pnpm config set store-dir "$STORE_PATH"
      pnpm config set manage-package-manager-versions false
      ${pnpmPlatform.setupScript}

      pnpm install --frozen-lockfile --ignore-scripts
      pnpm fetch --frozen-lockfile

      # Normalize pnpm store metadata (non-deterministic timestamps)
      for indexDir in "$STORE_PATH"/v*/index; do
        if [ -d "$indexDir" ]; then
          find "$indexDir" -type f -name "*.json" -print0 \
            | xargs -0 perl -pi -e 's/"checkedAt":[0-9]+/"checkedAt":0/g'
        fi
      done

      mkdir -p $out
      cd $STORE_PATH
      LC_ALL=C TZ=UTC tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -cf - . \
        | zstd -T1 -q -o $out/pnpm-store.tar.zst

      runHook postInstall
    '';

    outputHashMode = "recursive";
    outputHash = pnpmDepsHash;
  };

  # Full source for building (includes .ts files, excludes node_modules etc.)
  buildSrc = lib.cleanSourceWith {
    src = srcPath;
    filter =
      path: type:
      let
        relPath = lib.removePrefix (toString srcPath + "/") (toString path);
        baseName = baseNameOf path;
        excludedNames = [
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
      in
      !(lib.elem baseName excludedNames)
      && (
        lib.hasPrefix "${packageDir}/" relPath
        || relPath == packageDir
        || (
          type == "directory"
          && lib.any (n: relPath == lib.concatStringsSep "/" (lib.take n (lib.splitString "/" packageDir))) (
            lib.range 1 (lib.length (lib.splitString "/" packageDir))
          )
        )
      );
  };

in
pkgs.stdenv.mkDerivation {
  pname = "oxc-config-plugin";
  version = "0.1.0";

  nativeBuildInputs = [
    pkgs.pnpm
    pkgs.nodejs
    bun
    pkgs.zstd
  ];

  dontUnpack = true;
  dontFixup = true;

  buildPhase = ''
    set -euo pipefail
    runHook preBuild

    export HOME=$PWD
    export STORE_PATH=$(mktemp -d)
    export NPM_CONFIG_PRODUCTION=false
    export npm_config_production=false
    export NODE_ENV=development

    zstd -d -c ${pnpmDeps}/pnpm-store.tar.zst | tar -xf - -C $STORE_PATH
    chmod -R +w $STORE_PATH

    pnpm config set store-dir "$STORE_PATH"
    pnpm config set package-import-method clone-or-copy
    pnpm config set manage-package-manager-versions false
    ${pnpmPlatform.setupScript}

    cp -r ${buildSrc} workspace
    chmod -R +w workspace
    cd workspace/${packageDir}

    pnpm install --offline --frozen-lockfile --ignore-scripts

    # Bundle into single JS file.
    # --external jiti: eslint's config loader uses jiti for dynamic imports, but
    # oxlint's JS plugin runtime never invokes the config loader, so jiti is safe
    # to exclude. This avoids bundling issues with jiti's native module resolution.
    bun build src/mod.ts --bundle --target=bun --external jiti --outfile=plugin.js

    runHook postBuild
  '';

  checkPhase = ''
    # Verify the bundle is self-contained (no missing modules like jiti)
    bun -e "const p = require('./plugin.js'); if (!p || typeof p !== 'object') throw new Error('plugin did not export an object')"
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp plugin.js $out/
    runHook postInstall
  '';

  meta = with pkgs.lib; {
    description = "Pre-bundled @overeng/oxc-config oxlint JS plugin";
    license = licenses.mit;
  };
}
