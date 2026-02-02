#!/usr/bin/env bash
set -euo pipefail

extract_got_hash() {
  echo "$1" | grep -oE 'got:\s+sha256-[A-Za-z0-9+/=]+' | grep -oE 'sha256-[A-Za-z0-9+/=]+' | head -1 || true
}

extract_actual_hash() {
  echo "$1" | grep -oE 'actual:\s+sha256-[A-Za-z0-9+/=]+' | grep -oE 'sha256-[A-Za-z0-9+/=]+' | head -1 || true
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
}

lockfile_output=$(cat <<'EOF'
error: lockfileHash is stale (run: dt nix:hash)
  expected: sha256-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD=
  actual:   sha256-NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW=
EOF
)

got_output=$(cat <<'EOF'
error: hash mismatch in fixed-output derivation
  got:    sha256-ABCDEFG1234567890ABCDEFabcdef1234567890abcdEFG=
  wanted: sha256-OLDHASHOLDHASHOLDHASHOLDHASHOLDHASHOLDHASHOLDHASH=
EOF
)

missing_output=$(cat <<'EOF'
error: Something else failed
EOF
)

assert_eq \
  "sha256-NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW=" \
  "$(extract_actual_hash "$lockfile_output")" \
  "extract_actual_hash"

assert_eq \
  "sha256-ABCDEFG1234567890ABCDEFabcdef1234567890abcdEFG=" \
  "$(extract_got_hash "$got_output")" \
  "extract_got_hash"

assert_eq "" "$(extract_actual_hash "$missing_output")" "missing_actual"
assert_eq "" "$(extract_got_hash "$missing_output")" "missing_got"

echo "Hash extraction tests passed"

# ============================================================================
# Tests for update_hash_in_file helper (platform-specific hash support)
# ============================================================================

# Helper function copied from nix-cli.nix for testing
update_hash_in_file() {
  local hashKey="$1"
  local newValue="$2"
  local buildNixPath="$3"

  # Check if this is a platform-specific hash (if pkgs.stdenv.isDarwin pattern)
  if grep -qE "$hashKey\s*=\s*if\s+pkgs\.stdenv\.isDarwin" "$buildNixPath"; then
    # Platform-specific hash - update only the current platform's hash
    if [[ "$(uname -s)" == "Darwin" ]]; then
      export HASH_KEY="$hashKey"
      export HASH_VALUE="$newValue"
      perl -0777 -i -pe '
        my $key = $ENV{"HASH_KEY"};
        my $val = $ENV{"HASH_VALUE"};
        # Match: pnpmDepsHash = if pkgs.stdenv.isDarwin\s+then "sha256-..."
        s/(\b\Q$key\E\s*=\s*if\s+pkgs\.stdenv\.isDarwin\s+then\s+)"sha256-[^"]+"/$1"$val"/gs;
      ' "$buildNixPath"
    else
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

# Test 1: Simple single hash pattern
echo "Testing simple hash pattern..."
tmpfile=$(mktemp)
cat > "$tmpfile" << 'EOF'
{ pkgs }:
{
  pnpmDepsHash = "sha256-OLDHASH123456789012345678901234567890123=";
  lockfileHash = "sha256-LOCKFILE12345678901234567890123456789012=";
}
EOF

update_hash_in_file "pnpmDepsHash" "sha256-NEWHASH999999999999999999999999999999999=" "$tmpfile"

if grep -q 'pnpmDepsHash = "sha256-NEWHASH999999999999999999999999999999999="' "$tmpfile"; then
  echo "  ✓ Simple hash update works"
else
  echo "  ✗ Simple hash update failed"
  cat "$tmpfile"
  rm "$tmpfile"
  exit 1
fi

# Verify lockfileHash wasn't touched
if grep -q 'lockfileHash = "sha256-LOCKFILE12345678901234567890123456789012="' "$tmpfile"; then
  echo "  ✓ Other hashes preserved"
else
  echo "  ✗ Other hashes were incorrectly modified"
  cat "$tmpfile"
  rm "$tmpfile"
  exit 1
fi
rm "$tmpfile"

# Test 2: Platform-specific hash pattern
echo "Testing platform-specific hash pattern..."
tmpfile=$(mktemp)
cat > "$tmpfile" << 'EOF'
{ pkgs }:
{
  pnpmDepsHash = if pkgs.stdenv.isDarwin
    then "sha256-DARWINHASH1234567890123456789012345678901="
    else "sha256-LINUXHASH12345678901234567890123456789012=";
  lockfileHash = "sha256-LOCKFILE12345678901234567890123456789012=";
}
EOF

NEW_HASH="sha256-UPDATEDHASH9999999999999999999999999999999="
update_hash_in_file "pnpmDepsHash" "$NEW_HASH" "$tmpfile"

if [[ "$(uname -s)" == "Darwin" ]]; then
  # On Darwin, should update the "then" branch
  if grep -q "then \"$NEW_HASH\"" "$tmpfile"; then
    echo "  ✓ Darwin hash updated correctly"
  else
    echo "  ✗ Darwin hash update failed"
    cat "$tmpfile"
    rm "$tmpfile"
    exit 1
  fi
  # Linux hash should be unchanged
  if grep -q 'else "sha256-LINUXHASH12345678901234567890123456789012="' "$tmpfile"; then
    echo "  ✓ Linux hash preserved"
  else
    echo "  ✗ Linux hash was incorrectly modified"
    cat "$tmpfile"
    rm "$tmpfile"
    exit 1
  fi
