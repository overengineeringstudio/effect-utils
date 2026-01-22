# Clean build artifacts task
#
# Usage in devenv.nix:
#   imports = [ inputs.effect-utils.devenvModules.tasks.clean ];
#
# Or with extra directories:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.clean { extraDirs = [ ".contentlayer" "storybook-static" ]; })
#   ];
#
# Provides: build:clean
{ extraDirs ? [] }:
{ ... }:
let
  extraDirCommands = builtins.concatStringsSep "\n" (
    map (dir: ''find . -type d -name "${dir}" -not -path "*/node_modules/*" -exec rm -rf {} + 2>/dev/null || true'') extraDirs
  );
in
{
  tasks = {
    "build:clean" = {
      description = "Remove all build artifacts (dist, .next, tsbuildinfo${if extraDirs != [] then ", " + builtins.concatStringsSep ", " extraDirs else ""})";
      exec = ''
        echo "Cleaning build artifacts..."
        find . -type d -name "dist" -not -path "*/node_modules/*" -exec rm -rf {} + 2>/dev/null || true
        find . -type d -name ".next" -not -path "*/node_modules/*" -exec rm -rf {} + 2>/dev/null || true
        find . -type f -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete 2>/dev/null || true
        ${extraDirCommands}
        echo "Done"
      '';
    };
  };
}
