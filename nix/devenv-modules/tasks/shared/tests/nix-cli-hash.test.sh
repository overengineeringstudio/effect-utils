#!/usr/bin/env bash
set -euo pipefail

extract_got_hash() {
  echo "$1" | grep -oE 'got:\s+sha256-[A-Za-z0-9+/=]+' | grep -oE 'sha256-[A-Za-z0-9+/=]+' | head -1 || true
}

extract_actual_hash() {
  echo "$1" | grep -oE 'actual:\s+sha256-[A-Za-z0-9+/=]+' | grep -oE 'sha256-[A-Za-z0-9+/=]+' | head -1 || true
}

extract_hash_mismatches() {
  printf '%s\n' "$1" | perl -ne '
    if (/hash mismatch in fixed-output derivation '\''([^'\'']+)'\''/) {
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

  encodedDir=$(printf '%s\n' "$drvPath" | grep -oE "packages-[a-zA-Z0-9_-]+-pnpm-deps" | head -1 | sed 's/-pnpm-deps$//' || true)
  if [ -z "$encodedDir" ]; then
    return 0
  fi

  printf '%s\n' "$encodedDir" | sed 's/--/\/@/g; s/-/\//g'
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

multi_mismatch_output=$(cat <<'EOF'
error: hash mismatch in fixed-output derivation '/nix/store/aaa-genie-unwrapped-packages--overeng-utils-pnpm-deps-abc.drv':
  specified: sha256-OLDUTILS=
  got:    sha256-NEWUTILS=
error: hash mismatch in fixed-output derivation '/nix/store/bbb-genie-unwrapped-pnpm-deps-def.drv':
  specified: sha256-OLDMAIN=
  got:    sha256-NEWMAIN=
error: hash mismatch in fixed-output derivation '/nix/store/ccc-genie-unwrapped-packages--overeng-megarepo-pnpm-deps-ghi.drv':
  specified: sha256-OLDMEGAREPO=
  got:    sha256-NEWMEGAREPO=
EOF
)

expected_multi_mismatches=$(cat <<'EOF'
/nix/store/aaa-genie-unwrapped-packages--overeng-utils-pnpm-deps-abc.drv	sha256-NEWUTILS=
/nix/store/bbb-genie-unwrapped-pnpm-deps-def.drv	sha256-NEWMAIN=
/nix/store/ccc-genie-unwrapped-packages--overeng-megarepo-pnpm-deps-ghi.drv	sha256-NEWMEGAREPO=
EOF
)

assert_eq "$expected_multi_mismatches" "$(extract_hash_mismatches "$multi_mismatch_output")" "extract_hash_mismatches"
assert_eq "packages/@overeng/utils" "$(local_dep_dir_from_drv_path "/nix/store/aaa-genie-unwrapped-packages--overeng-utils-pnpm-deps-abc.drv")" "local_dep_dir_utils"
assert_eq "packages/@overeng/megarepo" "$(local_dep_dir_from_drv_path "/nix/store/ccc-genie-unwrapped-packages--overeng-megarepo-pnpm-deps-ghi.drv")" "local_dep_dir_megarepo"
assert_eq "" "$(local_dep_dir_from_drv_path "/nix/store/bbb-genie-unwrapped-pnpm-deps-def.drv")" "local_dep_dir_main"

echo "Multi-mismatch parsing tests passed"

mixed_failure_output=$(cat <<'EOF'
error: hash mismatch in fixed-output derivation '/nix/store/x2.drv':
         specified: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
            got:    sha256-ce9j/VcjC18vmZgcaMAqZg/qH/WibuYfiyiOYHNI5pk=
error: hash mismatch in fixed-output derivation '/nix/store/x3.drv':
         specified: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
            got:    sha256-DbCEqRfR8yZl2skxnBthgysFiZPiP6U5JQ9/Bp7IQI4=
error: build of '/nix/store/x4.drv^out' failed
EOF
)

expected_mixed_failure_mismatches=$(cat <<'EOF'
/nix/store/x2.drv	sha256-ce9j/VcjC18vmZgcaMAqZg/qH/WibuYfiyiOYHNI5pk=
/nix/store/x3.drv	sha256-DbCEqRfR8yZl2skxnBthgysFiZPiP6U5JQ9/Bp7IQI4=
EOF
)

assert_eq \
  "$expected_mixed_failure_mismatches" \
  "$(extract_hash_mismatches "$mixed_failure_output")" \
  "extract_hash_mismatches_mixed_failure"

echo "Mixed failure parsing tests passed"

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
    if [ "$hashKey" = "bunDepsHash" ] || [ "$hashKey" = "pnpmDepsHash" ]; then
      if perl -0777 -ne '
        exit 0 if /depsBuilds\s*=\s*\{.*?"\."\s*=\s*\{.*?\bhash\s*=\s*(?:"sha256-[^"]+"|pkgs\.lib\.fakeHash|lib\.fakeHash)/s;
        exit 1;
      ' "$buildNixPath"; then
        export HASH_VALUE="$newValue"
        perl -0777 -i -pe '
          my $val = $ENV{"HASH_VALUE"};
          s/(depsBuilds\s*=\s*\{.*?"\."\s*=\s*\{.*?\bhash\s*=\s*)(?:"sha256-[^"]+"|pkgs\.lib\.fakeHash|lib\.fakeHash)/$1 . qq{"$val"}/se;
        ' "$buildNixPath"
        return
      fi
    fi

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

# Test 3: Nested depsBuilds main hash pattern
echo "Testing nested depsBuilds main hash pattern..."
tmpfile=$(mktemp)
cat > "$tmpfile" << 'EOF'
{ pkgs }:
{
  depsBuilds = {
    "." = {
      hash = "sha256-OLDHASH123456789012345678901234567890123=";
    };
  };
}
EOF

update_hash_in_file "pnpmDepsHash" "sha256-NESTEDHASH999999999999999999999999999999=" "$tmpfile"

if grep -q 'hash = "sha256-NESTEDHASH999999999999999999999999999999="' "$tmpfile"; then
  echo "  ✓ Nested depsBuilds hash update works"
else
  echo "  ✗ Nested depsBuilds hash update failed"
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
  packageJsonDepsHash = "sha256-PACKAGEJSON12345678901234567890123456789=";
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
echo "Testing multi-mismatch updates..."
tmpfile=$(mktemp)
cat > "$tmpfile" << 'EOF'
{ pkgs }:
{
  pnpmDepsHash = "sha256-OLDMAIN1234567890123456789012345678901234=";
  localDeps = [
    { dir = "packages/@overeng/utils"; hash = "sha256-OLDUTILS12345678901234567890123456789012="; }
    { dir = "packages/@overeng/megarepo"; hash = "sha256-OLDMEGAREPO1234567890123456789012345678="; }
  ];
}
EOF

seen_targets=$(mktemp)
while IFS=$'\t' read -r mismatch_drv mismatch_hash; do
  [ -n "$mismatch_drv" ] || continue
  [ -n "$mismatch_hash" ] || continue

  local_dep_dir=$(local_dep_dir_from_drv_path "$mismatch_drv")
  if [ -n "$local_dep_dir" ]; then
    target="local:$local_dep_dir"
    if grep -Fxq "$target" "$seen_targets"; then
      continue
    fi
    echo "$target" >> "$seen_targets"

    export LOCAL_DEP_DIR="$local_dep_dir"
    export NEW_HASH="$mismatch_hash"
    perl -0777 -i -pe '
      my $dir = $ENV{"LOCAL_DEP_DIR"};
      my $hash = $ENV{"NEW_HASH"};
      s/(\{\s*dir\s*=\s*"\Q$dir\E"\s*;\s*hash\s*=\s*)"sha256-[^"]+"/$1"$hash"/g;
    ' "$tmpfile"
    continue
  fi

  target="main"
  if grep -Fxq "$target" "$seen_targets"; then
    continue
  fi
  echo "$target" >> "$seen_targets"
  update_hash_in_file "pnpmDepsHash" "$mismatch_hash" "$tmpfile"
done <<EOF
$(extract_hash_mismatches "$multi_mismatch_output")
EOF
rm "$seen_targets"

if grep -q 'pnpmDepsHash = "sha256-NEWMAIN="' "$tmpfile" && \
   grep -q '{ dir = "packages/@overeng/utils"; hash = "sha256-NEWUTILS="; }' "$tmpfile" && \
   grep -q '{ dir = "packages/@overeng/megarepo"; hash = "sha256-NEWMEGAREPO="; }' "$tmpfile"; then
  echo "  ✓ Multi-mismatch update loop updates main and local deps"
else
  echo "  ✗ Multi-mismatch update loop failed"
  cat "$tmpfile"
  rm "$tmpfile"
  exit 1
fi
rm "$tmpfile"

echo ""
echo "All nix-cli-hash tests passed"
