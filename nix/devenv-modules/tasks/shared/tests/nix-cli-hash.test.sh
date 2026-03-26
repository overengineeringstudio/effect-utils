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

update_value_in_file() {
  local valueKey="$1"
  local newValue="$2"
  local hashSourcePath="$3"
  local packageName="$4"

  export VALUE_KEY="$valueKey"
  export VALUE_VALUE="$newValue"
  export PKG_NAME="$packageName"
  export PLATFORM="$(uname -s)"

  if [ -n "$packageName" ] && grep -qE "(^|[[:space:]])(\"$packageName\"|$packageName)\\s*=" "$hashSourcePath"; then
    perl -0777 -i -pe '
      my $pkg = $ENV{"PKG_NAME"};
      my $key = $ENV{"VALUE_KEY"};
      my $val = $ENV{"VALUE_VALUE"};
      my $platform = $ENV{"PLATFORM"};
      my $changed = 0;

      s{((?:\Q$pkg\E|"\Q$pkg\E")\s*=\s*\{.*?\b\Q$key\E\s*=\s*)"[^"]+"}{
        $changed = 1;
        $1 . "\"$val\""
      }gse;

      if (!$changed) {
        if ($platform eq "Darwin") {
          s{((?:\Q$pkg\E|"\Q$pkg\E")\s*=\s*\{.*?\b\Q$key\E\s*=\s*if\s+pkgs\.stdenv\.isDarwin\s+then\s+)"[^"]+"}{
            $changed = 1;
            $1 . "\"$val\""
          }gse;
        } else {
          s{((?:\Q$pkg\E|"\Q$pkg\E")\s*=\s*\{.*?\b\Q$key\E\s*=\s*if\s+pkgs\.stdenv\.isDarwin\s+then\s+"[^"]+"\s+else\s+)"[^"]+"}{
            $changed = 1;
            $1 . "\"$val\""
          }gse;
        }
      }

      END {
        die "Could not find scoped value $key for package $pkg in $ARGV\n" unless $changed;
      }
    ' "$hashSourcePath"
    return
  fi

  if grep -qE "$valueKey\\s*=\\s*if\\s+pkgs\\.stdenv\\.isDarwin" "$hashSourcePath"; then
    if [[ "$(uname -s)" == "Darwin" ]]; then
      perl -0777 -i -pe '
        my $key = $ENV{"VALUE_KEY"};
        my $val = $ENV{"VALUE_VALUE"};
        my $changed = s/(\b\Q$key\E\s*=\s*if\s+pkgs\.stdenv\.isDarwin\s+then\s+)"[^"]+"/$1"$val"/gs;
        END { die "Could not find Darwin branch for $key in $ARGV\n" unless $changed; }
      ' "$hashSourcePath"
    else
      perl -0777 -i -pe '
        my $key = $ENV{"VALUE_KEY"};
        my $val = $ENV{"VALUE_VALUE"};
        my $changed = s/(\b\Q$key\E\s*=\s*if\s+pkgs\.stdenv\.isDarwin\s+then\s+"[^"]+"\s+else\s+)"[^"]+"/$1"$val"/gs;
        END { die "Could not find Linux branch for $key in $ARGV\n" unless $changed; }
      ' "$hashSourcePath"
    fi
  else
    perl -0777 -i -pe '
      my $key = $ENV{"VALUE_KEY"};
      my $val = $ENV{"VALUE_VALUE"};
      my $changed = s/\b\Q$key\E\s*=\s*"[^"]+"/$key = "$val"/g;
      END { die "Could not find value $key in $ARGV\n" unless $changed; }
    ' "$hashSourcePath"
  fi
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

echo "Testing generic top-level value updates..."
tmpfile=$(mktemp)
cat > "$tmpfile" <<'EOF'
{ pkgs }:
{
  depsBuildFingerprint = "old-fingerprint";
  pnpmDepsHash = "sha256-OLDMAINHASH=";
}
EOF

assert_eq "old-fingerprint" "$(read_value_from_file "depsBuildFingerprint" "$tmpfile" "")" "read_top_level"
update_value_in_file "depsBuildFingerprint" "new-fingerprint" "$tmpfile" ""
assert_eq "new-fingerprint" "$(read_value_from_file "depsBuildFingerprint" "$tmpfile" "")" "update_top_level"
assert_eq "sha256-OLDMAINHASH=" "$(read_value_from_file "pnpmDepsHash" "$tmpfile" "")" "preserve_other_top_level_values"
rm "$tmpfile"

echo "Testing platform-specific top-level value updates..."
tmpfile=$(mktemp)
cat > "$tmpfile" <<'EOF'
{ pkgs }:
{
  depsBuildFingerprint = if pkgs.stdenv.isDarwin
    then "darwin-fingerprint"
    else "linux-fingerprint";
}
EOF

update_value_in_file "depsBuildFingerprint" "updated-fingerprint" "$tmpfile" ""
if [[ "$(uname -s)" == "Darwin" ]]; then
  assert_eq "updated-fingerprint" "$(read_value_from_file "depsBuildFingerprint" "$tmpfile" "")" "update_darwin_branch"
  grep -q 'else "linux-fingerprint"' "$tmpfile"
else
  assert_eq "updated-fingerprint" "$(read_value_from_file "depsBuildFingerprint" "$tmpfile" "")" "update_linux_branch"
  grep -q 'then "darwin-fingerprint"' "$tmpfile"
fi
rm "$tmpfile"

echo "Testing scoped value updates..."
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
update_value_in_file "depsBuildFingerprint" "updated-genie" "$tmpfile" "genie"
assert_eq "updated-genie" "$(read_value_from_file "depsBuildFingerprint" "$tmpfile" "genie")" "update_scoped_value"
assert_eq "sha256-GENIEHASH=" "$(read_value_from_file "pnpmDepsHash" "$tmpfile" "genie")" "preserve_scoped_other_value"
rm "$tmpfile"

echo "Testing hash mismatch parsing..."
multi_mismatch_output=$(cat <<'EOF'
error: hash mismatch in fixed-output derivation '/nix/store/aaa-genie-unwrapped-packages--overeng-utils-pnpm-deps-abc.drv':
  specified: sha256-OLDUTILS=
  got:    sha256-NEWUTILS=
error: hash mismatch in fixed-output derivation '/nix/store/bbb-genie-unwrapped-pnpm-deps-def.drv':
  specified: sha256-OLDMAIN=
  got:    sha256-NEWMAIN=
EOF
)

expected_multi_mismatches=$(cat <<'EOF'
/nix/store/aaa-genie-unwrapped-packages--overeng-utils-pnpm-deps-abc.drv	sha256-NEWUTILS=
/nix/store/bbb-genie-unwrapped-pnpm-deps-def.drv	sha256-NEWMAIN=
EOF
)

assert_eq "$expected_multi_mismatches" "$(extract_hash_mismatches "$multi_mismatch_output")" "extract_hash_mismatches"
assert_eq "packages/@overeng/utils" "$(local_dep_dir_from_drv_path "/nix/store/aaa-genie-unwrapped-packages--overeng-utils-pnpm-deps-abc.drv")" "local_dep_dir_utils"
assert_eq "" "$(local_dep_dir_from_drv_path "/nix/store/bbb-genie-unwrapped-pnpm-deps-def.drv")" "local_dep_dir_main"

echo "nix-cli hash tests passed"
