# Build pre-bundled @overeng/oxc-config JS plugin for oxlint.
#
# This bundles the custom overeng rules + eslint-plugin-storybook into a single
# self-contained JS file that can be used as an oxlint jsPlugin without needing
# node_modules. This enables consumer repos (like dotfiles) to use overeng/*
# rules in CI where effect-utils' node_modules aren't available.
#
# Usage:
#   oxcConfigPlugin = import ./oxc-config-plugin.nix {
#     inherit pkgs;
#     bun = pkgs.bun;
#     src = self;  # effect-utils flake source
#   };
#   # => oxcConfigPlugin is a path to the bundled plugin directory
#   # => "${oxcConfigPlugin}/plugin.js" is the plugin file
#
# =============================================================================
# Updating the pnpmDepsHash
# =============================================================================
#
# When dependencies in packages/@overeng/oxc-config/package.json change:
#
# 1. Run: nix build .#oxc-config-plugin 2>&1
#    (it will fail with the expected vs actual hash)
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
  packageDir = "packages/@overeng/oxc-config";

  srcPath =
    if builtins.isAttrs src && builtins.hasAttr "outPath" src then
      src.outPath
    else if builtins.isPath src then
      src
    else
      builtins.toPath src;

  # Filtered source for pnpm dep fetching (only needs package.json + lockfile)
  depsSrc = lib.cleanSourceWith {
    src = srcPath;
    filter =
      path: type:
      let
        relPath = lib.removePrefix (toString srcPath + "/") (toString path);
        baseName = baseNameOf path;
      in
      # Include package directory files needed for pnpm install
      lib.hasPrefix "${packageDir}/" relPath
      || relPath == packageDir
      ||
        # Include parent directory structure
        (
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

    src = depsSrc;
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

      # Configure pnpm
      pnpm config set store-dir "$STORE_PATH"
      pnpm config set manage-package-manager-versions false

      # Install deps
      pnpm install --frozen-lockfile --ignore-scripts
      pnpm fetch --frozen-lockfile

      # Normalize pnpm store metadata (non-deterministic timestamps)
      for indexDir in "$STORE_PATH"/v*/index; do
        if [ -d "$indexDir" ]; then
          find "$indexDir" -type f -name "*.json" -print0 \
            | xargs -0 perl -pi -e 's/"checkedAt":[0-9]+/"checkedAt":0/g'
        fi
      done

      # Archive the pnpm store
      mkdir -p $out
      cd $STORE_PATH
      LC_ALL=C TZ=UTC tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -cf - . \
        | zstd -T1 -q -o $out/pnpm-store.tar.zst

      runHook postInstall
    '';

    outputHashMode = "recursive";
    outputHash = "sha256-38BuFU/nIAMeSZLFFalgmbHM+uIVafwer1Hc/vnezmA=";
  };

  # Full source for building (includes .ts source files)
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

  inherit pnpmDeps;

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

    # Extract pnpm store
    echo "Extracting pnpm store..."
    zstd -d -c ${pnpmDeps}/pnpm-store.tar.zst | tar -xf - -C $STORE_PATH
    chmod -R +w $STORE_PATH

    # Configure pnpm
    pnpm config set store-dir "$STORE_PATH"
    pnpm config set package-import-method clone-or-copy
    pnpm config set manage-package-manager-versions false

    # Copy source
    echo "Copying source..."
    cp -r ${buildSrc} workspace
    chmod -R +w workspace
    cd workspace/${packageDir}

    # Install deps from offline store
    pnpm install --offline --frozen-lockfile --ignore-scripts

    # Bundle into single JS file
    # --external jiti: eslint's config loader uses jiti for dynamic imports, but
    # oxlint's JS plugin runtime never invokes the config loader, so jiti is safe
    # to exclude. This avoids bundling issues with jiti's native module resolution.
    echo "Bundling plugin..."
    bun build src/mod.ts --bundle --target=bun --external jiti --outfile=plugin.js

    runHook postBuild
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
