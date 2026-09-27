/**
  Directories a pnpm lockfile records as injected `file:` directory packages.

  With `injectWorkspacePackages: true`, pnpm records workspace dependencies as
  `file:<dir>(<peer-hash>)` directory packages, each with a `packages:` entry
  `resolution: {directory: <dir>, type: directory}`. A frozen pnpm 12 install
  computes a packlist for every such directory in the lockfile, not only for
  the ones the installed importers reach, so a staged install root must
  contain all of them even when the consumer's workspace closure does not list
  them (ERR_PNPM_FS_PACKLIST_IO otherwise). The lockfile is therefore the
  authority for that set; `file:` tarballs are not directory packages and are
  ignored.

  Paths are relative to the lockfile directory. A directory outside the
  lockfile directory cannot be staged under the install root and is rejected.
  So is a directory under `sourceInputStagePath`: that projection is only
  materialized for the aggregate root, whose lockfile this reader is not used
  for, so such an entry could never be staged.

  The parser is line-based over pnpm's canonical lockfile layout (as the
  `patchedDependencies` reader in mk-pnpm-cli.nix is), accepts pnpm 12's
  multi-document lockfiles, and reads plain, single-quoted and double-quoted
  YAML scalars (a path containing `,` is always quoted in the flow mapping).
*/
{ lib }:
{
  lockfileContent,
  sourceInputStagePath ? ".devenv/pnpm-source-inputs/current",
}:
let
  lines = lib.splitString "\n" lockfileContent;

  topLevelKey = line: builtins.match "([A-Za-z][A-Za-z0-9]*):.*" line;
  resolutionPattern = scalar: "    resolution: \\{directory: ${scalar}, type: directory}";
  singleQuoted = builtins.match (resolutionPattern "'((''|[^'])*)'");
  doubleQuoted = builtins.match (resolutionPattern "\"(([^\"\\\\]|\\\\.)*)\"");
  plain = builtins.match (resolutionPattern "([^'\" ,{}][^,{}]*)");
  directoryResolution =
    line:
    let
      single = singleQuoted line;
      double = doubleQuoted line;
      unquoted = plain line;
    in
    if single != null then
      [ (builtins.replaceStrings [ "''" ] [ "'" ] (builtins.head single)) ]
    else if double != null then
      [ (builtins.replaceStrings [ "\\\"" "\\\\" ] [ "\"" "\\" ] (builtins.head double)) ]
    else
      unquoted;

  step =
    state: line:
    if line == "---" then
      state // { section = null; }
    else if topLevelKey line != null then
      state // { section = builtins.head (topLevelKey line); }
    else if state.section == "packages" && directoryResolution line != null then
      state // { directories = state.directories ++ [ (builtins.head (directoryResolution line)) ]; }
    else
      state;

  parsed = builtins.foldl' step {
    section = null;
    directories = [ ];
  } lines;

  normalize = path: lib.removeSuffix "/" (lib.removePrefix "./" path);
  isSourceInput = path: path == sourceInputStagePath || lib.hasPrefix "${sourceInputStagePath}/" path;
  checked = map (
    path:
    if path == ".." || lib.hasPrefix "../" path || lib.hasPrefix "/" path then
      throw "pnpm-lock-injected-dirs: injected directory package escapes the lockfile directory: ${path}"
    else if isSourceInput path then
      throw "pnpm-lock-injected-dirs: injected directory package under ${sourceInputStagePath} cannot be staged for this install root: ${path}"
    else
      path
  ) (map normalize parsed.directories);
in
lib.sort (left: right: left < right) (lib.unique checked)
