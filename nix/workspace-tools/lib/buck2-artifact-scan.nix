# Fail-closed validation shared by Nix-authored Buck tool exports and
# Buck-authored artifacts imported back into Nix.
{ pkgs }:

pkgs.writeShellScript "buck2-artifact-scan" ''
  set -euo pipefail
  export LC_ALL=C

  fail() {
    echo "buck2-artifact-scan: FATAL - $*" >&2
    exit 1
  }

  validate_symlink_target() {
    local relative="$1"
    local target="$2"

    [ -n "$target" ] \
      || fail "symlink target must be non-empty: $relative"
    case "$target" in
      *$'\n'*|*$'\r'*) fail "symlink target contains control characters: $relative" ;;
    esac
    if printf '%s' "$target" | ${pkgs.gnugrep}/bin/grep -q '[[:cntrl:]]'; then
      fail "symlink target contains control characters: $relative"
    fi
    case "$target" in
      /*) fail "absolute symlink is not relocatable: $relative -> $target" ;;
      *\\*) fail "symlink target must use portable POSIX separators: $relative -> $target" ;;
      "."|./*|*/.|*/./*|*//*|*/) \
        fail "symlink target must be normalized: $relative -> $target" ;;
    esac
  }

  scan_tree() {
    local root="$1"
    [ -d "$root" ] || fail "tree does not exist: $root"

    local canonical_root
    canonical_root="$(${pkgs.coreutils}/bin/realpath -e "$root")"

    while IFS= read -r -d "" path; do
      local relative="''${path#"$root"/}"
      case "$relative" in
        *$'\n'*|*$'\r'*) fail "path contains a newline: $relative" ;;
      esac

      if [ -L "$path" ]; then
        local target target_with_sentinel resolved
        # The sentinel preserves trailing newlines in the link target across
        # command substitution so the control-character check stays fail-closed.
        target_with_sentinel="$(${pkgs.coreutils}/bin/readlink -n "$path"; printf x)"
        target="''${target_with_sentinel%x}"
        validate_symlink_target "$relative" "$target"
        resolved="$(${pkgs.coreutils}/bin/realpath -m "$(dirname "$path")/$target")"
        case "$resolved" in
          "$canonical_root"|"$canonical_root"/*) ;;
          *) fail "symlink escapes artifact root: $relative -> $target" ;;
        esac
      elif [ -f "$path" ] || [ -d "$path" ]; then
        :
      else
        fail "unsupported tree node type: $relative"
      fi
    done < <(${pkgs.findutils}/bin/find "$root" -mindepth 1 -print0)

    local leaked
    leaked="$(${pkgs.gnugrep}/bin/grep -a -R -l -F -- '${builtins.storeDir}/' "$root" \
      | ${pkgs.coreutils}/bin/head -n 1 || true)"
    if [ -n "$leaked" ]; then
      fail "forbidden Nix store reference in ''${leaked#"$root"/}"
    fi
  }

  scan_archive() {
    local archive="$1"
    [ -f "$archive" ] || fail "archive does not exist: $archive"

    # GNU tar normally stops at the first end-of-archive marker. Validate the
    # complete byte stream as well, otherwise appended bytes or a concatenated
    # second archive would be outside every member/path/resource check below.
    local archive_size canonical_listing complete_listing
    archive_size="$(${pkgs.coreutils}/bin/stat --format=%s "$archive")"
    [ $((archive_size % 512)) -eq 0 ] \
      || fail "archive contains trailing data after end-of-archive marker"
    canonical_listing="$(${pkgs.gnutar}/bin/tar --list --file "$archive")" \
      || fail "archive member listing failed"
    complete_listing="$(${pkgs.gnutar}/bin/tar --ignore-zeros --list --file "$archive" 2>/dev/null)" \
      || fail "archive contains trailing data after end-of-archive marker"
    [ "$canonical_listing" = "$complete_listing" ] \
      || fail "archive contains trailing data after end-of-archive marker"

    # These are deliberately limits on the declared, extracted byte count,
    # rather than on the compact archive. That rejects sparse-file and archive
    # bomb inputs before extraction while leaving ample room for toolchains.
    local max_member_bytes=$((1024 * 1024 * 1024))
    local max_archive_bytes=$((4 * 1024 * 1024 * 1024))
    local archive_bytes=0

    local physical_size end_block end_offset
    physical_size="$(${pkgs.coreutils}/bin/stat --format=%s "$archive")"
    [ $((physical_size % 512)) -eq 0 ] \
      || fail "archive size is not aligned to a complete tar block"
    end_block="$(${pkgs.gnutar}/bin/tar --block-number --list --file "$archive" \
      | ${pkgs.gawk}/bin/awk '/\\*\\* Block of NULs \\*\\*/ { gsub(":", "", $2); print $2; exit }')"
    [[ "$end_block" =~ ^[0-9]+$ ]] || fail "archive has no physical end marker"
    end_offset=$((end_block * 512))
    [ "$physical_size" -ge $((end_offset + 1024)) ] \
      || fail "archive end marker is incomplete"
    ${pkgs.coreutils}/bin/od -An -tu1 -v -j "$end_offset" "$archive" \
      | ${pkgs.gawk}/bin/awk '
          { for (field = 1; field <= NF; field += 1) if ($field != 0) exit 1 }
        ' \
      || fail "non-zero data after archive end marker"

    declare -A seen_members=()
    declare -a archive_members=()
    while IFS= read -r member; do
      case "$member" in
        ""|"."|"./") archive_members+=(""); continue ;;
        /*|../*|*/../*|*/..) fail "unsafe archive member: $member" ;;
        *$'\r'*|*$'\n'*) fail "archive member contains a newline" ;;
        *\\*) fail "archive member must use portable POSIX separators: $member" ;;
      esac

      local normalized="$member"
      while [[ "$normalized" == ./* ]]; do normalized="''${normalized#./}"; done
      while [[ "$normalized" == */ ]]; do normalized="''${normalized%/}"; done
      case "$normalized" in
        ""|*//*|*/./*|*/.) fail "non-canonical archive member: $member" ;;
      esac
      if [ "''${seen_members[$normalized]+present}" = present ]; then
        fail "duplicate archive member: $normalized"
      fi
      seen_members["$normalized"]=1
      archive_members+=("$normalized")
    done < <(${pkgs.gnutar}/bin/tar --list --file "$archive")

    # The first verbose-list character is tar's member type. Hard links are
    # rejected with devices, FIFOs, sockets, and unknown extensions: portable
    # artifacts have exactly regular files, directories, and symlinks.
    declare -A symlink_members=()
    local member_index=0
    while IFS= read -r metadata; do
      local member_type="''${metadata:0:1}"
      case "$member_type" in
        -|d|l) ;;
        *) fail "unsupported archive member type: ''${metadata:0:1}" ;;
      esac

      [ "$member_index" -lt "''${#archive_members[@]}" ] \
        || fail "archive member metadata count mismatch"
      local normalized="''${archive_members[$member_index]}"
      member_index=$((member_index + 1))

      if [ "$member_type" = "-" ]; then
        local permissions owner size remainder
        read -r permissions owner size remainder <<< "$metadata"
        [[ "$size" =~ ^[0-9]+$ ]] || fail "invalid archive member size: $metadata"
        [ "$size" -le "$max_member_bytes" ] \
          || fail "archive member exceeds extracted-size limit: $normalized ($size bytes)"
        archive_bytes=$((archive_bytes + size))
        [ "$archive_bytes" -le "$max_archive_bytes" ] \
          || fail "archive exceeds aggregate extracted-size limit: $archive_bytes bytes"
      elif [ "$member_type" = "l" ] && [ -n "$normalized" ]; then
        symlink_members["$normalized"]=1
      fi
    done < <(${pkgs.gnutar}/bin/tar --list --verbose --numeric-owner --file "$archive")

    [ "$member_index" -eq "''${#archive_members[@]}" ] \
      || fail "archive member metadata count mismatch"

    local member ancestor
    for member in "''${archive_members[@]}"; do
      [ -n "$member" ] || continue
      ancestor="$member"
      while [[ "$ancestor" == */* ]]; do
        ancestor="''${ancestor%/*}"
        if [ "''${symlink_members[$ancestor]+present}" = present ]; then
          fail "archive member is beneath symlink ancestor: $member -> $ancestor"
        fi
      done
    done
  }

  case "''${1-}" in
    tree)
      [ "$#" -eq 2 ] || fail "usage: $0 tree ROOT"
      scan_tree "$2"
      ;;
    archive)
      [ "$#" -eq 2 ] || fail "usage: $0 archive FILE"
      scan_archive "$2"
      ;;
    *) fail "usage: $0 tree ROOT | archive FILE" ;;
  esac
''
