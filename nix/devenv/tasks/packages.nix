# Shared package definitions for devenv tasks
{ lib }:
{
  # All packages that need bun install
  allPackages = [
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

  # Packages that have vitest tests (subset of allPackages)
  packagesWithTests = [
    "packages/@overeng/dotdot"
    "packages/@overeng/effect-ai-claude-cli"
    "packages/@overeng/effect-path"
    "packages/@overeng/effect-rpc-tanstack"
    "packages/@overeng/genie"
    "packages/@overeng/megarepo"
    "packages/@overeng/mono"
    "packages/@overeng/notion-cli"
    "packages/@overeng/notion-effect-client"
    "packages/@overeng/notion-effect-schema"
    "packages/@overeng/oxc-config"
    "packages/@overeng/utils"
  ];

  # Convert path to task name: "packages/@overeng/foo" -> "foo", "context/opentui" -> "context-opentui"
  toName = path: builtins.replaceStrings ["/"] ["-"] (lib.last (lib.splitString "@overeng/" path));
}
