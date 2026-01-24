{ pkgs }:
/**
 * Create a CLI wrapper that runs a source entrypoint via bun.
 *
 * Intended for devenv shells: keeps CLIs fast and resilient while flake
 * builds remain strict. The wrapper preserves the CLI name, so shell
 * completions (e.g. `--completions`) keep working. CLIs should rely on
 * resolveCliVersion + NIX_CLI_BUILD_STAMP to handle __CLI_VERSION__.
 */
{ name, entry }:
pkgs.writeShellScriptBin name ''
  root="''${WORKSPACE_ROOT:-$PWD}"
  exec ${pkgs.bun}/bin/bun "$root/${entry}" "$@"
''
