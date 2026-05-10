# SecretSpec tasks and op-proxy-backed runtime injection.
#
# Repos commit a `secretspec.toml` with standard SecretSpec declarations.
# Optional `[x-op-proxy.refs]` entries map env names to `op://...` references for
# local development without using raw `op` or plaintext dotenv files.
{
  file ? "secretspec.toml",
}:
{ lib, pkgs, ... }:
let
  secretspec = "${pkgs.secretspec}/bin/secretspec";
  escapedFile = lib.escapeShellArg file;
  secretsRun = pkgs.writeShellApplication {
    name = "secrets-run";
    runtimeInputs = [
      pkgs.gawk
      pkgs.secretspec
    ];
    text = ''
      set -euo pipefail

      secrets_file=""
      profile_args=()
      reason="run command with repo secrets"
      cache="1d"

      usage() {
        cat >&2 <<'EOF'
      Usage: secrets-run [--file secretspec.toml] [--profile name] [--reason text] [--cache ttl] -- command [args...]

      Loads missing variables declared in [x-op-proxy.refs] via op-proxy, then
      runs the command through `secretspec run --provider env`.
      EOF
      }

      while [ "$#" -gt 0 ]; do
        case "$1" in
          -f|--file)
            secrets_file="''${2:-}"
            shift 2
            ;;
          -P|--profile)
            profile_args+=(--profile "''${2:-}")
            shift 2
            ;;
          --reason)
            reason="''${2:-}"
            shift 2
            ;;
          --cache)
            cache="''${2:-}"
            shift 2
            ;;
          --)
            shift
            break
            ;;
          -h|--help)
            usage
            exit 0
            ;;
          -*)
            echo "Unknown option: $1" >&2
            usage
            exit 2
            ;;
          *)
            break
            ;;
        esac
      done

      if [ "$#" -eq 0 ]; then
        usage
        exit 2
      fi

      if [ -z "$secrets_file" ]; then
        dir="$PWD"
        while true; do
          if [ -f "$dir/secretspec.toml" ]; then
            secrets_file="$dir/secretspec.toml"
            break
          fi
          if [ "$dir" = "/" ]; then
            echo "No secretspec.toml found; pass --file explicitly." >&2
            exit 1
          fi
          dir="$(dirname "$dir")"
        done
      fi

      refs="$(gawk '
        /^\[x-op-proxy\.refs\][[:space:]]*$/ { in_refs = 1; next }
        /^\[/ { in_refs = 0 }
        in_refs && /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
          key = $0
          sub(/^[[:space:]]*/, "", key)
          sub(/[[:space:]]*=.*/, "", key)
          value = $0
          sub(/^[^=]*=[[:space:]]*"/, "", value)
          sub(/"[[:space:]]*(#.*)?$/, "", value)
          if (value ~ /^op:\/\//) {
            printf "%s\t%s\n", key, value
          }
        }
      ' "$secrets_file")"

      if [ -n "$refs" ]; then
        while IFS="$(printf '\t')" read -r name ref; do
          [ -n "$name" ] || continue
          if [ -n "''${!name:-}" ]; then
            continue
          fi
          if ! command -v op-proxy >/dev/null 2>&1; then
            echo "op-proxy is required to resolve missing [x-op-proxy.refs] entry: $name" >&2
            exit 1
          fi
          value="$(op-proxy read "$ref" --reason "$reason" --cache "$cache")"
          export "$name=$value"
        done <<< "$refs"
      fi

      exec secretspec -f "$secrets_file" run --provider env "''${profile_args[@]}" -- "$@"
    '';
  };
in
{
  packages = [
    pkgs.secretspec
    secretsRun
  ];

  tasks = {
    "secrets:check" = {
      description = "Check required secrets against the current process environment";
      exec = ''
        set -euo pipefail
        if [ ! -f ${escapedFile} ]; then
          echo "No ${file}; nothing to check."
          exit 0
        fi
        ${secretspec} -f ${escapedFile} check --provider env --no-prompt
      '';
    };

    "secrets:prefetch" = {
      description = "Resolve op-proxy-backed secrets into the op-proxy cache";
      exec = ''
        set -euo pipefail
        if [ ! -f ${escapedFile} ]; then
          echo "No ${file}; nothing to prefetch."
          exit 0
        fi
        secrets-run --file ${escapedFile} --reason "prefetch repo secrets" -- true
      '';
    };
  };
}
