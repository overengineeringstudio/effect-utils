# Fail-closed validation shared by Nix-authored Buck tool exports and
# Buck-authored artifacts imported back into Nix.
{ pkgs }:

pkgs.writeShellScript "buck2-artifact-scan" ''
  set -euo pipefail

  fail() {
    echo "buck2-artifact-scan: FATAL - $*" >&2
    exit 1
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
        local target resolved
        target="$(${pkgs.coreutils}/bin/readlink "$path")"
        case "$target" in
          /*) fail "absolute symlink is not relocatable: $relative -> $target" ;;
        esac
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

    while IFS= read -r member; do
      case "$member" in
        ""|"."|"./") continue ;;
        /*|../*|*/../*|*/..) fail "unsafe archive member: $member" ;;
        *$'\r'*) fail "archive member contains a carriage return" ;;
      esac
    done < <(${pkgs.gnutar}/bin/tar --list --file "$archive")

    # The first verbose-list character is tar's member type. Hard links are
    # rejected with devices, FIFOs, sockets, and unknown extensions: portable
    # artifacts have exactly regular files, directories, and symlinks.
    while IFS= read -r metadata; do
      case "''${metadata:0:1}" in
        -|d|l) ;;
        *) fail "unsupported archive member type: ''${metadata:0:1}" ;;
      esac
    done < <(${pkgs.gnutar}/bin/tar --list --verbose --file "$archive")
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
