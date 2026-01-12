{ pkgs }:

pkgs.writeShellApplication {
  name = "update-bun-hashes";
  runtimeInputs = [
    pkgs.ripgrep
    pkgs.gnused
    pkgs.perl
  ];
  text = ''
    set -euo pipefail

    targets=(".#default:flake.nix,nix/build.nix")
    custom_targets=0
    dry_run=0

    usage() {
      echo "Usage: update-bun-hashes [--dry-run] [--target <target:files>]" >&2
      echo "Example: update-bun-hashes --target '.#default:flake.nix,nix/build.nix'" >&2
      echo "Example: update-bun-hashes --target '.#genie:../effect-utils/flake.nix#genie'" >&2
    }

    while [ $# -gt 0 ]; do
      case "$1" in
        --dry-run)
          dry_run=1
          shift
          ;;
        --target)
          if [ $# -lt 2 ]; then
            usage
            exit 1
          fi
          if [ "$custom_targets" -eq 0 ]; then
            targets=()
            custom_targets=1
          fi
          targets+=("$2")
          shift 2
          ;;
        --help|-h)
          usage
          exit 0
          ;;
        *)
          usage
          exit 1
          ;;
      esac
    done

    for spec in "''${targets[@]}"; do
      target="''${spec%%:*}"
      files_csv="''${spec#*:}"

      if [ "$files_csv" = "$spec" ]; then
        echo "update-bun-hashes: invalid target spec '$spec' (expected target:files)" >&2
        exit 1
      fi

      build_output="$(nix build "$target" --no-link 2>&1)" || {
        got_hash="$(echo "$build_output" | rg -o 'got:\\s+sha256-[A-Za-z0-9+/=]+' | rg -o 'sha256-[A-Za-z0-9+/=]+' | head -n 1 || true)"
        if [ -z "$got_hash" ]; then
          echo "$build_output" >&2
          exit 1
        fi

        IFS=',' read -r -a files <<< "$files_csv"
        for file in "''${files[@]}"; do
          selector=""
          if echo "$file" | rg -q '#'; then
            selector="''${file#*#}"
            file="''${file%%#*}"
          fi

          if [ ! -f "$file" ]; then
            echo "update-bun-hashes: missing file '$file'" >&2
            exit 1
          fi
          if ! rg -q "bunDepsHash" "$file"; then
            echo "update-bun-hashes: no bunDepsHash found in '$file'" >&2
            exit 1
          fi

          if [ "$dry_run" -eq 1 ]; then
            if [ -z "$selector" ]; then
              echo "Would update $file to $got_hash"
            else
              echo "Would update $file ($selector) to $got_hash"
            fi
          else
            if [ -z "$selector" ]; then
              hash_count="$(rg -c "bunDepsHash" "$file")"
              if [ "$hash_count" -gt 1 ]; then
                echo "update-bun-hashes: multiple bunDepsHash entries in '$file' (use #selector)" >&2
                exit 1
              fi
              export BUN_HASH="$got_hash"
              perl -0777 -i -pe '
                my $hash = $ENV{"BUN_HASH"};
                s/\bbunDepsHash\s*=\s*(?:"sha256-[^"]+"|pkgs\.lib\.fakeHash|lib\.fakeHash)/qq(bunDepsHash = "$hash")/e;
              ' "$file"
              echo "Updated $file to $got_hash"
            else
              export BUN_HASH_KEY="$selector"
              export BUN_HASH="$got_hash"
              if ! perl -0777 -ne '
                my $key = $ENV{"BUN_HASH_KEY"};
                my $re = qr/(\n\s*\Q$key\E\s*=\s*mkBunCli\s*\{[\s\S]*?\bbunDepsHash\s*=\s*)(?:"sha256-[^"]+"|pkgs\.lib\.fakeHash|lib\.fakeHash)/;
                exit 0 if /$re/;
                exit 1;
              ' "$file"; then
                echo "update-bun-hashes: selector '$selector' not found in '$file'" >&2
                exit 1
              fi
              perl -0777 -i -pe '
                my $key = $ENV{"BUN_HASH_KEY"};
                my $hash = $ENV{"BUN_HASH"};
                my $re = qr/(\n\s*\Q$key\E\s*=\s*mkBunCli\s*\{[\s\S]*?\bbunDepsHash\s*=\s*)(?:"sha256-[^"]+"|pkgs\.lib\.fakeHash|lib\.fakeHash)/;
                s/$re/$1"$hash"/;
              ' "$file"
              echo "Updated $file ($selector) to $got_hash"
            fi
          fi
        done

        continue
      }

      echo "No hash update needed for $target"
    done
  '';
}
