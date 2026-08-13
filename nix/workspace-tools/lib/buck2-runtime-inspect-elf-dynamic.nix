# Inspect an extracted buck-build-product/v1 elf-dynamic payload without
# rewriting it. The descriptor is a claim; readelf output is the observation.
{
  pkgs,
  readelf ? "${pkgs.binutils}/bin/readelf",
}:

pkgs.writeShellScript "buck2-runtime-inspect-elf-dynamic" ''
  set -euo pipefail
  export LC_ALL=C

  fail() {
    echo "buck2-runtime-inspect-elf-dynamic: FATAL - $*" >&2
    exit 1
  }

  [ "$#" -eq 2 ] || fail "usage: $0 DESCRIPTOR_JSON EXTRACTED_ROOT"
  descriptor="$1"
  root="$2"
  [ -f "$descriptor" ] || fail "descriptor does not exist"
  [ -d "$root" ] || fail "extracted root does not exist"

  [ "$(${pkgs.jq}/bin/jq -r '.runtime.kind' "$descriptor")" = elf-dynamic ] \
    || fail "descriptor runtime kind must be elf-dynamic"
  [ "$(${pkgs.jq}/bin/jq -r '.runtime.inspectionContract' "$descriptor")" = elf-dynamic/v1 ] \
    || fail "unsupported inspection contract"

  inspect_entrypoint() {
    local relative="$1"
    local executable="$root/$relative"
    [ -f "$executable" ] && [ ! -L "$executable" ] \
      || fail "entrypoint must be a regular non-symlink file: $relative"
    [ -x "$executable" ] || fail "entrypoint is not executable: $relative"

    local actual_class expected_class
    actual_class="$(${readelf} --file-header "$executable" \
      | ${pkgs.gawk}/bin/awk -F: '$1 ~ /^[[:space:]]*Class$/ { sub(/^[[:space:]]+/, "", $2); print $2 }')"
    expected_class="$(${pkgs.jq}/bin/jq -r '.runtime.elfClass' "$descriptor")"
    [ "$actual_class" = "$expected_class" ] \
      || fail "ELF class mismatch for $relative: expected $expected_class, got $actual_class"

    local raw_machine actual_machine actual_interpreter
    raw_machine="$(${readelf} --file-header "$executable" \
      | ${pkgs.gawk}/bin/awk -F: '$1 ~ /^[[:space:]]*Machine$/ { sub(/^[[:space:]]+/, "", $2); print $2 }')"
    case "$raw_machine" in
      "Advanced Micro Devices X86-64") actual_machine=x86_64 ;;
      "AArch64") actual_machine=aarch64 ;;
      *) fail "unsupported ELF machine for $relative: $raw_machine" ;;
    esac
    if ! actual_interpreter="$(${readelf} --program-headers "$executable" \
      | ${pkgs.gawk}/bin/awk '
          BEGIN { matches = 0 }
          /Requesting program interpreter:/ {
            marker = "[Requesting program interpreter: "
            start = index($0, marker)
            if (start == 0) exit 2
            matches++
            if (matches != 1) exit 2
            value = substr($0, start + length(marker))
            if (substr(value, length(value), 1) != "]") exit 2
            value = substr(value, 1, length(value) - 1)
            if (value == "" || value ~ /[[:cntrl:]]/) exit 2
            print value
          }
          END { if (matches != 1) exit 2 }')"; then
      fail "malformed ELF program interpreter observation: $relative"
    fi
    [ -n "$actual_interpreter" ] || fail "entrypoint has no ELF program interpreter: $relative"

    local expected_machine expected_interpreter
    expected_machine="$(${pkgs.jq}/bin/jq -r '.runtime.machine' "$descriptor")"
    expected_interpreter="$(${pkgs.jq}/bin/jq -r '.runtime.interpreter' "$descriptor")"
    [ "$actual_machine" = "$expected_machine" ] \
      || fail "ELF machine mismatch for $relative: expected $expected_machine, got $actual_machine"
    [ "$actual_interpreter" = "$expected_interpreter" ] \
      || fail "ELF interpreter mismatch for $relative: expected $expected_interpreter, got $actual_interpreter"

    if ${readelf} --dynamic "$executable" \
      | ${pkgs.gnugrep}/bin/grep -Eq '\((RPATH|RUNPATH)\)'; then
      fail "RPATH/RUNPATH must be absent: $relative"
    fi

    local actual_needed expected_needed
    actual_needed="$(${readelf} --dynamic "$executable" \
      | ${pkgs.gawk}/bin/awk '
          /\(NEEDED\)/ {
            marker = "Shared library: ["
            start = index($0, marker)
            if (start == 0) exit 2
            value = substr($0, start + length(marker))
            if (substr(value, length(value), 1) != "]") exit 2
            print substr(value, 1, length(value) - 1)
          }' \
      | ${pkgs.coreutils}/bin/sort -u)"
    expected_needed="$(${pkgs.jq}/bin/jq -r '.runtime.neededLibraries[]' "$descriptor")"
    [ "$actual_needed" = "$expected_needed" ] \
      || fail "DT_NEEDED mismatch for $relative: expected [$(${pkgs.coreutils}/bin/tr '\n' ' ' <<<"$expected_needed")], got [$(${pkgs.coreutils}/bin/tr '\n' ' ' <<<"$actual_needed")]"

    local version_info actual_symbol_versions expected_symbol_versions
    if ! version_info="$(${readelf} --version-info "$executable")"; then
      fail "readelf --version-info failed for $relative"
    fi
    actual_symbol_versions="$(printf '%s\n' "$version_info" \
      | ${pkgs.gawk}/bin/awk '
          /^[[:space:]]*Version needs section / { in_needs = 1; next }
          /^[[:space:]]*Version (symbols|definition) section / { in_needs = 0 }
          in_needs {
            name_marker = "Name: "
            flags_marker = "  Flags: "
            name_start = index($0, name_marker)
            if (name_start > 0) {
              value = substr($0, name_start + length(name_marker))
              flags_start = index(value, flags_marker)
              if (flags_start == 0) exit 2
              print substr(value, 1, flags_start - 1)
            }
          }' \
      | ${pkgs.coreutils}/bin/sort -u)"
    expected_symbol_versions="$(${pkgs.jq}/bin/jq -r '.runtime.symbolVersionFloors[]' "$descriptor")"
    [ "$actual_symbol_versions" = "$expected_symbol_versions" ] \
      || fail "symbol-version mismatch for $relative: expected [$(${pkgs.coreutils}/bin/tr '\n' ' ' <<<"$expected_symbol_versions")], got [$(${pkgs.coreutils}/bin/tr '\n' ' ' <<<"$actual_symbol_versions")]"
  }

  while IFS= read -r entrypoint; do
    inspect_entrypoint "$entrypoint"
  done < <(${pkgs.jq}/bin/jq -r '.entrypoints[]' "$descriptor")
''
