{ lib, ... }:
let
  dirs = [
    "packages/@overeng/cli-ui"
    "packages/@overeng/dotdot"
    "packages/@overeng/effect-ai-claude-cli"
    "packages/@overeng/effect-path"
    "packages/@overeng/effect-react"
    "packages/@overeng/effect-rpc-tanstack"
    "packages/@overeng/effect-rpc-tanstack/examples/basic"
    "packages/@overeng/effect-schema-form"
    "packages/@overeng/effect-schema-form-aria"
    "packages/@overeng/genie"
    "packages/@overeng/megarepo"
    "packages/@overeng/mono"
    "packages/@overeng/notion-cli"
    "packages/@overeng/notion-effect-client"
    "packages/@overeng/notion-effect-schema"
    "packages/@overeng/oxc-config"
    "packages/@overeng/react-inspector"
    "packages/@overeng/utils"
    "scripts"
    "context/opentui"
    "context/effect/socket"
  ];

  # Convert path to task name: "packages/@overeng/foo" -> "foo", "context/opentui" -> "context-opentui"
  toName = path: builtins.replaceStrings ["/"] ["-"] (lib.last (lib.splitString "@overeng/" path));

  mkInstallTask = path: {
    "bun:install:${toName path}" = {
      exec = "bun install";
      cwd = path;
      execIfModified = [ "${path}/package.json" "${path}/bun.lock" ];
      after = [ "genie:run" ];
    };
  };

in {
  tasks = lib.mkMerge (map mkInstallTask dirs ++ [
    {
      "bun:install" = {
        description = "Install all bun dependencies";
        after = map (p: "bun:install:${toName p}") dirs;
      };
    }
  ]);
}
