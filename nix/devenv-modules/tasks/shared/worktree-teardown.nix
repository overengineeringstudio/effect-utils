# Explicit, offline pre-removal lifecycle task; never wire it into another task.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  trace = import ../lib/trace.nix { inherit lib; };
  teardown = pkgs.writeShellScript "worktree-teardown" (builtins.readFile ./worktree-teardown.sh);
in
{
  tasks."worktree:teardown" = {
    description = "Stop worktree-owned daemons and release state before worktree removal";
    exec = trace.exec "worktree:teardown" ''
      set -euo pipefail
      export PATH=${
        lib.makeBinPath [
          pkgs.git
          pkgs.coreutils
          pkgs.findutils
          pkgs.watchman
        ]
      }:"$PATH"
      export WORKTREE_TEARDOWN_EDITOR_RELEASE=${
        if builtins.hasAttr "buck2:editor:release" config.tasks then "1" else "0"
      }
      exec ${teardown}
    '';
  };
}
