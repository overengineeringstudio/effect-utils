# Sourced by runtime inspectors; diagnostic commands must never hide the failure.
{ pkgs }:
pkgs.writeText "buck2-runtime-inspection-failure.sh" ''
  diagnostic_command() {
    local label="$1" status
    shift
    printf '%s\n' "$label:"
    "$@" || {
      status=$?
      printf 'diagnostic command failed (exit %s): %s\n' "$status" "$label"
    }
  }

  fail() {
    echo "$inspector_name: FATAL - $*" >&2
    {
      local path="''${inspection_path:-''${descriptor:-<unavailable>}}"
      printf '%s\n' '--- runtime inspection diagnostics ---'
      printf 'path: %s\n' "$path"
      diagnostic_command 'size (bytes)' ${pkgs.coreutils}/bin/stat -c %s -- "$path"
      diagnostic_command sha256 ${pkgs.coreutils}/bin/sha256sum -- "$path"
      diagnostic_command file ${pkgs.file}/bin/file -- "$path"
      if [ "''${#inspection_command[@]}" -gt 0 ]; then
        diagnostic_command "$inspection_label" "''${inspection_command[@]}" "$path"
      fi
      printf '%s\n' '--- end runtime inspection diagnostics ---'
    } >&2
    exit 1
  }
''
