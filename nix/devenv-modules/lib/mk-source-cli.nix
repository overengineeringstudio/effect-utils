{ pkgs }:
/**
 * Create a CLI wrapper that runs a source entrypoint via bun.
 *
 * Intended for devenv shells: keeps CLIs fast and resilient while flake
 * builds remain strict. The wrapper preserves the CLI name, so shell
 * completions (e.g. `--completions`) keep working. CLIs should rely on
 * resolveCliVersion + NIX_CLI_BUILD_STAMP to handle __CLI_VERSION__.
 *
 * Arguments:
 * - name: CLI binary name
 * - entry: Entry file path relative to root
 * - root: (optional) Workspace root path. If provided, baked in at Nix eval time.
 *         If omitted, uses WORKSPACE_ROOT env var at runtime (for internal use).
 */
{ name, entry, root ? null }:
pkgs.writeShellScriptBin name (
  if root != null then ''
    exec ${pkgs.bun}/bin/bun "${root}/${entry}" "$@"
  '' else ''
    root="''${WORKSPACE_ROOT:-$PWD}"
    exec ${pkgs.bun}/bin/bun "$root/${entry}" "$@"
  ''
)
