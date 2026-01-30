# Nix CLI build and hash management tasks
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.nix-cli {
#       cliPackages = [
#         { name = "genie"; flakeRef = ".#genie"; buildNix = "packages/@overeng/genie/nix/build.nix"; lockfile = "packages/@overeng/genie/pnpm-lock.yaml"; }
#       ];
#     })
#   ];
#
# Provides:
#   - nix:hash - Update all hashes (pnpmDepsHash + lockfileHash) for all CLI packages
#   - nix:hash:<name> - Update all hashes for specific package
#   - nix:build - Build all CLI packages
#   - nix:build:<name> - Build specific package
#   - nix:check - Check if any hashes are stale (for CI, does full build)
#   - nix:check:quick - Fast lockfile fingerprint check (for check:quick)
#
# Lockfile Fingerprint Check:
#   Each build.nix stores a `lockfileHash` - the SHA256 of the lockfile when
#   pnpmDepsHash was last computed. The quick check compares current lockfile
#   hash against this stored value. If they differ, the pnpmDepsHash is likely
#   stale. This runs in <1s vs 80-120s for full nix build.
#
#   Trade-off: May have rare false positives (lockfile changed cosmetically)
#   or false negatives (patch files changed). CI runs full check as backup.
{ cliPackages ? [] }:
{ pkgs, lib, ... }:
let
  # Script to update all hashes in a build.nix file
  # Handles pnpmDepsHash/bunDepsHash AND lockfileHash
  # Iteratively updates hashes until build succeeds
  updateHashScript = pkgs.writeShellScript "update-all-hashes" ''
    set -euo pipefail

    flakeRef="$1"
    buildNix="$2"
    name="$3"
    lockfile="$4"

    FAKE_HASH="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    MAX_ITERATIONS=20

    # Helper to update lockfileHash in build.nix
    update_lockfile_hash() {
      if [ -n "$lockfile" ] && [ -f "$lockfile" ]; then
        newLockfileHash="sha256-$(nix-hash --type sha256 --base64 "$lockfile")"
        if grep -q "lockfileHash" "$buildNix"; then
          export NEW_LF_HASH="$newLockfileHash"
          perl -i -pe 's/lockfileHash\s*=\s*"sha256-[^"]+"/lockfileHash = "$ENV{NEW_LF_HASH}"/g' "$buildNix"
          echo "Updated lockfileHash to $newLockfileHash"
        fi
      fi
    }

    echo "Checking $name ($flakeRef)..."

    # Try to build - if it succeeds, all hashes are correct
    if nix build "$flakeRef" --no-link 2>&1; then
      echo "✓ $name: all hashes up to date"
      update_lockfile_hash
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
          update_lockfile_hash
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
  checkHashScript = pkgs.writeShellScript "check-hash" ''
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

  # Script for quick lockfile fingerprint check (for check:quick)
  # Compares current lockfile SHA256 against stored lockfileHash in build.nix
  # Fast (<1s) but may miss some edge cases (patch file changes)
  quickCheckScript = pkgs.writeShellScript "check-lockfile-hash" ''
    set -euo pipefail

    name="$1"
    buildNix="$2"
    lockfile="$3"

    # Compute current lockfile hash
    currentHash=$(nix-hash --type sha256 --base64 "$lockfile" 2>/dev/null || echo "")
    if [ -z "$currentHash" ]; then
      echo "⚠ $name: lockfile not found ($lockfile), skipping quick check"
      exit 0
    fi
    currentHash="sha256-$currentHash"

    # Extract stored lockfileHash from build.nix
    storedHash=$(grep -oE 'lockfileHash\s*=\s*"sha256-[^"]+"' "$buildNix" | grep -oE 'sha256-[^"]+' | head -1 || echo "")

    if [ -z "$storedHash" ]; then
      echo "⚠ $name: no lockfileHash in build.nix, skipping quick check"
      exit 0
    fi

    if [ "$currentHash" = "$storedHash" ]; then
      echo "✓ $name: lockfile unchanged"
      exit 0
    else
      echo "✗ $name: lockfile changed (run: dt nix:hash:$name)"
      echo "  stored:  $storedHash"
      echo "  current: $currentHash"
      exit 1
    fi
  '';

  # Generate per-package tasks
  # nix:hash depends on pnpm:install to ensure lockfile is up-to-date before computing hash
  mkHashTask = pkg: {
    "nix:hash:${pkg.name}" = {
      description = "Update Nix hashes for ${pkg.name}";
      exec = "${updateHashScript} '${pkg.flakeRef}' '${pkg.buildNix}' '${pkg.name}' '${pkg.lockfile or ""}'";
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
      description = "Check if ${pkg.name} hash is stale (full build)";
      exec = "${checkHashScript} '${pkg.flakeRef}' '${pkg.name}'";
    };
  };

  # Quick check using lockfile fingerprint (for check:quick)
  mkQuickCheckTask = pkg: lib.optionalAttrs (pkg ? lockfile) {
    "nix:check:quick:${pkg.name}" = {
      description = "Quick lockfile check for ${pkg.name}";
      exec = "${quickCheckScript} '${pkg.name}' '${pkg.buildNix}' '${pkg.lockfile}'";
    };
  };

  # Filter packages that have lockfile defined
  packagesWithLockfile = builtins.filter (p: p ? lockfile) cliPackages;

  hasPackages = cliPackages != [];

in lib.mkIf hasPackages {
  tasks = lib.mkMerge (
    # Per-package tasks
    (map mkHashTask cliPackages) ++
    (map mkBuildTask cliPackages) ++
    (map mkCheckTask cliPackages) ++
    (map mkQuickCheckTask packagesWithLockfile) ++
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
        description = "Check if any CLI hashes are stale (for CI, full build)";
        after = map (p: "nix:check:${p.name}") cliPackages;
      };

      "nix:check:quick" = {
        description = "Quick lockfile fingerprint check for all CLI packages";
        after = map (p: "nix:check:quick:${p.name}") packagesWithLockfile;
      };
    }]
  );
}
