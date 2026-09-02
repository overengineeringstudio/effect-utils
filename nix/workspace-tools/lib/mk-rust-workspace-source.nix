{ lib }:

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
in
lib.fileset.toSource {
  root = repositoryRoot;
  fileset = lib.fileset.unions (
    [
      workspaceManifest
      (workspaceRoot + "/Cargo.lock")
      (repositoryRoot + "/rust-toolchain.toml")
      (lib.fileset.fileFilter (file: file.hasExt "rs") (packageRoot + "/src"))
    ]
    ++ memberManifests
    ++ lib.optional includeReadme (packageRoot + "/README.md")
    ++ lib.optional includeTests (lib.fileset.maybeMissing (packageRoot + "/tests"))
  );
}
