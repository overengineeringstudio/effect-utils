# Nix CLI build and hash management tasks
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.nix-cli {
#       cliPackages = [
#         { name = "genie"; flakeRef = ".#genie"; buildNix = "packages/@overeng/genie/nix/build.nix"; }
#       ];
#     })
#   ];
#
# Provides:
#   - nix:hash - Update all hashes (pnpmDepsHash + localDeps) for all CLI packages
#   - nix:hash:<name> - Update all hashes for specific package
#   - nix:build - Build all CLI packages
#   - nix:build:<name> - Build specific package
#   - nix:check - Check if any hashes are stale (for CI)
{ cliPackages ? [] }:
{ pkgs, lib, ... }:
let
  # Script to update all hashes in a build.nix file
  # Handles both pnpmDepsHash/bunDepsHash AND localDeps[].hash entries
  # Iteratively updates hashes until build succeeds
  updateHashScript = pkgs.writeShellScript "update-all-hashes" ''
    set -euo pipefail
    
    flakeRef="$1"
    buildNix="$2"
    name="$3"
    
    FAKE_HASH="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    MAX_ITERATIONS=20
    
    echo "Checking $name ($flakeRef)..."
    
    # Try to build - if it succeeds, all hashes are correct
    if nix build "$flakeRef" --no-link 2>&1; then
      echo "✓ $name: all hashes up to date"
      exit 0
    fi
    
    echo "Some hashes are stale, updating..."
    
    # Determine the main hash key (bunDepsHash or pnpmDepsHash)
    mainHashKey="bunDepsHash"
    if rg -q "pnpmDepsHash" "$buildNix"; then
      mainHashKey="pnpmDepsHash"
    fi
    
    updated_any=false
    iteration=0
    
    while [ $iteration -lt $MAX_ITERATIONS ]; do
      iteration=$((iteration + 1))
      echo ""
      echo "=== Iteration $iteration ==="
      
      # Try to build and capture output
      output=$(nix build "$flakeRef" --no-link 2>&1 || true)
      
      # Check if build succeeded
      if echo "$output" | grep -q "^$"; then
        # Empty stderr usually means success, verify
        if nix build "$flakeRef" --no-link 2>&1; then
          echo ""
          if [ "$updated_any" = true ]; then
            echo "✓ $name: all hashes updated successfully"
          else
            echo "✓ $name: all hashes up to date"
          fi
          exit 0
        fi
      fi
      
      # Extract the correct hash from "got: sha256-..."
      newHash=$(echo "$output" | grep -oE 'got:\s+sha256-[A-Za-z0-9+/=]+' | grep -oE 'sha256-[A-Za-z0-9+/=]+' | head -1 || true)
      
      if [ -z "$newHash" ]; then
        # No hash mismatch found - check for pnpm offline install failure
        # This happens when pnpm-lock.yaml changed but the old hash still "works"
        # (fetchPnpmDeps succeeds but creates incomplete store)
        if echo "$output" | grep -qiE "ERR_PNPM_NO_OFFLINE_TARBALL|ERR_PNPM_TARBALL_INTEGRITY|lockfile:.*manifest:"; then
          echo "Detected stale pnpmDepsHash (pnpm offline install failed)"
          echo "Resetting $mainHashKey to trigger complete re-fetch..."

          # Set fake hash to force Nix to re-fetch and report correct hash
          export HASH_KEY="$mainHashKey"
          export HASH_VALUE="$FAKE_HASH"
          perl -0777 -i -pe '
            my $key = $ENV{"HASH_KEY"};
            my $val = $ENV{"HASH_VALUE"};
            s/\b\Q$key\E\s*=\s*"sha256-[^"]+"/$key = "$val"/g;
          ' "$buildNix"

          updated_any=true
          continue  # Next iteration will get the correct hash from mismatch error
        fi

        # Genuine build failure - not a hash issue
        echo "✗ $name: build failed but no hash mismatch found"
        echo "$output"
        exit 1
      fi
      
      # Try to identify which hash needs updating from the error
      # fetchPnpmDeps errors include the pname which contains the dir path
      # e.g., "genie-unwrapped-packages--overeng-utils-pnpm-deps" for localDeps dir "packages/@overeng/utils"
      localDepDir=""
      
      # Look for packages-*-pnpm-deps pattern in the error (indicates localDeps hash)
      if echo "$output" | grep -qE "packages-[a-zA-Z0-9_-]+-pnpm-deps"; then
        # Extract the encoded dir (e.g., "packages--overeng-utils")
        encodedDir=$(echo "$output" | grep -oE "packages-[a-zA-Z0-9_-]+-pnpm-deps" | head -1 | sed 's/-pnpm-deps$//' || true)
        if [ -n "$encodedDir" ]; then
          # Convert back to original path format
          # packages--overeng-utils -> packages/@overeng/utils
          localDepDir=$(echo "$encodedDir" | sed 's/--/\/@/g; s/-/\//g')
          echo "Detected stale hash for localDep: $localDepDir"
        fi
      fi
      
      if [ -n "$localDepDir" ]; then
        # Update localDeps hash for this specific dir
        echo "Updating localDeps hash for $localDepDir to $newHash..."
        
        # Use perl to update the specific localDeps entry
        export LOCAL_DEP_DIR="$localDepDir"
        export NEW_HASH="$newHash"
        perl -0777 -i -pe '
          my $dir = $ENV{"LOCAL_DEP_DIR"};
          my $hash = $ENV{"NEW_HASH"};
          s/(\{\s*dir\s*=\s*"\Q$dir\E"\s*;\s*hash\s*=\s*)"sha256-[^"]+"/$1"$hash"/g;
        ' "$buildNix"
        
        updated_any=true
      else
        # Assume it is the main hash (pnpmDepsHash/bunDepsHash)
        echo "Updating $mainHashKey to $newHash..."
        
        export HASH_KEY="$mainHashKey"
        export HASH_VALUE="$newHash"
        perl -0777 -i -pe '
          my $key = $ENV{"HASH_KEY"};
          my $val = $ENV{"HASH_VALUE"};
          s/\b\Q$key\E\s*=\s*"sha256-[^"]+"/$key = "$val"/g;
        ' "$buildNix"
        
        updated_any=true
      fi
    done
    
    echo "✗ $name: exceeded max iterations ($MAX_ITERATIONS), something is wrong"
    exit 1
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
  # nix:hash depends on pnpm:install to ensure lockfile is up-to-date before computing hash
  mkHashTask = pkg: {
    "nix:hash:${pkg.name}" = {
      description = "Update all Nix hashes for ${pkg.name} (pnpmDepsHash + localDeps)";
      exec = "${updateHashScript} '${pkg.flakeRef}' '${pkg.buildNix}' '${pkg.name}'";
      after = [ "pnpm:install:${pkg.name}" ];
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
        description = "Update all Nix hashes for all CLI packages";
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
