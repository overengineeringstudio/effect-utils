# Nix CLI build, hash management, and flake validation tasks
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
#   - nix:hash - Update all hashes (pnpmDepsHash + lockfileHash + packageJsonDepsHash) for all CLI packages
#   - nix:hash:<name> - Update all hashes for specific package
#   - nix:build - Build all CLI packages
#   - nix:build:<name> - Build specific package
#   - nix:check - Check if any CLI hashes are stale (full build per package)
#   - nix:check:quick - Fast lockfile + package.json fingerprint check (for check:quick)
#   - nix:flake:check - Full flake validation (builds all packages, for check:all)
#
# Lockfile and Package.json Fingerprint Checks (nix:check:quick):
#   Each build.nix stores two fingerprint hashes for fast stale detection:
#
#   1. `lockfileHash` - SHA256 of pnpm-lock.yaml when pnpmDepsHash was last computed.
#      Detects lockfile changes without hash updates. This catches most stale hash
#      scenarios and runs in <1s vs 80-120s for full nix build.
#
#   2. `packageJsonDepsHash` - SHA256 of package.json dependency fields (dependencies,
#      devDependencies, peerDependencies). Detects when package.json deps changed
#      but lockfile wasn't updated (forgetting to run `pnpm install`).
#
#   Trade-off: May have rare false positives (cosmetic changes) or false negatives
#   (patch files changed). CI runs full `nix:flake:check` as backup.
#
# nix:flake:check vs nix:check:
#   - nix:check - Validates individual CLI package hashes (per-package builds)
#   - nix:flake:check - Runs `nix flake check` (validates entire flake, all packages)
{ cliPackages ? [] }:
{ pkgs, lib, ... }:
let
  # Script to update all hashes in a build.nix file
  # Handles pnpmDepsHash/bunDepsHash, lockfileHash, and packageJsonDepsHash
  # Iteratively updates hashes until build succeeds
  updateHashScript = pkgs.writeShellScript "update-all-hashes" ''
    set -euo pipefail

    flakeRef="$1"
    buildNix="$2"
    name="$3"
    lockfile="$4"

    FAKE_HASH="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    MAX_ITERATIONS=20

    # Helper function to update a hash value in build.nix
    # Handles both simple hashes and platform-specific (if isDarwin then/else) patterns
    # Args: $1=hashKey (e.g., pnpmDepsHash), $2=newValue, $3=buildNixPath
    update_hash_in_file() {
      local hashKey="$1"
      local newValue="$2"
      local buildNixPath="$3"

      # Check if this is a platform-specific hash (if pkgs.stdenv.isDarwin pattern)
      if grep -qE "$hashKey\s*=\s*if\s+pkgs\.stdenv\.isDarwin" "$buildNixPath"; then
        # Platform-specific hash - update only the current platform's hash
        if [[ "$(uname -s)" == "Darwin" ]]; then
          echo "  (platform-specific: updating Darwin/then branch)"
          export HASH_KEY="$hashKey"
          export HASH_VALUE="$newValue"
          perl -0777 -i -pe '
            my $key = $ENV{"HASH_KEY"};
            my $val = $ENV{"HASH_VALUE"};
            # Match: pnpmDepsHash = if pkgs.stdenv.isDarwin\s+then "sha256-..."
            s/(\b\Q$key\E\s*=\s*if\s+pkgs\.stdenv\.isDarwin\s+then\s+)"sha256-[^"]+"/$1"$val"/gs;
          ' "$buildNixPath"
        else
          echo "  (platform-specific: updating Linux/else branch)"
          export HASH_KEY="$hashKey"
          export HASH_VALUE="$newValue"
          perl -0777 -i -pe '
            my $key = $ENV{"HASH_KEY"};
            my $val = $ENV{"HASH_VALUE"};
            # Match the else branch: ... then "sha256-..." else "sha256-..."
            s/(\b\Q$key\E\s*=\s*if\s+pkgs\.stdenv\.isDarwin\s+then\s+"sha256-[^"]+"\s+else\s+)"sha256-[^"]+"/$1"$val"/gs;
          ' "$buildNixPath"
        fi
      else
        # Simple single hash pattern
        export HASH_KEY="$hashKey"
        export HASH_VALUE="$newValue"
        perl -0777 -i -pe '
          my $key = $ENV{"HASH_KEY"};
          my $val = $ENV{"HASH_VALUE"};
          s/\b\Q$key\E\s*=\s*"sha256-[^"]+"/$key = "$val"/g;
        ' "$buildNixPath"
      fi
    }

    # Helper to update lockfileHash and packageJsonDepsHash in build.nix
    update_fingerprint_hashes() {
      if [ -n "$lockfile" ] && [ -f "$lockfile" ]; then
        # Update lockfileHash
        newLockfileHash="sha256-$(nix-hash --type sha256 --base64 "$lockfile")"
        if grep -q "lockfileHash" "$buildNix"; then
          export NEW_LF_HASH="$newLockfileHash"
          perl -i -pe 's/lockfileHash\s*=\s*"sha256-[^"]+"/lockfileHash = "$ENV{NEW_LF_HASH}"/g' "$buildNix"
          echo "Updated lockfileHash to $newLockfileHash"
        fi

        # Update packageJsonDepsHash (package.json deps fingerprint)
        packageJson="$(dirname "$lockfile")/package.json"
        if [ -f "$packageJson" ] && grep -q "packageJsonDepsHash" "$buildNix"; then
          tmpDeps=$(mktemp)
          ${pkgs.jq}/bin/jq -cS '{dependencies, devDependencies, peerDependencies}' "$packageJson" > "$tmpDeps"
          newPackageJsonDepsHash="sha256-$(nix-hash --type sha256 --base64 "$tmpDeps")"
          rm "$tmpDeps"
          export NEW_PACKAGE_JSON_DEPS_HASH="$newPackageJsonDepsHash"
          perl -i -pe 's/packageJsonDepsHash\s*=\s*"sha256-[^"]+"/packageJsonDepsHash = "$ENV{NEW_PACKAGE_JSON_DEPS_HASH}"/g' "$buildNix"
          echo "Updated packageJsonDepsHash to $newPackageJsonDepsHash"
        fi
      fi
    }

    extract_got_hash() {
      echo "$1" | grep -oE 'got:\s+sha256-[A-Za-z0-9+/=]+' | grep -oE 'sha256-[A-Za-z0-9+/=]+' | head -1 || true
    }

    extract_actual_hash() {
      echo "$1" | grep -oE 'actual:\s+sha256-[A-Za-z0-9+/=]+' | grep -oE 'sha256-[A-Za-z0-9+/=]+' | head -1 || true
    }

    echo "Checking $name ($flakeRef)..."

    update_fingerprint_hashes

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
      
      set +e
      output=$(nix build "$flakeRef" --no-link 2>&1)
      status=$?
      set -e

      if [ $status -eq 0 ]; then
        echo ""
        if [ "$updated_any" = true ]; then
          echo "✓ $name: all hashes updated successfully"
        else
          echo "✓ $name: all hashes up to date"
        fi
        update_fingerprint_hashes
        exit 0
      fi

      newHash=$(extract_got_hash "$output")
      actualHash=$(extract_actual_hash "$output")

      if [ -n "$actualHash" ] && grep -q "lockfileHash" "$buildNix"; then
        export NEW_LF_HASH="$actualHash"
        perl -i -pe 's/lockfileHash\s*=\s*"sha256-[^"]+"/lockfileHash = "$ENV{NEW_LF_HASH}"/g' "$buildNix"
        echo "Updated lockfileHash to $actualHash"
        updated_any=true
        continue
      fi

      if [ -z "$newHash" ]; then
        # No hash mismatch found - check for pnpm offline install failure
        # This happens when pnpm-lock.yaml changed but the old hash still "works"
        # (fetchPnpmDeps succeeds but creates incomplete store)
        if echo "$output" | grep -qiE "ERR_PNPM_NO_OFFLINE_TARBALL|ERR_PNPM_TARBALL_INTEGRITY|lockfile:.*manifest:"; then
          echo "Detected stale pnpmDepsHash (pnpm offline install failed)"
          echo "Resetting $mainHashKey to trigger complete re-fetch..."

          # Set fake hash to force Nix to re-fetch and report correct hash
          update_hash_in_file "$mainHashKey" "$FAKE_HASH" "$buildNix"

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
        update_hash_in_file "$mainHashKey" "$newHash" "$buildNix"
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

    if echo "$output" | grep -q 'lockfileHash is stale'; then
      echo "✗ $name: lockfileHash is stale (run: dt nix:hash:$name)"
      exit 1
    fi

    # Check for custom bun.lock staleness
    if echo "$output" | grep -q 'deps hash is stale'; then
      echo "✗ $name: lockfile changed, deps hash is stale (run: dt nix:hash:$name)"
      exit 1
    fi

    # Check for pnpm lockfile staleness (new deps added but not locked)
    if echo "$output" | grep -qE 'ERR_PNPM_OUTDATED_LOCKFILE|lockfile.*not up to date'; then
      echo "✗ $name: pnpm lockfile is stale (new deps added but not locked)"
      echo ""
      echo "To fix:"
      echo "  1. Run: dt pnpm:update     # Update all lockfiles"
      echo "  2. Run: dt nix:hash:$name  # Update Nix hashes"
      echo "  3. Commit: pnpm-lock.yaml changes and build.nix hash updates"
      echo ""
      exit 1
    fi

    if echo "$output" | grep -qi 'ERR_PNPM_NO_OFFLINE_TARBALL'; then
      echo "✗ $name: Nix pnpm store is missing tarballs (offline install failed)"
      echo ""
      echo "To fix:"
      echo "  1. Run: dt nix:hash:$name  # Refresh pnpmDepsHash and vendored store"
      echo "  2. If lockfiles changed: dt pnpm:update"
      echo ""
      exit 1
    fi

    echo "✗ $name: build failed"
    echo "$output"
    exit 1
  '';

  # Script for quick lockfile/deps fingerprint check (for check:quick)
  # Checks two things:
  # 1. lockfileHash - detects lockfile changes without hash update
  # 2. packageJsonDepsHash - detects package.json changes without lockfile update
  quickCheckScript = pkgs.writeShellScript "check-lockfile-hash" ''
    set -euo pipefail

    name="$1"
    buildNix="$2"
    lockfile="$3"

    # Derive package.json path from lockfile path
    packageJson="$(dirname "$lockfile")/package.json"
    failed=false

    # Check 1: lockfileHash (lockfile changed without hash update)
    currentLockfileHash=$(nix-hash --type sha256 --base64 "$lockfile" 2>/dev/null || echo "")
    if [ -z "$currentLockfileHash" ]; then
      echo "⚠ $name: lockfile not found ($lockfile), skipping lockfile check"
    else
      currentLockfileHash="sha256-$currentLockfileHash"
      storedLockfileHash=$(grep -oE 'lockfileHash\s*=\s*"sha256-[^"]+"' "$buildNix" | grep -oE 'sha256-[^"]+' | head -1 || echo "")

      if [ -z "$storedLockfileHash" ]; then
        echo "⚠ $name: no lockfileHash in build.nix, skipping lockfile check"
      elif [ "$currentLockfileHash" != "$storedLockfileHash" ]; then
        echo "✗ $name: lockfile changed (run: dt nix:hash:$name)"
        echo "  stored:  $storedLockfileHash"
        echo "  current: $currentLockfileHash"
        failed=true
      fi
    fi

    # Check 2: packageJsonDepsHash (package.json deps changed without lockfile update)
    if [ -f "$packageJson" ]; then
      tmpDeps=$(mktemp)
      ${pkgs.jq}/bin/jq -cS '{dependencies, devDependencies, peerDependencies}' "$packageJson" > "$tmpDeps"
      currentPackageJsonDepsHash="sha256-$(nix-hash --type sha256 --base64 "$tmpDeps")"
      rm "$tmpDeps"

      storedPackageJsonDepsHash=$(grep -oE 'packageJsonDepsHash\s*=\s*"sha256-[^"]+"' "$buildNix" | grep -oE 'sha256-[^"]+' | head -1 || echo "")

      if [ -z "$storedPackageJsonDepsHash" ]; then
        echo "⚠ $name: no packageJsonDepsHash in build.nix, skipping deps check"
      elif [ "$currentPackageJsonDepsHash" != "$storedPackageJsonDepsHash" ]; then
        echo "✗ $name: package.json deps changed (run: pnpm install && dt nix:hash:$name)"
        echo "  stored:  $storedPackageJsonDepsHash"
        echo "  current: $currentPackageJsonDepsHash"
        failed=true
      fi
    fi

    if [ "$failed" = true ]; then
      exit 1
    fi

    echo "✓ $name: lockfile and deps unchanged"
  '';

  # Script to run nix-cli tests colocated with this module
  nixTestsScript = pkgs.writeShellScript "nix-cli-tests" ''
    set -euo pipefail
    testDir="${toString ./tests}"
    if [ ! -d "$testDir" ]; then
      echo "No nix-cli tests found (missing $testDir)"
      exit 1
    fi

    for testFile in "$testDir"/*.test.sh; do
      if [ ! -f "$testFile" ]; then
        echo "No nix-cli tests found in $testDir"
        exit 1
      fi
      echo "Running $testFile"
      bash "$testFile"
    done
  '';

  # Generate per-package tasks
  mkHashTask = pkg: {
    "nix:hash:${pkg.name}" = {
      description = "Update Nix hashes for ${pkg.name}";
      exec = "${updateHashScript} '${pkg.flakeRef}' '${pkg.buildNix}' '${pkg.name}' '${pkg.lockfile or ""}'";
      # pnpm:install ensures lockfile is current before we compute hashes.
      # Hash computation reads the lockfile to update lockfileHash fingerprint.
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
      # Depends on full workspace pnpm:install (not per-package).
      # Nix builds stage the entire workspace, so any stale lockfile in any package
      # breaks the build. Per-package install only updates that package's lockfile,
      # but Nix sees the whole workspace including stale packages like tui-react.
      after = lib.optional (pkg ? lockfile) "pnpm:install";
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
      "nix:test" = {
        description = "Run nix-cli tooling tests";
        exec = "${nixTestsScript}";
      };

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

      "nix:flake:check" = {
        description = "Full nix flake validation (builds all flake packages)";
        exec = "nix flake check";
      };
    }]
  );
}
