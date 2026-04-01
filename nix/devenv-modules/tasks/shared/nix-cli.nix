# Nix CLI build, hash management, and flake validation tasks
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.nix-cli {
#       cliPackages = [
#         {
#           name = "genie";
#           flakeRef = ".#genie";
#           hashSource = "packages/@overeng/genie/nix/build.nix";
#           lockfile = "pnpm-lock.yaml";
#         }
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
#   Each hashSource stores two fingerprint hashes for fast stale detection:
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
{
  cliPackages ? [ ],
}:
{ pkgs, lib, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  hashSourceHelpers = ''
    read_hash_from_file() {
      local hashKey="$1"
      local hashSourcePath="$2"
      local packageName="$3"

      if grep -qE "(^|[[:space:]])(\"$packageName\"|$packageName)\\s*=" "$hashSourcePath"; then
        HASH_KEY="$hashKey" PKG_NAME="$packageName" ${pkgs.perl}/bin/perl -0777 -ne '
          my $pkg = $ENV{"PKG_NAME"};
          my $key = $ENV{"HASH_KEY"};
          my $attr = qr/(?:\Q$pkg\E|"\Q$pkg\E")/;
          if (/($attr\s*=\s*\{.*?\b\Q$key\E\s*=\s*)"([^"]+)"/s) {
            print $2;
          }
        ' "$hashSourcePath"
      else
        grep -oE "$hashKey\\s*=\\s*\"sha256-[^\"]+\"" "$hashSourcePath" | grep -oE 'sha256-[^"]+' | head -1 || true
      fi
    }

    update_hash_in_file() {
      local hashKey="$1"
      local newValue="$2"
      local hashSourcePath="$3"
      local packageName="$4"

      export HASH_KEY="$hashKey"
      export HASH_VALUE="$newValue"
      export PKG_NAME="$packageName"

      if grep -qE "(^|[[:space:]])(\"$packageName\"|$packageName)\\s*=" "$hashSourcePath"; then
        ${pkgs.perl}/bin/perl -0777 -i -pe '
          my $pkg = $ENV{"PKG_NAME"};
          my $key = $ENV{"HASH_KEY"};
          my $val = $ENV{"HASH_VALUE"};
          my $attr = qr/(?:\Q$pkg\E|"\Q$pkg\E")/;

          if (/($attr\s*=\s*\{.*?\b\Q$key\E\s*=\s*)"sha256-[^"]+"/s) {
            s/($attr\s*=\s*\{.*?\b\Q$key\E\s*=\s*)"sha256-[^"]+"/$1"$val"/s;
          } else {
            die "Could not find scoped hash $key for package $pkg in $ARGV\n";
          }
        ' "$hashSourcePath"
        return
      fi

      if grep -qE "$hashKey\s*=\s*if\s+pkgs\.stdenv\.isDarwin" "$hashSourcePath"; then
        if [[ "$(uname -s)" == "Darwin" ]]; then
          echo "  (platform-specific: updating Darwin/then branch)"
          ${pkgs.perl}/bin/perl -0777 -i -pe '
            my $key = $ENV{"HASH_KEY"};
            my $val = $ENV{"HASH_VALUE"};
            s/(\b\Q$key\E\s*=\s*if\s+pkgs\.stdenv\.isDarwin\s+then\s+)"sha256-[^"]+"/$1"$val"/gs;
          ' "$hashSourcePath"
        else
          echo "  (platform-specific: updating Linux/else branch)"
          ${pkgs.perl}/bin/perl -0777 -i -pe '
            my $key = $ENV{"HASH_KEY"};
            my $val = $ENV{"HASH_VALUE"};
            s/(\b\Q$key\E\s*=\s*if\s+pkgs\.stdenv\.isDarwin\s+then\s+"sha256-[^"]+"\s+else\s+)"sha256-[^"]+"/$1"$val"/gs;
          ' "$hashSourcePath"
        fi
      else
        ${pkgs.perl}/bin/perl -0777 -i -pe '
          my $key = $ENV{"HASH_KEY"};
          my $val = $ENV{"HASH_VALUE"};
          s/\b\Q$key\E\s*=\s*"sha256-[^"]+"/$key = "$val"/g;
        ' "$hashSourcePath"
      fi
    }
  '';
  # Script to update all hashes in the declared hashSource file
  # Handles pnpmDepsHash/bunDepsHash, lockfileHash, and packageJsonDepsHash
  # Iteratively updates hashes until build succeeds
  updateHashScript = pkgs.writeShellScript "update-all-hashes" ''
        set -euo pipefail

        flakeRef="$1"
        hashSource="$2"
        name="$3"
        lockfile="$4"
        packageJson="''${5-}"

        FAKE_HASH="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        MAX_ITERATIONS=20

        ${hashSourceHelpers}

        # Helper to update lockfileHash and packageJsonDepsHash in the hash source
        update_fingerprint_hashes() {
          if [ -n "$lockfile" ] && [ -f "$lockfile" ]; then
            # Update lockfileHash
            newLockfileHash="sha256-$(${pkgs.nix}/bin/nix-hash --type sha256 --base64 "$lockfile")"
            if [ -n "$(read_hash_from_file "lockfileHash" "$hashSource" "$name")" ]; then
              update_hash_in_file "lockfileHash" "$newLockfileHash" "$hashSource" "$name"
              echo "Updated lockfileHash to $newLockfileHash"
            fi

            # Update packageJsonDepsHash (package.json deps fingerprint)
            if [ -z "$packageJson" ]; then
              packageJson="$(dirname "$lockfile")/package.json"
            fi
            if [ -f "$packageJson" ] && [ -n "$(read_hash_from_file "packageJsonDepsHash" "$hashSource" "$name")" ]; then
              tmpDeps=$(mktemp)
              ${pkgs.jq}/bin/jq -cS '{dependencies, devDependencies, peerDependencies}' "$packageJson" > "$tmpDeps"
              newPackageJsonDepsHash="sha256-$(${pkgs.nix}/bin/nix-hash --type sha256 --base64 "$tmpDeps")"
              rm "$tmpDeps"
              update_hash_in_file "packageJsonDepsHash" "$newPackageJsonDepsHash" "$hashSource" "$name"
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

        extract_hash_mismatches() {
          printf '%s\n' "$1" | ${pkgs.perl}/bin/perl -ne '
            if (/hash mismatch in fixed-output derivation \x27([^\x27]+)\x27/) {
              $drv = $1;
              next;
            }
            if (defined $drv && /got:\s+(sha256-[A-Za-z0-9+\/=]+)/) {
              print "$drv\t$1\n";
              undef $drv;
            }
          '
        }

        local_dep_dir_from_drv_path() {
          local drvPath="$1"
          local encodedDir

          encodedDir=$(printf '%s\n' "$drvPath" | grep -oE "packages-[a-zA-Z0-9_-]+-pnpm-deps" | head -1 | ${pkgs.gnused}/bin/sed 's/-pnpm-deps$//' || true)
          if [ -z "$encodedDir" ]; then
            return 0
          fi

          printf '%s\n' "$encodedDir" | ${pkgs.gnused}/bin/sed 's/--/\/@/g; s/-/\//g'
        }

        echo "Checking $name ($flakeRef)..."

        update_fingerprint_hashes

        echo "Some hashes are stale, updating..."

        # Determine the main hash key (bunDepsHash or pnpmDepsHash)
        mainHashKey="bunDepsHash"
        if [ -n "$(read_hash_from_file "pnpmDepsHash" "$hashSource" "$name")" ]; then
          mainHashKey="pnpmDepsHash"
        fi

        currentMainHash="$(read_hash_from_file "$mainHashKey" "$hashSource" "$name")"
        restoreMainHashOnExit=false
        success=false

        restore_main_hash() {
          if [ "$restoreMainHashOnExit" != true ] || [ "$success" = true ]; then
            return
          fi

          if [ -n "$currentMainHash" ] && [ "$currentMainHash" != "$FAKE_HASH" ]; then
            echo "Restoring $mainHashKey to $currentMainHash"
            update_hash_in_file "$mainHashKey" "$currentMainHash" "$hashSource" "$name"
          fi
        }

        trap restore_main_hash EXIT

        if [ -n "$currentMainHash" ] && [ "$currentMainHash" != "$FAKE_HASH" ]; then
          echo "Resetting $mainHashKey to trigger a fresh fixed-output hash check..."
          update_hash_in_file "$mainHashKey" "$FAKE_HASH" "$hashSource" "$name"
          restoreMainHashOnExit=true
        fi

        updated_any=false
        iteration=0

        while [ $iteration -lt $MAX_ITERATIONS ]; do
          iteration=$((iteration + 1))
          echo ""
          echo "=== Iteration $iteration ==="

          set +e
          output=$(${pkgs.nix}/bin/nix build "$flakeRef" --no-link --keep-going --option substituters "https://cache.nixos.org" 2>&1)
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
            success=true
            exit 0
          fi

          hashMismatches=$(extract_hash_mismatches "$output")
          actualHash=$(extract_actual_hash "$output")

          if [ -n "$actualHash" ] && [ -n "$(read_hash_from_file "lockfileHash" "$hashSource" "$name")" ]; then
            update_hash_in_file "lockfileHash" "$actualHash" "$hashSource" "$name"
            echo "Updated lockfileHash to $actualHash"
            updated_any=true
            continue
          fi

          if [ -z "$hashMismatches" ]; then
            # No hash mismatch found - check for stale pnpm dependency preparation.
            # This happens when pnpm-lock.yaml changed but the old hash still "works"
            # long enough for pnpm to fail while materializing the prepared tree.
            if echo "$output" | grep -qiE "ERR_PNPM_NO_OFFLINE_TARBALL|ERR_PNPM_TARBALL_INTEGRITY|lockfile:.*manifest:"; then
              echo "Detected stale pnpmDepsHash (prepared pnpm install tree is stale)"
              echo "Resetting $mainHashKey to trigger complete re-materialization..."

              # Set fake hash to force Nix to re-fetch and report correct hash
              update_hash_in_file "$mainHashKey" "$FAKE_HASH" "$hashSource" "$name"

              updated_any=true
              continue  # Next iteration will get the correct hash from mismatch error
            fi

            # Genuine build failure - not a hash issue
            echo "✗ $name: build failed but no hash mismatch found"
            echo "$output"
            exit 1
          fi

          seenTargets=$(mktemp)
          while IFS=$'\t' read -r mismatchDrv mismatchHash; do
            if [ -z "$mismatchDrv" ] || [ -z "$mismatchHash" ]; then
              continue
            fi

            localDepDir=$(local_dep_dir_from_drv_path "$mismatchDrv")
            if [ -n "$localDepDir" ]; then
              target="local:$localDepDir"
              if grep -Fxq "$target" "$seenTargets"; then
                continue
              fi
              echo "$target" >> "$seenTargets"

              echo "Updating localDeps hash for $localDepDir to $mismatchHash..."

              export LOCAL_DEP_DIR="$localDepDir"
              export NEW_HASH="$mismatchHash"
              ${pkgs.perl}/bin/perl -0777 -i -pe '
                my $dir = $ENV{"LOCAL_DEP_DIR"};
                my $hash = $ENV{"NEW_HASH"};
                s/(\{\s*dir\s*=\s*"\Q$dir\E"\s*;\s*hash\s*=\s*)"sha256-[^"]+"/$1"$hash"/g;
              ' "$hashSource"

              updated_any=true
              continue
            fi

            target="main"
            if grep -Fxq "$target" "$seenTargets"; then
              continue
            fi
            echo "$target" >> "$seenTargets"

            echo "Updating $mainHashKey to $mismatchHash..."
            update_hash_in_file "$mainHashKey" "$mismatchHash" "$hashSource" "$name"
            restoreMainHashOnExit=false
            updated_any=true
          done <<EOF
    $hashMismatches
    EOF
          rm -f "$seenTargets"
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
    hashSource="''${3-}"
    lockfile="''${4-}"
    packageJson="''${5-}"

    ${hashSourceHelpers}

    # Preflight: ensure lockfile/package.json fingerprints match hashSource
    # This avoids false passes on warmed Nix stores (R5: deterministic checks).
    if [ -n "$hashSource" ] && [ -n "$lockfile" ] && [ -f "$lockfile" ]; then
      if [ -z "$packageJson" ]; then
        packageJson="$(dirname "$lockfile")/package.json"
      fi

      currentLockfileHash="sha256-$(${pkgs.nix}/bin/nix-hash --type sha256 --base64 "$lockfile")"
      storedLockfileHash=$(read_hash_from_file "lockfileHash" "$hashSource" "$name")

      if [ -z "$storedLockfileHash" ]; then
        echo "⚠ $name: no lockfileHash in hashSource, skipping lockfile check"
      elif [ "$currentLockfileHash" != "$storedLockfileHash" ]; then
        echo "✗ $name: lockfile changed (run: dt nix:hash:$name)"
        echo "  stored:  $storedLockfileHash"
        echo "  current: $currentLockfileHash"
        exit 1
      fi

      if [ -f "$packageJson" ]; then
        tmpDeps=$(mktemp)
        ${pkgs.jq}/bin/jq -cS '{dependencies, devDependencies, peerDependencies}' "$packageJson" > "$tmpDeps"
        currentPackageJsonDepsHash="sha256-$(${pkgs.nix}/bin/nix-hash --type sha256 --base64 "$tmpDeps")"
        rm "$tmpDeps"

        storedPackageJsonDepsHash=$(read_hash_from_file "packageJsonDepsHash" "$hashSource" "$name")

        if [ -z "$storedPackageJsonDepsHash" ]; then
          echo "⚠ $name: no packageJsonDepsHash in hashSource, skipping deps check"
        elif [ "$currentPackageJsonDepsHash" != "$storedPackageJsonDepsHash" ]; then
          echo "✗ $name: package.json deps changed (run: pnpm install && dt nix:hash:$name)"
          echo "  stored:  $storedPackageJsonDepsHash"
          echo "  current: $currentPackageJsonDepsHash"
          exit 1
        fi
      fi
    fi

    # In CI, disable substituters so Nix must rebuild FODs from scratch.
    # Cachix can serve stale FOD outputs (keyed by declared hash, not build
    # inputs), masking hash staleness. With substitute=false, a stale hash
    # causes a hash mismatch error immediately.
    # TODO(nix-ca): Remove once content-addressed derivations are stable (NixOS/nix#6623).
    if [ -n "''${CI:-}" ]; then
      __nix_sub_arg="--option substitute false"
    else
      __nix_sub_arg="--option substituters https://cache.nixos.org"
    fi

    if output=$(${pkgs.nix}/bin/nix build "$flakeRef" --no-link $__nix_sub_arg 2>&1); then
      echo "✓ $name: up to date"
      exit 0
    fi

    # Check for Nix hash mismatch
    if echo "$output" | grep -qE 'got:\s+sha256-'; then
      mismatchDrv=$(printf '%s\n' "$output" | ${pkgs.perl}/bin/perl -ne '
        if (/hash mismatch in fixed-output derivation \x27([^\x27]+)\x27/) {
          print "$1\n";
          exit 0;
        }
      ' | head -1 || true)
      gotHash=$(echo "$output" | grep -oE 'got:\s+sha256-[A-Za-z0-9+/=]+' | grep -oE 'sha256-[A-Za-z0-9+/=]+' | head -1 || true)
      expectedHash=$(echo "$output" | grep -oE 'specified:\s+sha256-[A-Za-z0-9+/=]+' | grep -oE 'sha256-[A-Za-z0-9+/=]+' | head -1 || true)
      echo "✗ $name: deps hash is stale (run: dt nix:hash:$name)"
      if [ -n "$expectedHash" ]; then
        echo "  expected: $expectedHash"
      fi
      if [ -n "$gotHash" ]; then
        echo "  got:      $gotHash"
      fi
      if [ -n "$mismatchDrv" ]; then
        echo "  drv:      $mismatchDrv"
        if drvJson=$(${pkgs.nix}/bin/nix derivation show "$mismatchDrv" 2>/dev/null); then
          # Newer Nix versions return the derivation map at the top level,
          # while older ones nest it under `.derivations`. Accept both so
          # stale-hash diagnostics stay informative instead of failing with a
          # secondary jq error.
          echo "$drvJson" | ${pkgs.jq}/bin/jq -r '
            ((.derivations // .) | to_entries[0]?.value?.env?) // {}
            | {
                system,
                src,
                nativeBuildInputs,
                outputHash
              }
            | to_entries[]
            | "  \(.key): \(.value)"
          ' || true
        fi
      fi
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
      echo "  1. Run: dt pnpm:update     # Update the repo-root pnpm lockfile"
      echo "  2. Run: dt nix:hash:$name  # Update Nix hashes"
      echo "  3. Commit: pnpm-lock.yaml changes and hashSource updates"
      echo ""
      exit 1
    fi

    if echo "$output" | grep -qi 'ERR_PNPM_NO_OFFLINE_TARBALL'; then
      echo "✗ $name: prepared pnpm install tree is stale or incomplete"
      echo ""
      echo "To fix:"
      echo "  1. Run: dt nix:hash:$name  # Refresh pnpmDepsHash and prepared install tree"
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
    hashSource="$2"
    lockfile="$3"
    packageJson="''${4-}"

    ${hashSourceHelpers}

    if [ -z "$packageJson" ]; then
      packageJson="$(dirname "$lockfile")/package.json"
    fi
    failed=false

    # Check 1: lockfileHash (lockfile changed without hash update)
    currentLockfileHash=$(${pkgs.nix}/bin/nix-hash --type sha256 --base64 "$lockfile" 2>/dev/null || echo "")
    if [ -z "$currentLockfileHash" ]; then
      echo "⚠ $name: lockfile not found ($lockfile), skipping lockfile check"
    else
      currentLockfileHash="sha256-$currentLockfileHash"
      storedLockfileHash=$(read_hash_from_file "lockfileHash" "$hashSource" "$name")

      if [ -z "$storedLockfileHash" ]; then
        echo "⚠ $name: no lockfileHash in hashSource, skipping lockfile check"
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
      currentPackageJsonDepsHash="sha256-$(${pkgs.nix}/bin/nix-hash --type sha256 --base64 "$tmpDeps")"
      rm "$tmpDeps"

      storedPackageJsonDepsHash=$(read_hash_from_file "packageJsonDepsHash" "$hashSource" "$name")

      if [ -z "$storedPackageJsonDepsHash" ]; then
        echo "⚠ $name: no packageJsonDepsHash in hashSource, skipping deps check"
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
      exec = trace.exec "nix:hash:${pkg.name}" "${updateHashScript} '${pkg.flakeRef}' '${pkg.hashSource}' '${pkg.name}' '${pkg.lockfile or ""}' '${pkg.packageJson or ""}'";
      # pnpm:install refreshes the repo-root install state from the
      # authoritative root lockfile before we recompute hashes.
      after = [ "pnpm:install" ];
    };
  };

  mkBuildTask = pkg: {
    "nix:build:${pkg.name}" = {
      description = "Build ${pkg.name} Nix package";
      exec = trace.exec "nix:build:${pkg.name}" "${pkgs.nix}/bin/nix build '${pkg.flakeRef}' --no-link -L";
    };
  };

  mkCheckTask = pkg: {
    "nix:check:${pkg.name}" = {
      description = "Check if ${pkg.name} hash is stale (full build)";
      exec = trace.exec "nix:check:${pkg.name}" "${checkHashScript} '${pkg.flakeRef}' '${pkg.name}' '${pkg.hashSource}' '${pkg.lockfile or ""}' '${pkg.packageJson or ""}'";
      # Depends on the full workspace pnpm:install so the staged build inputs
      # stay synchronized with the authoritative repo-root lockfile.
      after = lib.optional (pkg ? lockfile) "pnpm:install";
    };
  };

  # Quick check using lockfile fingerprint (for check:quick)
  mkQuickCheckTask =
    pkg:
    lib.optionalAttrs (pkg ? lockfile) {
      "nix:check:quick:${pkg.name}" = {
        description = "Quick lockfile check for ${pkg.name}";
        exec = trace.exec "nix:check:quick:${pkg.name}" "${quickCheckScript} '${pkg.name}' '${pkg.hashSource}' '${pkg.lockfile}' '${pkg.packageJson or ""}'";
      };
    };

  # Filter packages that have lockfile defined
  packagesWithLockfile = builtins.filter (p: p ? lockfile) cliPackages;

  hasPackages = cliPackages != [ ];

in
lib.mkIf hasPackages {
  tasks = lib.mkMerge (
    # Per-package tasks
    (map mkHashTask cliPackages)
    ++ (map mkBuildTask cliPackages)
    ++ (map mkCheckTask cliPackages)
    ++ (map mkQuickCheckTask packagesWithLockfile)
    ++
      # Aggregate tasks
      [
        {
          "nix:test" = {
            description = "Run nix-cli tooling tests";
            exec = trace.exec "nix:test" "${nixTestsScript}";
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
            exec = trace.exec "nix:flake:check" "${pkgs.nix}/bin/nix flake check";
          };
        }
      ]
  );
}
