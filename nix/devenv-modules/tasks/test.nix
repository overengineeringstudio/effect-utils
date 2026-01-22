# Test tasks (vitest)
#
# Usage in devenv.nix:
#   imports = [ inputs.effect-utils.devenvModules.tasks.test ];
#
# Provides: test:run, test:watch
{ ... }:
{
  tasks = {
    "test:run" = {
      description = "Run all tests";
      exec = "vitest run";
      after = [ "genie:run" ];
    };
    "test:watch" = {
      description = "Run tests in watch mode";
      exec = "vitest";
      after = [ "genie:run" ];
    };
  };
}
