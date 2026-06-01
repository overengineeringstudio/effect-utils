# Changesets hygiene tasks
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.changesets { })
#   ];
#
#   # With a non-default changeset directory:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.changesets { dir = ".changesets"; })
#   ];
#
# Provides:
#   - release:changeset:check-bodies — Reject malformed Changesets (empty
#     frontmatter and empty body). Catches `changeset add --empty` invocations
#     whose `---\n---\n` placeholder was never filled in, which would otherwise
#     enter the release-intent ledger as silent noise.
#
# A changeset is rejected when **both** hold:
#   1. Its YAML frontmatter has no package bumps (truly empty).
#   2. Its body (everything after the closing `---`) is empty.
#
# The check itself is generic — no repo-specific paths. Wire it into your CI
# changeset-validation job alongside `@changesets/cli` so empty placeholders
# never reach `main`.
{
  dir ? ".changeset",
  taskNamePrefix ? "release:changeset",
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  checkBodiesScript = pkgs.writeText "check-bodies.ts" (
    builtins.readFile ./changesets/check-bodies.ts
  );
  taskName = "${taskNamePrefix}:check-bodies";
in
{
  tasks."${taskName}" = {
    description = "Reject malformed Changesets (empty frontmatter and empty body)";
    exec = trace.exec taskName ''
      set -euo pipefail
      cd "$DEVENV_ROOT"
      ${pkgs.bun}/bin/bun ${checkBodiesScript} --dir ${lib.escapeShellArg dir}
    '';
  };
}
