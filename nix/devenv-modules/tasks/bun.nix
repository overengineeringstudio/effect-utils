# Bun install tasks
#
# NOTE: Currently unused due to bun bugs with local file: dependencies.
# Using pnpm.nix instead. See: context/workarounds/bun-issues.md
# TODO: Switch back to bun:install once these issues are fixed:
#   - https://github.com/oven-sh/bun/issues/13223 (file: deps slow - individual symlinks)
#   - https://github.com/oven-sh/bun/issues/22846 (install hangs in monorepo)
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.bun {
#       packages = [
#         "packages/app"
#         "packages/website"
#         "scripts"
#       ];
#     })
#   ];
#
# Provides: bun:install, bun:install:<name> for each package
{ packages }:
{ lib, ... }:
let
  # Convert path to task name:
  # "packages/@scope/foo" -> "foo"
  # "packages/@scope/foo/examples/basic" -> "foo-examples-basic"
  # "packages/app" -> "app"
  # "apps/example.com" -> "example-com"
  # "tests/wa-sqlite" -> "tests-wa-sqlite"
  # "scripts" -> "scripts"
  toName = path:
    let
      sanitize = s: builtins.replaceStrings ["/" "."] ["-" "-"] s;
      # Only strip "packages/" or "apps/" prefix, keep others like "tests/"
      stripped = lib.removePrefix "apps/" (lib.removePrefix "packages/" path);
      # Strip @scope/ pattern (e.g., "@overeng/foo" -> "foo")
      m = builtins.match "@[^/]+/(.*)" stripped;
      final = if m != null then builtins.head m else stripped;
    in
    sanitize final;

  mkInstallTask = path: {
    "bun:install:${toName path}" = {
      description = "Install dependencies for ${toName path}";
      exec = "bun install";
      cwd = path;
      execIfModified = [ "${path}/package.json" "${path}/bun.lock" ];
      after = [ "genie:run" ];
    };
  };

  nodeModulesPaths = lib.concatMapStringsSep " " (p: "${p}/node_modules") packages;
  lockFilePaths = lib.concatMapStringsSep " " (p: "${p}/bun.lock") packages;

in {
  tasks = lib.mkMerge (map mkInstallTask packages ++ [
    {
      "bun:install" = {
        description = "Install all bun dependencies";
        after = map (p: "bun:install:${toName p}") packages;
      };
      "bun:clean" = {
        description = "Remove node_modules for all managed packages";
        exec = "rm -rf ${nodeModulesPaths}";
      };
      "bun:clean-lock-files" = {
        description = "Remove bun lock files for all managed packages";
        exec = "rm -f ${lockFilePaths}";
      };
    }
  ]);
}
