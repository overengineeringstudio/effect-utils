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

echo "nix-cli-hash tests passed"
