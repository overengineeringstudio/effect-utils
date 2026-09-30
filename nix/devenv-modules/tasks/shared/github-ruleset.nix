{
  repo,
  ruleset ? null,
  file ? ".github/repo-settings.json",
  taskPrefix ? "gh",
  after ? [ "genie:run" ],
  genieBin ? null,
}:
{
  lib,
  pkgs,
  config ? { },
  ...
}:
let
  trace = import ../lib/trace.nix { inherit lib; };
  geniePackage = lib.attrByPath [ "effectUtils" "genie" "package" ] null config;
  mkLauncher = import ../../../github-repo-settings.nix {
    inherit pkgs;
    genieBin =
      if genieBin != null then
        genieBin
      else if geniePackage == null then
        "genie"
      else
        "${geniePackage}/bin/genie";
  };
  mkTask =
    mode:
    let
      verb = if mode == "apply" then "Apply" else "Check";
      taskName = "${taskPrefix}:${mode}-settings";
      launcher = mkLauncher mode;
    in
    {
      "${taskName}" = {
        inherit after;
        description = "${verb} ${file} ${
          if mode == "apply" then "to" else "against"
        } the live GitHub repository settings";
        exec = trace.exec taskName ''
          set -euo pipefail
          ${launcher}/bin/gh-${mode}-settings \
            --repo ${lib.escapeShellArg repo} \
            --file ${lib.escapeShellArg file} \
            ${lib.optionalString (ruleset != null) "--ruleset ${lib.escapeShellArg ruleset}"}
        '';
      };
    };
in
{
  tasks = lib.mkMerge [
    (mkTask "apply")
    (mkTask "check")
  ];
}
