# Genie (config file generation) tasks
#
# Usage in devenv.nix:
#   imports = [ inputs.effect-utils.devenvModules.tasks.genie ];
#
# Provides: genie:run, genie:watch, genie:check
#
# NOTE: No pnpm:install:genie dependency here — this shared module is used by
# repos where genie may be a Nix package (no pnpm install needed). Repos that
# use source-mode genie via pnpm should add the dependency in their devenv.nix:
#   tasks."genie:run".after = [ "pnpm:install:genie" ];
#   tasks."genie:watch".after = [ "pnpm:install:genie" ];
#   tasks."genie:check".after = [ "pnpm:install:genie" ];
{ lib, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
in
{
  tasks = {
    "genie:run" = {
      description = "Generate config files from .genie.ts sources";
      exec = trace.exec "genie:run" "genie";
      status = trace.status "genie:run" ''
        set -euo pipefail
        # Skip when generated files are already up to date.
        # Silence output to keep shell entry clean.
        genie --check >/dev/null 2>&1
      '';
    };
    "genie:watch" = {
      description = "Watch and regenerate config files";
      exec = "genie --watch";
    };
    "genie:check" = {
      description = "Check if generated files are up to date (CI)";
      exec = trace.exec "genie:check" "genie --check";
    };
  };
}
