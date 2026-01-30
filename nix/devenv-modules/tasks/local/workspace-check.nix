# Local workspace validation for effect-utils repo
#
# This module is LOCAL to the effect-utils repo and NOT meant for reuse.
# It validates repo-specific configuration like allPackages in devenv.nix.
#
# Provides: workspace:check
{ pkgs, ... }:
{
  tasks."workspace:check" = {
    description = "Validate workspace configuration (allPackages)";
    exec = ''
      set -euo pipefail

      echo "Checking allPackages matches filesystem packages..."

      # Find all packages/@overeng/* directories that have package.json (real packages)
      actual=$(find packages/@overeng -maxdepth 1 -type d -exec test -f {}/package.json \; -print | sort)

      # Extract packages from allPackages list in devenv.nix
      declared=$(grep -o '"packages/@[^"]*"' devenv.nix | tr -d '"' | sort)

      # Find packages on filesystem but not in allPackages
      missing=$(comm -23 <(echo "$actual") <(echo "$declared"))

      if [ -n "$missing" ]; then
        echo ""
        echo "❌ Error: These packages exist but are NOT in allPackages:"
        echo "$missing" | sed 's/^/   /'
        echo ""
        echo "Add them to allPackages in devenv.nix:"
        echo "$missing" | while read -r pkg; do
          echo "    \"$pkg\""
        done
        echo ""
        exit 1
      fi

      # Find packages in allPackages that don't exist on filesystem
      orphaned=$(comm -13 <(echo "$actual") <(echo "$declared"))

      if [ -n "$orphaned" ]; then
        echo ""
        echo "⚠️  Warning: These packages are in allPackages but don't exist on filesystem:"
        echo "$orphaned" | sed 's/^/   /'
        echo ""
      fi

      echo "✓ allPackages is complete and matches filesystem"
    '';
  };
}
