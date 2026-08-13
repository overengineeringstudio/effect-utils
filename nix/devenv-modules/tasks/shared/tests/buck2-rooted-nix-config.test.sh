#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)}"
helper="$repo_root/nix/devenv-modules/tasks/shared/buck2-rooted-nix-config.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin"
target="$(readlink -f "$(command -v bash)")"
cat >"$tmp/bin/nix" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
out_link=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out-link) out_link="$2"; shift 2 ;;
    *) shift ;;
  esac
done
ln -s "$BUCK2_ROOTED_TEST_TARGET" "$out_link"
printf '%s\n' "$BUCK2_ROOTED_TEST_TARGET"
EOF
chmod +x "$tmp/bin/nix"

export BUCK2_ROOTED_TEST_TARGET="$target"
export BUCK2_ROOTED_NIX_BIN="$tmp/bin/nix"
export BUCK2_ROOTED_MKTEMP_BIN="$(command -v mktemp)"
export BUCK2_ROOTED_READLINK_BIN="$(command -v readlink)"
export BUCK2_ROOTED_RM_BIN="$(command -v rm)"
export BUCK2_ROOTED_RMDIR_BIN="$(command -v rmdir)"

(
  set -euo pipefail
  source "$helper"
  buck2_root_nix_config config .#fixture
  [ "$config" = "$target" ]
  [ -L "$BUCK2_ROOTED_NIX_CONFIG_ROOT" ]
  [ "$(readlink -f "$BUCK2_ROOTED_NIX_CONFIG_ROOT")" = "$config" ]
  # This is the concurrent-GC seam: the root must remain present for the whole
  # simulated Buck child, not merely until `nix build` returns.
  sh -c '[ -L "$BUCK2_ROOTED_NIX_CONFIG_ROOT" ] && [ -f "$1" ]' sh "$config"
  printf '%s\n' "$BUCK2_ROOTED_NIX_CONFIG_ROOT" >"$tmp/root-path"
)
[ ! -e "$(cat "$tmp/root-path")" ]

set +e
BUCK2_ROOTED_SIGNAL_PATH="$tmp/signal-root-path" \
  bash -c '
    set -euo pipefail
    source "$1"
    buck2_root_nix_config config .#fixture
    printf "%s\n" "$BUCK2_ROOTED_NIX_CONFIG_ROOT" >"$BUCK2_ROOTED_SIGNAL_PATH"
    kill -TERM "$BASHPID"
  ' bash "$helper"
signal_status="$?"
set -e
[ "$signal_status" -eq 143 ]
[ ! -e "$(cat "$tmp/signal-root-path")" ]

echo "buck2-rooted-nix-config-test: PASS rooted_during_child=true cleaned_after_exit=true cleaned_after_signal=true"
