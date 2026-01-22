# Setup task module - runs common setup tasks on shell entry
#
# Wires specified tasks to run as dependencies of devenv:enterShell.
# This uses native devenv task dependency resolution, avoiding the
# double shell entry that occurs when calling `dt` from enterShell.
#
# Usage in devenv.nix:
#   imports = [
#     (taskModules.setup {
#       tasks = [ "pnpm:install" "genie:run" "ts:build" ];
#     })
#   ];
#
# The tasks will run in parallel (respecting their own dependencies)
# as part of the shell entry process.
{
  tasks ? [ "genie:run" ],
}:
{ lib, ... }:
{
  # Wire setup tasks to run during shell entry via native task dependencies
  # This runs tasks as part of devenv's task system without spawning a new shell
  tasks."devenv:enterShell".after = tasks;

  # Also provide setup:run for manual invocation (e.g., `dt setup:run`)
  tasks."setup:run" = {
    description = "Run setup tasks (install deps, generate configs, build)";
    after = tasks;
  };
}
