# Inspect an extracted buck-build-product/v1 self-contained ELF payload without
# rewriting it. The descriptor is a claim; readelf output is the observation.
{
  pkgs,
  readelf ? "${pkgs.binutils}/bin/readelf",
}:

pkgs.writeShellScript "buck2-runtime-inspect-elf-static" ''
  set -euo pipefail
  export LC_ALL=C

  fail() {
    echo "buck2-runtime-inspect-elf-static: FATAL - $*" >&2
    exit 1
  }

  [ "$#" -eq 2 ] || fail "usage: $0 DESCRIPTOR_JSON EXTRACTED_ROOT"
  descriptor="$1"
  root="$2"
  [ -f "$descriptor" ] || fail "descriptor does not exist"
  [ -d "$root" ] || fail "extracted root does not exist"

  [ "$(${pkgs.jq}/bin/jq -r '.runtime.kind' "$descriptor")" = self-contained ] \
    || fail "descriptor runtime kind must be self-contained"
  [ "$(${pkgs.jq}/bin/jq -r '.runtime.inspectionContract' "$descriptor")" = elf-static/v1 ] \
    || fail "unsupported inspection contract"
  ${pkgs.jq}/bin/jq -e \
    '.platform == { os: "linux", architecture: "x86_64", abi: "musl" }' \
    "$descriptor" >/dev/null \
    || fail "static ELF inspector admits only linux/x86_64/musl"

  inspect_entrypoint() {
    local relative="$1"
    local executable="$root/$relative"
    [ -f "$executable" ] && [ ! -L "$executable" ] \
      || fail "entrypoint must be a regular non-symlink file: $relative"
    [ -x "$executable" ] || fail "entrypoint is not executable: $relative"

    local header actual_class actual_machine
    if ! header="$(${readelf} --file-header "$executable")"; then
      fail "readelf --file-header failed for $relative"
    fi
    actual_class="$(printf '%s\n' "$header" \
      | ${pkgs.gawk}/bin/awk -F: '$1 ~ /^[[:space:]]*Class$/ { sub(/^[[:space:]]+/, "", $2); print $2 }')"
    [ "$actual_class" = ELF64 ] \
      || fail "ELF class mismatch for $relative: expected ELF64, got $actual_class"
    actual_machine="$(printf '%s\n' "$header" \
      | ${pkgs.gawk}/bin/awk -F: '$1 ~ /^[[:space:]]*Machine$/ { sub(/^[[:space:]]+/, "", $2); print $2 }')"
    [ "$actual_machine" = "Advanced Micro Devices X86-64" ] \
      || fail "ELF machine mismatch for $relative: expected x86_64, got $actual_machine"

    local program_headers
    if ! program_headers="$(${readelf} --program-headers "$executable")"; then
      fail "readelf --program-headers failed for $relative"
    fi
    if printf '%s\n' "$program_headers" \
      | ${pkgs.gnugrep}/bin/grep -Eq '^[[:space:]]*INTERP[[:space:]]'; then
      fail "self-contained ELF declares an interpreter: $relative"
    fi

    local dynamic_section
    if ! dynamic_section="$(${readelf} --dynamic "$executable")"; then
      fail "readelf --dynamic failed for $relative"
    fi
    if printf '%s\n' "$dynamic_section" \
      | ${pkgs.gnugrep}/bin/grep -Eq '\(NEEDED\)'; then
      fail "self-contained ELF declares a shared-library dependency: $relative"
    fi
  }

  while IFS= read -r entrypoint; do
    inspect_entrypoint "$entrypoint"
  done < <(${pkgs.jq}/bin/jq -r '.entrypoints[]' "$descriptor")
''
