# One fixture authority for retained devenv and the standalone quick projection.
# Both commands inherit the synthetic checkout; never bind cwd to sourceRoot.
{ sourceRoot }:
{ pkgs, ... }:
{
  imports = [ ../worktree-teardown.nix ];
  tasks."buck2:editor:release".exec = ''
    ${pkgs.bun}/bin/bun ${sourceRoot}/packages/@overeng/buck2-tools/src/editor-view.ts release --repo-root "$DEVENV_ROOT" --package .
    if [ "''${WORKTREE_TEARDOWN_EDITOR_RETIRE:-0}" = 1 ]; then
      ${pkgs.bun}/bin/bun ${sourceRoot}/packages/@overeng/buck2-tools/src/editor-view.ts retire --repo-root "$DEVENV_ROOT" --package .
    fi
  '';
}
