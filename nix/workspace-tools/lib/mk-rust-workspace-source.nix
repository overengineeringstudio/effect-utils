{ lib, pkgs }:

{
  repositoryRoot,
  workspaceRoot,
  packageRoot,
  includeReadme ? false,
  includeTests ? true,
}:
let
  workspaceManifest = workspaceRoot + "/Cargo.toml";
  workspace = builtins.fromTOML (builtins.readFile workspaceManifest);
  memberManifests = map (member: workspaceRoot + "/${member}/Cargo.toml") workspace.workspace.members;
  rustSource = lib.fileset.toSource {
    root = workspaceRoot;
    fileset = lib.fileset.unions [
      workspaceManifest
      (workspaceRoot + "/Cargo.lock")
    ];
  };
  packageSource = lib.fileset.toSource {
    root = packageRoot;
    fileset = lib.fileset.unions (
      [
        (packageRoot + "/Cargo.toml")
        (lib.fileset.fileFilter (file: file.hasExt "rs") (packageRoot + "/src"))
      ]
      ++ lib.optional includeReadme (packageRoot + "/README.md")
      ++ lib.optional includeTests (lib.fileset.maybeMissing (packageRoot + "/tests"))
    );
  };
  packageRelative = lib.removePrefix "${toString repositoryRoot}/" (toString packageRoot);
  copyMemberManifests = lib.concatMapStringsSep "\n" (
    manifest:
    let
      relative = lib.removePrefix "${toString repositoryRoot}/" (toString manifest);
    in
    ''install -Dm0644 ${manifest} "$out/${relative}"''
  ) memberManifests;
in
pkgs.runCommand "rust-workspace-source" { } ''
  mkdir -p "$out/$(dirname ${lib.escapeShellArg packageRelative})"
  cp -R ${rustSource} "$out/rust"
  cp -R ${packageSource} "$out/${packageRelative}"
  chmod -R u+w "$out"
  cp ${repositoryRoot + "/rust-toolchain.toml"} "$out/rust-toolchain.toml"
  ${copyMemberManifests}
''
