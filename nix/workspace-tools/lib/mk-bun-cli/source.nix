{ lib, workspaceRoot, extraExcludedSourceNames, packageDir, packageJsonPath, gitRev }:

let
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
  defaultExcludedSourceNames = [
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
  excludedSourceNames = lib.unique (defaultExcludedSourceNames ++ extraExcludedSourceNames);

  sourceFilter = root: path: type:
    let
      rootStr = toString root;
      pathStr = toString path;
      relPath =
        if pathStr == rootStr
        then ""
        else lib.removePrefix (rootStr + "/") pathStr;
      parts = if relPath == "" then [] else lib.splitString "/" relPath;
      # Only exclude result* at the workspace root to avoid filtering real files.
      topLevel = if parts == [] then "" else builtins.head parts;
      hasExcluded = lib.any
        (segment: lib.elem segment excludedSourceNames)
        parts
        || topLevel == "result";
    in
    lib.cleanSourceFilter path type && !hasExcluded;

  workspaceSrc = lib.cleanSourceWith {
    src = workspaceRootPath;
    filter = sourceFilter workspaceRootPath;
  };

  packageJsonFullPath = workspaceSrc + "/${packageJsonPath}";
  packageJson = builtins.fromJSON (builtins.readFile packageJsonFullPath);
  baseVersion = packageJson.version or "0.0.0";
  fullVersion = if gitRev == "unknown" then baseVersion else "${baseVersion}+${gitRev}";

  # Stage a writable copy so Bun and tsc can write caches in the sandbox.
  stageWorkspace = ''
    workspace="$PWD/workspace"
    mkdir -p "$workspace"
    (cd "${workspaceSrc}" && tar -cf - .) | (cd "$workspace" && tar -xf -)
    chmod -R u+w "$workspace"
  '';
in
{
  inherit workspaceRootPath workspaceSrc packageJson fullVersion stageWorkspace;
}
