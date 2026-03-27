# Nix CLI build, deps hash management, and flake validation tasks
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.nix-cli {
#       cliPackages = [
#         {
#           name = "genie";
#           flakeRef = ".#genie";
#           hashSource = "packages/@overeng/genie/nix/build.nix";
#         }
#       ];
#     })
#   ];
#
# Provides:
#   - nix:build - Build all CLI packages
#   - nix:build:<name> - Build a specific package
#   - nix:check - Full stale-hash check per package (authoritative build path)
#   - nix:check:quick - Fast builder-native depsBuildFingerprint check
#   - nix:flake:check - Full flake validation (builds all packages, for check:all)
#
# depsBuildFingerprint quick-check contract:
#   `pnpmDepsHash` / `bunDepsHash` remain the authoritative fixed-output hashes.
#   `depsBuildFingerprint` is the cheap fingerprint of the effective deps build
#   recipe exported by the builder itself. nix-cli only compares that exported
#   value; it does not try to restate builder semantics in shell.
{
  cliPackages ? [ ],
}:
{ pkgs, lib, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  hashSourceHelpers = ''
    # Hash sources are not structurally uniform yet: callers may store values at
    # top level, inside a named attrset, or behind a Darwin/Linux branch. Keep
    # the parser generic so quick checks can read existing callers without
    # re-encoding builder semantics in shell.
    read_value_from_file() {
      local valueKey="$1"
      local hashSourcePath="$2"
      local packageName="$3"

      VALUE_KEY="$valueKey" PKG_NAME="$packageName" PLATFORM="$(uname -s)" ${pkgs.perl}/bin/perl -0777 -ne '
        my $key = $ENV{"VALUE_KEY"};
        my $pkg = $ENV{"PKG_NAME"};
        my $platform = $ENV{"PLATFORM"};
        my $haystack = $_;

        if ($pkg ne "" && /((?:\Q$pkg\E|"\Q$pkg\E")\s*=\s*\{.*?\n\})/s) {
          $haystack = $1;
        }

        if ($haystack =~ /\b\Q$key\E\s*=\s*"([^"]+)"/s) {
          print $1;
          exit 0;
        }

        if ($haystack =~ /\b\Q$key\E\s*=\s*if\s+pkgs\.stdenv\.isDarwin\s+then\s+"([^"]+)"\s+else\s+"([^"]+)"/s) {
          print (($platform eq "Darwin") ? $1 : $2);
          exit 0;
        }
      ' "$hashSourcePath"
    }
  '';

  fingerprintHelpers = ''
    read_current_fingerprint() {
      local flakeRef="$1"
      ${pkgs.nix}/bin/nix eval --raw "$flakeRef.passthru.depsBuildFingerprint"
    }

    ensure_fingerprint_slot() {
      local hashSource="$1"
      local name="$2"
      if [ -z "$(read_value_from_file "depsBuildFingerprint" "$hashSource" "$name")" ]; then
        echo "✗ $name: hashSource is missing depsBuildFingerprint"
        echo "  This caller still uses the legacy nix-cli contract and must be migrated first."
        exit 1
      fi
    }
  '';

  checkHashScript = pkgs.writeShellScript "check-hash" ''
    set -euo pipefail

    flakeRef="$1"
    name="$2"
    hashSource="$3"

    ${hashSourceHelpers}
    ${fingerprintHelpers}

    ensure_fingerprint_slot "$hashSource" "$name"

    storedFingerprint="$(read_value_from_file "depsBuildFingerprint" "$hashSource" "$name")"
    currentFingerprint="$(read_current_fingerprint "$flakeRef")"

    if [ "$storedFingerprint" != "$currentFingerprint" ]; then
      echo "✗ $name: deps build fingerprint changed (run: nix-hash-refresh --name $name)"
      echo "  stored:  $storedFingerprint"
      echo "  current: $currentFingerprint"
      exit 1
    fi

    if [ -n "''${CI:-}" ]; then
      topDrv=$(${pkgs.nix}/bin/nix path-info --derivation "$flakeRef" 2>/dev/null || true)
      if [ -n "$topDrv" ]; then
        for drv in $(${pkgs.nix}/bin/nix-store -qR "$topDrv" 2>/dev/null | grep -E "(pnpm-deps|bun-deps).*\\.drv$" || true); do
          for outPath in $(${pkgs.nix}/bin/nix-store -q --outputs "$drv" 2>/dev/null || true); do
            if [ -e "$outPath" ]; then
              echo "  evicting cached: $(basename "$outPath")"
              ${pkgs.nix}/bin/nix store delete "$outPath" 2>/dev/null || true
            fi
          done
        done
      fi
    fi

    if output=$(${pkgs.nix}/bin/nix build "$flakeRef" --no-link --option substituters "https://cache.nixos.org" 2>&1); then
      echo "✓ $name: up to date"
      exit 0
    fi

    if echo "$output" | grep -qE 'got:\s+sha256-'; then
      mismatchDrv=$(printf '%s\n' "$output" | ${pkgs.perl}/bin/perl -ne '
        if (/hash mismatch in fixed-output derivation \x27([^\x27]+)\x27/) {
          print "$1\n";
          exit 0;
        }
      ' | head -1 || true)
      gotHash=$(echo "$output" | grep -oE 'got:\s+sha256-[A-Za-z0-9+/=]+' | grep -oE 'sha256-[A-Za-z0-9+/=]+' | head -1 || true)
      expectedHash=$(echo "$output" | grep -oE 'specified:\s+sha256-[A-Za-z0-9+/=]+' | grep -oE 'sha256-[A-Za-z0-9+/=]+' | head -1 || true)
      echo "✗ $name: deps hash is stale (run: nix-hash-refresh --name $name)"
      if [ -n "$expectedHash" ]; then
        echo "  expected: $expectedHash"
      fi
      if [ -n "$gotHash" ]; then
        echo "  got:      $gotHash"
      fi
      if [ -n "$mismatchDrv" ]; then
        echo "  drv:      $mismatchDrv"
        if drvJson=$(${pkgs.nix}/bin/nix derivation show "$mismatchDrv" 2>/dev/null); then
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
          '
        fi
      fi
      exit 1
    fi

    if echo "$output" | grep -q 'deps hash is stale'; then
      echo "✗ $name: deps hash is stale (run: nix-hash-refresh --name $name)"
      exit 1
    fi

    if echo "$output" | grep -qE 'ERR_PNPM_OUTDATED_LOCKFILE|lockfile.*not up to date'; then
      echo "✗ $name: pnpm lockfile is stale (new deps added but not locked)"
      echo ""
      echo "To fix:"
      echo "  1. Run: dt pnpm:update"
      echo "  2. Run: nix-hash-refresh --name $name"
      echo "  3. Commit: pnpm-lock.yaml changes and hashSource updates"
      echo ""
      exit 1
    fi

    if echo "$output" | grep -qiE 'ERR_PNPM_NO_OFFLINE_TARBALL|ERR_PNPM_TARBALL_INTEGRITY'; then
      echo "✗ $name: prepared pnpm install tree is stale or incomplete"
      echo ""
      echo "To fix:"
      echo "  1. Run: nix-hash-refresh --name $name"
      echo "  2. If lockfiles changed: dt pnpm:update"
      echo ""
      exit 1
    fi

    echo "✗ $name: build failed"
    echo "$output"
    exit 1
  '';

  quickCheckScript = pkgs.writeShellScript "check-deps-build-fingerprint" ''
    set -euo pipefail

    name="$1"
    hashSource="$2"
    flakeRef="$3"

    ${hashSourceHelpers}
    ${fingerprintHelpers}

    ensure_fingerprint_slot "$hashSource" "$name"

    storedFingerprint="$(read_value_from_file "depsBuildFingerprint" "$hashSource" "$name")"
    currentFingerprint="$(read_current_fingerprint "$flakeRef")"

    if [ "$storedFingerprint" != "$currentFingerprint" ]; then
      echo "✗ $name: deps build fingerprint changed (run: nix-hash-refresh --name $name)"
      echo "  stored:  $storedFingerprint"
      echo "  current: $currentFingerprint"
      exit 1
    fi

    echo "✓ $name: deps build fingerprint unchanged"
  '';

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

  mkBuildTask = pkg: {
    "nix:build:${pkg.name}" = {
      description = "Build ${pkg.name} Nix package";
      exec = trace.exec "nix:build:${pkg.name}" "${pkgs.nix}/bin/nix build '${pkg.flakeRef}' --no-link -L";
    };
  };

  mkCheckTask = pkg: {
    "nix:check:${pkg.name}" = {
      description = "Check if ${pkg.name} hash is stale (full build)";
      exec = trace.exec "nix:check:${pkg.name}" "${checkHashScript} '${pkg.flakeRef}' '${pkg.name}' '${pkg.hashSource}'";
    };
  };

  mkQuickCheckTask = pkg: {
    "nix:check:quick:${pkg.name}" = {
      description = "Quick deps recipe check for ${pkg.name}";
      exec = trace.exec "nix:check:quick:${pkg.name}" "${quickCheckScript} '${pkg.name}' '${pkg.hashSource}' '${pkg.flakeRef}'";
    };
  };

  hasPackages = cliPackages != [ ];

in
lib.mkIf hasPackages {
  tasks = lib.mkMerge (
    (map mkBuildTask cliPackages)
    ++ (map mkCheckTask cliPackages)
    ++ (map mkQuickCheckTask cliPackages)
    ++ [
      {
        "nix:test" = {
          description = "Run nix-cli tooling tests";
          exec = trace.exec "nix:test" "${nixTestsScript}";
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
          description = "Quick deps recipe check for all CLI packages";
          after = map (p: "nix:check:quick:${p.name}") cliPackages;
        };

        "nix:flake:check" = {
          description = "Full nix flake validation (builds all flake packages)";
          exec = trace.exec "nix:flake:check" "${pkgs.nix}/bin/nix flake check";
        };
      }
    ]
  );
}
