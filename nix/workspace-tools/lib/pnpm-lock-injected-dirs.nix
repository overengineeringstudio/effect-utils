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

  Paths are relative to the lockfile directory and returned in canonical form
  (`.` segments dropped). A path that is absolute or has an empty or `..`
  segment anywhere is rejected: it could name a directory outside the install
  root, and a canonical beneath-the-root check is simpler than resolving it.
  A directory under `sourceInputStagePath` is rejected too: that projection is only
  materialized for the aggregate root, whose lockfile this reader is not used
  for, so such an entry could never be staged.

  The parser is line-based over pnpm's canonical lockfile layout (as the
  `patchedDependencies` reader in mk-pnpm-cli.nix is), accepts pnpm 12's
  multi-document lockfiles and CRLF line endings, and reads plain,
  single-quoted and double-quoted YAML scalars (a path containing `,` is always
  quoted in the flow mapping). It fails closed: a directory resolution it
  cannot read, or a double-quoted escape it does not decode, is an evaluation
  error rather than a silently unstaged directory.
*/
{ lib }:
{
  lockfileContent,
  sourceInputStagePath ? ".devenv/pnpm-source-inputs/current",
}:
let
  lines = map (lib.removeSuffix "\r") (lib.splitString "\n" lockfileContent);

  topLevelKey = line: builtins.match "([A-Za-z][A-Za-z0-9]*):.*" line;
  resolutionPattern = scalar: "    resolution: \\{directory: ${scalar}, type: directory}";
  singleQuoted = builtins.match (resolutionPattern "'((''|[^'])*)'");
  doubleQuoted = builtins.match (resolutionPattern "\"(([^\"\\\\]|\\\\.)*)\"");
  plain = builtins.match (resolutionPattern "([^'\" ,{}][^,{}]*)");
  isDirectoryResolution = line: builtins.match "    resolution: \\{.*type: directory}" line != null;

  doubleQuotedEscapes = {
    "\\" = "\\";
    "\"" = "\"";
    "/" = "/";
    "t" = "\t";
    "n" = "\n";
    "r" = "\r";
  };
  decodeDoubleQuoted =
    raw:
    lib.concatMapStrings (
      part:
      if builtins.isString part then
        part
      else
        let
          escape = builtins.head part;
        in
        doubleQuotedEscapes.${escape}
          or (throw "pnpm-lock-injected-dirs: unsupported escape \\${escape} in directory: \"${raw}\"")
    ) (builtins.split "\\\\(.)" raw);

  directoryResolution =
    line:
    let
      single = singleQuoted line;
      double = doubleQuoted line;
      unquoted = plain line;
    in
    if single != null then
      builtins.replaceStrings [ "''" ] [ "'" ] (builtins.head single)
    else if double != null then
      decodeDoubleQuoted (builtins.head double)
    else if unquoted != null then
      builtins.head unquoted
    else
      throw "pnpm-lock-injected-dirs: unreadable directory resolution: ${line}";

  step =
    state: line:
    if line == "---" then
      state // { section = null; }
    else if topLevelKey line != null then
      state // { section = builtins.head (topLevelKey line); }
    else if state.section == "packages" && isDirectoryResolution line then
      state // { directories = state.directories ++ [ (directoryResolution line) ]; }
    else
      state;

  parsed = builtins.foldl' step {
    section = null;
    directories = [ ];
  } lines;

  canonicalize =
    path:
    let
      segments = builtins.filter (segment: segment != ".") (
        lib.splitString "/" (lib.removeSuffix "/" path)
      );
    in
    if
      path == ""
      || lib.hasPrefix "/" path
      || builtins.any (segment: segment == "" || segment == "..") segments
    then
      throw "pnpm-lock-injected-dirs: injected directory package is not a canonical path beneath the lockfile directory: ${path}"
    else if segments == [ ] then
      "."
    else
      builtins.concatStringsSep "/" segments;
  isSourceInput = path: path == sourceInputStagePath || lib.hasPrefix "${sourceInputStagePath}/" path;
  checked = map (
    path:
    if isSourceInput path then
      throw "pnpm-lock-injected-dirs: injected directory package under ${sourceInputStagePath} cannot be staged for this install root: ${path}"
    else
      path
  ) (map canonicalize parsed.directories);
in
lib.sort (left: right: left < right) (lib.unique checked)
