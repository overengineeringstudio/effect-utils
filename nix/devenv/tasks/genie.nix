{ ... }:
{
  tasks = {
    "genie:run" = {
      description = "Generate package.json and tsconfig.json from .genie.ts files";
      exec = "genie";
      execIfModified = [ "**/*.genie.ts" ];
    };
    "genie:watch" = {
      description = "Watch and regenerate config files";
      exec = "genie --watch";
    };
    "genie:check" = {
      description = "Check if generated files are up to date (CI)";
      exec = "genie --check";
      execIfModified = [ "**/*.genie.ts" ];
    };
  };
}
