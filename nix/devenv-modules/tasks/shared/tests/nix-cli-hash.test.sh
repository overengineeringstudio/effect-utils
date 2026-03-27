#!/usr/bin/env bash
set -euo pipefail

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

read_value_from_file() {
  local valueKey="$1"
  local hashSourcePath="$2"
  local packageName="$3"

  VALUE_KEY="$valueKey" PKG_NAME="$packageName" PLATFORM="$(uname -s)" perl -0777 -ne '
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

echo "Testing generic top-level value reads..."
tmpfile=$(mktemp)
cat > "$tmpfile" <<'EOF'
{ pkgs }:
{
  depsBuildFingerprint = "old-fingerprint";
  pnpmDepsHash = "sha256-OLDMAINHASH=";
}
EOF

assert_eq "old-fingerprint" "$(read_value_from_file "depsBuildFingerprint" "$tmpfile" "")" "read_top_level"
assert_eq "sha256-OLDMAINHASH=" "$(read_value_from_file "pnpmDepsHash" "$tmpfile" "")" "preserve_other_top_level_values"
rm "$tmpfile"

echo "Testing platform-specific top-level value reads..."
tmpfile=$(mktemp)
cat > "$tmpfile" <<'EOF'
{ pkgs }:
{
  depsBuildFingerprint = if pkgs.stdenv.isDarwin
    then "darwin-fingerprint"
    else "linux-fingerprint";
}
EOF

if [[ "$(uname -s)" == "Darwin" ]]; then
  assert_eq "darwin-fingerprint" "$(read_value_from_file "depsBuildFingerprint" "$tmpfile" "")" "read_darwin_branch"
else
  assert_eq "linux-fingerprint" "$(read_value_from_file "depsBuildFingerprint" "$tmpfile" "")" "read_linux_branch"
fi
rm "$tmpfile"

echo "Testing scoped value reads..."
tmpfile=$(mktemp)
cat > "$tmpfile" <<'EOF'
{
  "genie" = {
    depsBuildFingerprint = if pkgs.stdenv.isDarwin
      then "darwin-genie"
      else "linux-genie";
    pnpmDepsHash = "sha256-GENIEHASH=";
  };
}
EOF

assert_eq "$([[ "$(uname -s)" == "Darwin" ]] && echo "darwin-genie" || echo "linux-genie")" "$(read_value_from_file "depsBuildFingerprint" "$tmpfile" "genie")" "read_scoped_value"
assert_eq "sha256-GENIEHASH=" "$(read_value_from_file "pnpmDepsHash" "$tmpfile" "genie")" "preserve_scoped_other_value"
rm "$tmpfile"

echo "nix-cli read helper tests passed"
