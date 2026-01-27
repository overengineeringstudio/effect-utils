{ pkgs }:
/**
 * Create a CLI wrapper that runs a source entrypoint via bun.
 *
 * Intended for devenv shells in the SAME repo where the CLI is defined.
 * Keeps CLIs fast and resilient while flake builds remain strict.
 * The wrapper preserves the CLI name, so shell completions (e.g. `--completions`)
 * keep working. CLIs should rely on resolveCliVersion + NIX_CLI_BUILD_STAMP 
 * to handle __CLI_VERSION__.
 *
 * For consuming CLIs from OTHER repos, use the Nix-built packages instead:
 *   effectUtils.packages.${pkgs.system}.genie
 *
 * See: context/nix-devenv/cli-patterns.md
 *
 * Arguments:
 * - name: CLI binary name
 * - entry: Entry file path relative to WORKSPACE_ROOT or $PWD
 */
{ name, entry }:
pkgs.writeShellScriptBin name ''
  root="''${WORKSPACE_ROOT:-$PWD}"
  exec ${pkgs.bun}/bin/bun "$root/${entry}" "$@"
''
