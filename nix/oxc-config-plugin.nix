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
  pnpmDepsHash = "sha256-0Y2V4RL6kWk3IS5BIK2qVwe+wPl+VHK1hSo5ONI1Gus=";

  srcPath =
    if builtins.isAttrs src && builtins.hasAttr "outPath" src then
      src.outPath
    else if builtins.isPath src then
      src
    else
      builtins.toPath src;

  # Patches referenced in pnpm-workspace.yaml (shared across all workspaces)
  patchesDir = "packages/@overeng/utils/patches";

  rootPnpmWorkspaceYamlPath = srcPath + "/pnpm-workspace.yaml";
  rootPnpmWorkspaceYaml = builtins.readFile rootPnpmWorkspaceYamlPath;

  hasPathPrefix =
    relPath: prefix:
    relPath == prefix
    || lib.hasPrefix "${prefix}/" relPath
    || (
      relPath != ""
      && builtins.elem relPath (
        lib.genList
          (index: lib.concatStringsSep "/" (lib.take (index + 1) (lib.splitString "/" prefix)))
          (lib.length (lib.splitString "/" prefix) - 1)
      )
    );

  workspaceSuffixLines =
    workspaceYaml:
    let
      dropUntilPackagesHeader =
        lines:
        if lines == [ ] then
          throw "oxc-config-plugin: pnpm-workspace.yaml is missing packages:"
        else if lib.hasPrefix "packages:" (lib.trim (builtins.head lines)) then
          lib.tail lines
        else
          dropUntilPackagesHeader (lib.tail lines);

      dropPackageBlock =
        lines:
        if lines == [ ] then
          [ ]
        else
          let
            line = builtins.head lines;
            trimmed = lib.trim line;
          in
          if trimmed == "" || lib.hasPrefix "-" trimmed || lib.hasPrefix " " line then
            dropPackageBlock (lib.tail lines)
          else
            lines;

      # GVS requires a global pnpm store unavailable inside Nix sandboxes
      stripGvs = lines: builtins.filter (l: !(lib.hasPrefix "enableGlobalVirtualStore" (lib.trim l))) lines;
    in
    stripGvs (dropPackageBlock (dropUntilPackagesHeader (lib.splitString "\n" workspaceYaml)));

  formatWorkspaceYaml =
    packageDirs: suffixLines:
    let
      packagesBlock = builtins.concatStringsSep "\n" ([ "packages:" ] ++ map (dir: "  - ${dir}") packageDirs);
      suffix = builtins.concatStringsSep "\n" suffixLines;
    in
    if suffix == "" then
      "${packagesBlock}\n"
    else
      "${packagesBlock}\n\n${suffix}\n";

  filteredRootPnpmWorkspaceYaml = formatWorkspaceYaml [ packageDir ] (workspaceSuffixLines rootPnpmWorkspaceYaml);

  copyFileCmd =
    relPath:
    ''
      mkdir -p "$out/$(dirname "${relPath}")"
      cp "$src/${relPath}" "$out/${relPath}"
    '';

  copyDirCmd =
    relPath:
    ''
      mkdir -p "$out/$(dirname "${relPath}")"
      cp -R "$src/${relPath}" "$out/$(dirname "${relPath}")/"
      chmod -R +w "$out/${relPath}"
    '';

  copyOptionalFileCmd =
    relPath:
    ''
      if [ -f "$src/${relPath}" ]; then
        ${copyFileCmd relPath}
      fi
    '';

  materializeWorkspace =
    {
      nameSuffix,
      manifestOnly,
    }:
    pkgs.runCommand "oxc-config-${nameSuffix}" { src = srcPath; } (
      ''
        set -euo pipefail
        mkdir -p "$out"
      ''
      + builtins.concatStringsSep "\n" (map copyFileCmd [ "package.json" "pnpm-lock.yaml" ])
      + builtins.concatStringsSep "\n" (map copyOptionalFileCmd [ ".npmrc" "tsconfig.base.json" ])
      + ''
        cat > "$out/pnpm-workspace.yaml" <<'EOF'
${filteredRootPnpmWorkspaceYaml}
EOF
      ''
      + (
        if manifestOnly then
          copyFileCmd "${packageDir}/package.json"
        else
          copyDirCmd packageDir
      )
      + "\n"
      + copyDirCmd patchesDir
    );

  depsSrc = materializeWorkspace {
    nameSuffix = "pnpm-deps-src";
    manifestOnly = true;
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
        builtins.elem relPath [ "package.json" "pnpm-lock.yaml" ".npmrc" "tsconfig.base.json" ]
        || hasPathPrefix relPath packageDir
        || hasPathPrefix relPath patchesDir
      );
  };

  pnpmDeps = pnpmDepsHelper.mkDeps {
    name = "oxc-config";
    src = depsSrc;
    sourceRoot = ".";
    inherit pnpmDepsHash;
  };

in
pkgs.stdenv.mkDerivation {
  pname = "oxc-config-plugin";
  version = "0.1.0";

  nativeBuildInputs = [
    bun
    pkgs.nodejs
    pkgs.zstd
  ];

  dontUnpack = true;
  dontFixup = true;

  buildPhase = ''
    set -euo pipefail
    runHook preBuild

    cp -r ${buildSrc} workspace
    chmod -R +w workspace
    ${pnpmDepsHelper.mkRestoreScript {
      deps = pnpmDeps;
      target = "workspace";
    }}
    chmod -R +w workspace
    cat > workspace/pnpm-workspace.yaml <<'EOF'
${filteredRootPnpmWorkspaceYaml}
EOF
    cd workspace

    cd ${packageDir}

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
