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
  pnpmDepsHelper = import ./workspace-tools/lib/mk-pnpm-deps.nix { inherit pkgs; };
  packageDir = "packages/@overeng/oxc-config";
  pnpmDepsHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

  srcPath =
    if builtins.isAttrs src && builtins.hasAttr "outPath" src then
      src.outPath
    else if builtins.isPath src then
      src
    else
      builtins.toPath src;

  # Filtered source: only the package directory (for pnpm dep fetching)
  packageSrc = lib.cleanSourceWith {
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

  pnpmDeps = pnpmDepsHelper.mkDeps {
    name = "oxc-config";
    src = packageSrc;
    sourceRoot = "source/${packageDir}";
    inherit pnpmDepsHash;
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

    ${pnpmDepsHelper.mkRestoreScript { deps = pnpmDeps; }}

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
    # Verify the bundle is self-contained (no missing modules like jiti).
    # buildPhase leaves CWD in workspace/${packageDir} where plugin.js was produced.
    test -f plugin.js || { echo "error: plugin.js not found in $(pwd)"; exit 1; }
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
