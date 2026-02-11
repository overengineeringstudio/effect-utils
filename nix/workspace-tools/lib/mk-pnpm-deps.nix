# Shared pnpm dependency fetching and restore helpers.
#
# Provides two functions used by both mk-pnpm-cli.nix and oxc-config-plugin.nix:
#
# 1. mkDeps: Creates a fixed-output derivation (FOD) that fetches pnpm dependencies
#    with network access and archives them into a reproducible tarball.
#
# 2. mkRestoreScript: Generates a shell script snippet that extracts the archived
#    pnpm store and configures pnpm for offline installs during the build phase.
#
# By centralizing this logic we avoid duplicating the ~50 lines of pnpm store
# setup, timestamp normalization, and tarball creation across multiple builders.

{ pkgs }:

let
  pnpmPlatform = import ./pnpm-platform.nix;
in
{
  # Create a fixed-output derivation that fetches pnpm dependencies.
  #
  # Arguments:
  #   name:           Derivation name prefix (e.g., "genie" or "oxc-config")
  #   src:            Filtered source containing package.json + pnpm-lock.yaml
  #   sourceRoot:     Path within the source to cd into (e.g., "source/packages/@overeng/genie")
  #   pnpmDepsHash:   Expected hash of the FOD output
  #   preInstall:     Extra shell commands to run before pnpm install (e.g., chmod for workspace members)
  #   installFlags:   Extra flags for pnpm install (e.g., "--force --recursive")
  #   fetchFlags:     Extra flags for pnpm fetch (e.g., "--recursive")
  mkDeps =
    {
      name,
      src,
      sourceRoot,
      pnpmDepsHash,
      preInstall ? "",
      installFlags ? "",
      fetchFlags ? "",
    }:
    pkgs.stdenvNoCC.mkDerivation {
      pname = "${name}-pnpm-deps";
      version = "0.0.0";

      inherit src sourceRoot;

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

        ${preInstall}

        export HOME=$PWD
        export STORE_PATH=$PWD/.pnpm-store
        export NPM_CONFIG_PRODUCTION=false
        export npm_config_production=false
        export NODE_ENV=development

        pnpm config set store-dir "$STORE_PATH"
        pnpm config set manage-package-manager-versions false
        ${pnpmPlatform.setupScript}

        pnpm install --frozen-lockfile --ignore-scripts ${installFlags}
        pnpm fetch --frozen-lockfile ${fetchFlags}

        # Normalize pnpm store for cross-platform/cross-run determinism.
        # See: https://github.com/NixOS/nixpkgs/issues/422889

        # 1. Normalize index JSON metadata (timestamps, platform keys, modes, sideEffects).
        for indexDir in "$STORE_PATH"/v*/index; do
          if [ -d "$indexDir" ]; then
            find "$indexDir" -type f -name "*.json" -print0 \
              | xargs -0 perl -pi -e '
                # checkedAt timestamps are non-deterministic
                s/"checkedAt":[0-9]+/"checkedAt":0/g;
                # Patched dependency sideEffects keys contain the build platform
                # (e.g. "darwin;arm64;node24;patch=...") — normalize to a canonical form
                s/"(linux|darwin);(x64|arm64);(node\d+);/"_platform;/g;
                # File mode values depend on umask (e.g. 384/0600 vs 420/0644).
                # Normalize: executable (any +x bit) -> 493/0755, else -> 420/0644.
                s/"mode":(\d+)/qq{"mode":} . ($1 & 0111 ? 493 : 420)/ge;
                # sideEffects records patch results including umask-dependent file
                # lists and modes — strip entirely (pnpm re-applies patches on install).
                s/,"sideEffects":\{.*\}(?=\}$)//;
              '
          fi
        done

        # 2. Remove projects/ dir — contains symlinks named after sha256(build_path),
        #    which changes when derivation inputs change (e.g. source .ts files).
        #    Not needed for offline installs.
        rm -rf "$STORE_PATH"/v*/projects

        # 3. Remove tmp/ dir — pnpm 10 can leave randomly-named temp dirs (defensive).
        rm -rf "$STORE_PATH"/v*/tmp

        # 4. Normalize file permissions — umask can differ across CI runners/sandbox
        #    environments, and tar captures permissions. Following nixpkgs PR #422975.
        find "$STORE_PATH" -type d -exec chmod 755 {} +
        find "$STORE_PATH" -type f -name "*-exec" -exec chmod 555 {} +
        find "$STORE_PATH" -type f ! -name "*-exec" -exec chmod 444 {} +

        mkdir -p $out
        cd $STORE_PATH
        LC_ALL=C TZ=UTC tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -cf - . \
          | zstd -T1 -q -o $out/pnpm-store.tar.zst

        runHook postInstall
      '';

      outputHashMode = "recursive";
      outputHash = pnpmDepsHash;
    };

  # Generate a shell script snippet that restores the pnpm store from a deps
  # derivation and configures pnpm for offline installs.
  #
  # The calling derivation's buildPhase should include this snippet before
  # running `pnpm install --offline`.
  #
  # Arguments:
  #   deps: The derivation returned by mkDeps
  mkRestoreScript =
    { deps }:
    ''
      export HOME=$PWD
      export STORE_PATH=$(mktemp -d)
      export NPM_CONFIG_PRODUCTION=false
      export npm_config_production=false
      export NODE_ENV=development

      # Extract pnpm store
      zstd -d -c ${deps}/pnpm-store.tar.zst | tar -xf - -C $STORE_PATH
      chmod -R +w $STORE_PATH

      # Configure pnpm for offline install
      pnpm config set store-dir "$STORE_PATH"
      pnpm config set package-import-method clone-or-copy
      pnpm config set manage-package-manager-versions false
      ${pnpmPlatform.setupScript}
    '';
}