else
  # On Linux, should update the "else" branch
  if grep -q "else \"$NEW_HASH\"" "$tmpfile"; then
    echo "  ✓ Linux hash updated correctly"
  else
    echo "  ✗ Linux hash update failed"
    cat "$tmpfile"
    rm "$tmpfile"
    exit 1
  fi
  # Darwin hash should be unchanged
  if grep -q 'then "sha256-DARWINHASH1234567890123456789012345678901="' "$tmpfile"; then
    echo "  ✓ Darwin hash preserved"
  else
    echo "  ✗ Darwin hash was incorrectly modified"
    cat "$tmpfile"
    rm "$tmpfile"
    exit 1
  fi
fi

# Verify lockfileHash wasn't touched
if grep -q 'lockfileHash = "sha256-LOCKFILE12345678901234567890123456789012="' "$tmpfile"; then
  echo "  ✓ lockfileHash preserved"
else
  echo "  ✗ lockfileHash was incorrectly modified"
  cat "$tmpfile"
  rm "$tmpfile"
  exit 1
fi
rm "$tmpfile"

# Test 3: Platform-specific with different formatting (single line)
echo "Testing platform-specific hash (compact format)..."
tmpfile=$(mktemp)
cat > "$tmpfile" << 'EOF'
{ pkgs }:
{
  pnpmDepsHash = if pkgs.stdenv.isDarwin then "sha256-DARWIN123456789012345678901234567890123=" else "sha256-LINUX1234567890123456789012345678901234=";
}
EOF

update_hash_in_file "pnpmDepsHash" "sha256-COMPACT9999999999999999999999999999999999=" "$tmpfile"

if [[ "$(uname -s)" == "Darwin" ]]; then
  if grep -q 'then "sha256-COMPACT9999999999999999999999999999999999="' "$tmpfile"; then
    echo "  ✓ Compact Darwin hash updated"
  else
    echo "  ✗ Compact Darwin hash update failed"
    cat "$tmpfile"
    rm "$tmpfile"
    exit 1
  fi
else
  if grep -q 'else "sha256-COMPACT9999999999999999999999999999999999="' "$tmpfile"; then
    echo "  ✓ Compact Linux hash updated"
  else
    echo "  ✗ Compact Linux hash update failed"
    cat "$tmpfile"
    rm "$tmpfile"
    exit 1
  fi
fi
rm "$tmpfile"

# Test 4: Real-world format (with comments, like genie's build.nix)
echo "Testing real-world format with comments..."
tmpfile=$(mktemp)
cat > "$tmpfile" << 'EOF'
{ pkgs, src, gitRev ? "unknown", commitTs ? 0, dirty ? false }:

let
  mkPnpmCli = import ../../../../nix/workspace-tools/lib/mk-pnpm-cli.nix { inherit pkgs; };
  unwrapped = mkPnpmCli {
    name = "genie-unwrapped";
    entry = "packages/@overeng/genie/bin/genie.tsx";
    # Platform-specific hash: fetchPnpmDeps only fetches native binaries for the current platform.
    # Each platform produces different hashes due to platform-specific optional dependencies
    # (e.g., @esbuild/darwin-arm64 vs @esbuild/linux-x64).
    pnpmDepsHash = if pkgs.stdenv.isDarwin
      then "sha256-OLDDDDDARWIN123456789012345678901234567890="
      else "sha256-OLDDDDDLINUX1234567890123456789012345678901=";
    lockfileHash = "sha256-LOCKFILE12345678901234567890123456789012=";
    packageJsonDepsHash = "sha256-PACKAGEJSON12345678901234567890123456789=";
    inherit gitRev commitTs dirty;
  };
in
pkgs.runCommand "genie" {} ""
EOF

update_hash_in_file "pnpmDepsHash" "sha256-REALWORLD99999999999999999999999999999999=" "$tmpfile"

if [[ "$(uname -s)" == "Darwin" ]]; then
  if grep -q 'then "sha256-REALWORLD99999999999999999999999999999999="' "$tmpfile"; then
    echo "  ✓ Real-world Darwin hash updated"
  else
    echo "  ✗ Real-world Darwin hash update failed"
    cat "$tmpfile"
    rm "$tmpfile"
    exit 1
  fi
  if grep -q 'else "sha256-OLDDDDDLINUX1234567890123456789012345678901="' "$tmpfile"; then
    echo "  ✓ Real-world Linux hash preserved"
  else
    echo "  ✗ Real-world Linux hash was incorrectly modified"
    cat "$tmpfile"
    rm "$tmpfile"
    exit 1
  fi
else
  if grep -q 'else "sha256-REALWORLD99999999999999999999999999999999="' "$tmpfile"; then
    echo "  ✓ Real-world Linux hash updated"
  else
    echo "  ✗ Real-world Linux hash update failed"
    cat "$tmpfile"
    rm "$tmpfile"
    exit 1
  fi
  if grep -q 'then "sha256-OLDDDDDARWIN123456789012345678901234567890="' "$tmpfile"; then
    echo "  ✓ Real-world Darwin hash preserved"
  else
    echo "  ✗ Real-world Darwin hash was incorrectly modified"
    cat "$tmpfile"
    rm "$tmpfile"
    exit 1
  fi
fi

# Verify other hashes weren't touched
if grep -q 'lockfileHash = "sha256-LOCKFILE12345678901234567890123456789012="' "$tmpfile" && \
   grep -q 'packageJsonDepsHash = "sha256-PACKAGEJSON12345678901234567890123456789="' "$tmpfile"; then
  echo "  ✓ Other hashes preserved"
else
  echo "  ✗ Other hashes were incorrectly modified"
  cat "$tmpfile"
  rm "$tmpfile"
  exit 1
fi
rm "$tmpfile"

echo ""
echo "All nix-cli-hash tests passed"
