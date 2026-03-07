{ pkgs }:

{
  name,
  packageDir,
  packageSource,
  workspaceMembers ? [ ],
  mounts ? { },
  fileOverrides ? { },
  extraDependencyPaths ? [ ],
  extraExcludedSourceNames ? [ ],
  packageVersion ? null,
}:

let
  lib = pkgs.lib;

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
  ] ++ extraExcludedSourceNames;

  normalizePath = src:
    if builtins.isAttrs src && builtins.hasAttr "outPath" src then
      src.outPath
    else if builtins.isPath src then
      src
    else
      builtins.toPath src;

  packageSourcePath = normalizePath packageSource;
  normalizedMounts = lib.mapAttrs (_: normalizePath) mounts;

  dependencyPaths = lib.unique (workspaceMembers ++ extraDependencyPaths);
  dependencyMounts = lib.filterAttrs (path: _: lib.elem path dependencyPaths) normalizedMounts;

  writeTextFile = path: text:
    pkgs.writeText "prepared-pnpm-workspace-${builtins.substring 0 12 (builtins.hashString "sha256" path)}" text;

  normalizedOverrides = lib.mapAttrs writeTextFile fileOverrides;

  copyTreeCommands = path: source: ''
    mkdir -p "$(dirname "$out/${path}")"
    if [ -d ${lib.escapeShellArg (toString source)} ]; then
      mkdir -p "$out/${path}"
      cp -R ${lib.escapeShellArg (toString source + "/.")} "$out/${path}/"
    else
      cp ${lib.escapeShellArg (toString source)} "$out/${path}"
    fi
  '';

  overrideCommands = lib.concatStringsSep "\n" (
    lib.mapAttrsToList
      (path: sourceFile: ''
        mkdir -p "$(dirname "$out/${path}")"
        cp ${lib.escapeShellArg (toString sourceFile)} "$out/${path}"
      '')
      normalizedOverrides
  );

  removeExcludedCommands = lib.concatStringsSep "\n" (
    map
      (name: ''
        find "$out" -depth -name ${lib.escapeShellArg name} -exec rm -rf {} +
      '')
      excludedSourceNames
  );

  workspaceSource = pkgs.runCommand "${name}-prepared-workspace" { } ''
    set -euo pipefail

    mkdir -p "$out/${packageDir}"
    cp -R ${lib.escapeShellArg (toString packageSourcePath + "/.")} "$out/${packageDir}/"

    ${lib.concatStringsSep "\n" (lib.mapAttrsToList copyTreeCommands normalizedMounts)}

    chmod -R u+w "$out"

    ${overrideCommands}

    ${removeExcludedCommands}
  '';

  depsRelevantFiles = [
    "pnpm-lock.yaml"
    "package.json"
    "pnpm-workspace.yaml"
    ".npmrc"
  ];

  depsSource = pkgs.runCommand "${name}-prepared-deps-source" { } ''
    set -euo pipefail

    mkdir -p "$out/${packageDir}"
    cp -R ${lib.escapeShellArg (toString packageSourcePath + "/.")} "$out/${packageDir}/"
    chmod -R u+w "$out/${packageDir}"

    find "$out/${packageDir}" -mindepth 1 -maxdepth 1 \
      ${lib.concatStringsSep " " (map (file: "! -name ${lib.escapeShellArg file}") depsRelevantFiles)} \
      -exec rm -rf {} +

    ${lib.concatStringsSep "\n" (lib.mapAttrsToList copyTreeCommands dependencyMounts)}

    chmod -R u+w "$out"

    ${overrideCommands}

    ${removeExcludedCommands}
  '';

  fingerprint = pkgs.runCommand "${name}-fingerprint" {
    nativeBuildInputs = [ pkgs.jq pkgs.nix ];
  } ''
    set -euo pipefail

    mkdir -p "$out"

    lockfileHash="sha256-$(nix-hash --type sha256 --base64 ${workspaceSource}/${packageDir}/pnpm-lock.yaml)"
    printf '%s' "$lockfileHash" > "$out/lockfileHash"

    tmpDeps="$(mktemp)"
    jq -cS '{dependencies, devDependencies, peerDependencies}' ${workspaceSource}/${packageDir}/package.json > "$tmpDeps"
    packageJsonDepsHash="sha256-$(nix-hash --type sha256 --base64 "$tmpDeps")"
    rm "$tmpDeps"
    printf '%s' "$packageJsonDepsHash" > "$out/packageJsonDepsHash"
  '';

  resolvedPackageVersion =
    if packageVersion != null then
      packageVersion
    else
      ((builtins.fromJSON (builtins.readFile (packageSourcePath + "/package.json"))).version or "0.0.0");
in
{
  inherit
    depsSource
    fingerprint
    packageDir
    workspaceMembers
    workspaceSource
    ;
  packageVersion = resolvedPackageVersion;
}
