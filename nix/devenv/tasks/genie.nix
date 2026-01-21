{ ... }:
{
  tasks = {
    "genie:run" = {
      exec = "genie";
      execIfModified = [ "**/*.genie.ts" ];
    };
  };
}
