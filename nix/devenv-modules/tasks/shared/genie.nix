# Genie (config file generation) tasks
#
# Usage in devenv.nix:
#   imports = [ inputs.effect-utils.devenvModules.tasks.genie ];
#
# Provides: genie:run, genie:watch, genie:check
{ ... }:
{
  tasks = {
    "genie:run" = {
      description = "Generate config files from .genie.ts sources";
      exec = "genie";
    };
    "genie:watch" = {
      description = "Watch and regenerate config files";
      exec = "genie --watch";
    };
    "genie:check" = {
      description = "Check if generated files are up to date (CI)";
      exec = "genie --check";
    };
  };
}
