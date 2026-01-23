# Nix CLI build and hash management tasks
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.nix-cli {
#       cliPackages = [
#         { name = "genie"; flakeRef = ".#genie"; buildNix = "packages/@overeng/genie/nix/build.nix"; }
#         { name = "dotdot"; flakeRef = ".#dotdot"; buildNix = "packages/@overeng/dotdot/nix/build.nix"; }
#       ];
#     })
#   ];
#
# Provides:
#   - nix:hash - Update bunDepsHash for all CLI packages
#   - nix:hash:<name> - Update bunDepsHash for specific package
#   - nix:build - Build all CLI packages
#   - nix:build:<name> - Build specific package
#   - nix:check - Check if any hashes are stale (for CI)
{ cliPackages ? [] }:
{ pkgs, lib, ... }:
let
  # Script to update bunDepsHash in a build.nix file
  # Handles two error patterns:
  # 1. Nix fixed-output hash mismatch: "got: sha256-..."
  # 2. Custom bun.lock staleness check: "bunDepsHash is stale"
  updateHashScript = pkgs.writeShellScript "update-bun-hash" ''
    set -euo pipefail
    
    flakeRef="$1"
    buildNix="$2"
    name="$3"
    
    FAKE_HASH="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    
    echo "Checking $name ($flakeRef)..."
    
    # Try to build - if it succeeds, hash is already correct
    if nix build "$flakeRef" --no-link 2>&1; then
      echo "✓ $name: hash is up to date"
      exit 0
    fi
    
    echo "Hash is stale, computing new hash..."
    
    # Read current hash from build.nix
    hashKey="bunDepsHash"
    if rg -q "pnpmDepsHash" "$buildNix"; then
      hashKey="pnpmDepsHash"
    fi
    currentHash=$(grep -oE "$hashKey = \"sha256-[^\"]+\"" "$buildNix" | grep -oE 'sha256-[A-Za-z0-9+/=]+' | head -1 || true)
    
    if [ -z "$currentHash" ]; then
      echo "✗ $name: could not find $hashKey in $buildNix"
      exit 1
    fi
    
    # Replace with fake hash to force Nix to compute the correct one
    export HASH_KEY="$hashKey"
    export HASH_VALUE="$FAKE_HASH"
    perl -0777 -i -pe '
      my $key = $ENV{"HASH_KEY"};
      my $val = $ENV{"HASH_VALUE"};
      s/\b\Q$key\E\s*=\s*"sha256-[^"]+"/$key = "$val"/g;
    ' "$buildNix"
    
    # Build with fake hash to get the correct hash from Nix
    output=$(nix build "$flakeRef" --no-link 2>&1 || true)
    
    # Extract the correct hash from "got: sha256-..."
    newHash=$(echo "$output" | grep -oE 'got:\s+sha256-[A-Za-z0-9+/=]+' | grep -oE 'sha256-[A-Za-z0-9+/=]+' | head -1 || true)
    
    if [ -z "$newHash" ]; then
      echo "✗ $name: could not extract hash from nix build output"
      echo "Restoring original hash..."
      export HASH_KEY="$hashKey"
      export HASH_VALUE="$currentHash"
      perl -0777 -i -pe '
        my $key = $ENV{"HASH_KEY"};
        my $val = $ENV{"HASH_VALUE"};
        s/\b\Q$key\E\s*=\s*"sha256-[^"]+"/$key = "$val"/g;
      ' "$buildNix"
      echo "$output"
      exit 1
    fi
    
    # Check if hash actually changed
    if [ "$newHash" = "$currentHash" ]; then
      echo "Hash unchanged, restoring..."
      export HASH_KEY="$hashKey"
      export HASH_VALUE="$currentHash"
      perl -0777 -i -pe '
        my $key = $ENV{"HASH_KEY"};
        my $val = $ENV{"HASH_VALUE"};
        s/\b\Q$key\E\s*=\s*"sha256-[^"]+"/$key = "$val"/g;
      ' "$buildNix"
      echo "✓ $name: hash is up to date"
      exit 0
    fi
    
    echo "Found new hash: $newHash"
    echo "Updating $buildNix..."
    
    # Update with the correct hash
    export HASH_KEY="$hashKey"
    export HASH_VALUE="$newHash"
    perl -0777 -i -pe '
      my $key = $ENV{"HASH_KEY"};
      my $val = $ENV{"HASH_VALUE"};
      s/\b\Q$key\E\s*=\s*"sha256-[^"]+"/$key = "$val"/g;
    ' "$buildNix"
    
    echo "Verifying build..."
    if ! nix build "$flakeRef" --no-link -L; then
      echo "✗ $name: verification build failed"
      exit 1
    fi
    
    echo "✓ $name: updated to $newHash"
  '';

  # Script to check if hash is stale (for CI)
  # Detects both Nix hash mismatch and custom bun.lock staleness check
  checkHashScript = pkgs.writeShellScript "check-bun-hash" ''
    set -euo pipefail
    
    flakeRef="$1"
    name="$2"
    
    if output=$(nix build "$flakeRef" --no-link 2>&1); then
      echo "✓ $name: up to date"
      exit 0
    fi
    
    # Check for Nix hash mismatch
    if echo "$output" | grep -qE 'got:\s+sha256-'; then
      echo "✗ $name: deps hash is stale (run: dt nix:hash:$name)"
      exit 1
    fi
    
    # Check for custom bun.lock staleness
    if echo "$output" | grep -q 'deps hash is stale'; then
      echo "✗ $name: lockfile changed, deps hash is stale (run: dt nix:hash:$name)"
      exit 1
    fi
    
    echo "✗ $name: build failed"
    echo "$output"
    exit 1
  '';

  # Generate per-package tasks
  mkHashTask = pkg: {
    "nix:hash:${pkg.name}" = {
      description = "Update bunDepsHash for ${pkg.name}";
      exec = "${updateHashScript} '${pkg.flakeRef}' '${pkg.buildNix}' '${pkg.name}'";
    };
  };

  mkBuildTask = pkg: {
    "nix:build:${pkg.name}" = {
      description = "Build ${pkg.name} Nix package";
      exec = "nix build '${pkg.flakeRef}' --no-link -L";
    };
  };

  mkCheckTask = pkg: {
    "nix:check:${pkg.name}" = {
      description = "Check if ${pkg.name} hash is stale";
      exec = "${checkHashScript} '${pkg.flakeRef}' '${pkg.name}'";
    };
  };

  hasPackages = cliPackages != [];

in lib.mkIf hasPackages {
  tasks = lib.mkMerge (
    # Per-package tasks
    (map mkHashTask cliPackages) ++
    (map mkBuildTask cliPackages) ++
    (map mkCheckTask cliPackages) ++
    # Aggregate tasks
    [{
      "nix:hash" = {
        description = "Update bunDepsHash for all CLI packages";
        after = map (p: "nix:hash:${p.name}") cliPackages;
      };

      "nix:build" = {
        description = "Build all CLI Nix packages";
        after = map (p: "nix:build:${p.name}") cliPackages;
      };

      "nix:check" = {
        description = "Check if any CLI hashes are stale (for CI)";
        after = map (p: "nix:check:${p.name}") cliPackages;
      };
    }]
  );
}
