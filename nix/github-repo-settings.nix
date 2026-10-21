# Share argument forwarding and the gh runtime PATH between flake apps and devenv tasks.
# The existing Genie Buck product bundles the settings CLI and its schema runtime offline.
{
  pkgs,
  genieBin ? "genie",
}:
mode:
pkgs.writeShellScriptBin "gh-${mode}-settings" ''
  export PATH=${pkgs.lib.makeBinPath [ pkgs.gh ]}:"$PATH"
  exec ${pkgs.lib.escapeShellArg (toString genieBin)} github-settings --mode ${pkgs.lib.escapeShellArg mode} "$@"
''
