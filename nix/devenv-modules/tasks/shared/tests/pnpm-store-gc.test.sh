#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
# Retain fixtures for inspection: the collector's default contract is no deletion.
fixture="$(mktemp -d "${TMPDIR:-/tmp}/pnpm-store-gc-test.XXXXXXXX")"
export PNPM_GC_TEST_ROOT="$fixture"
export XDG_STATE_HOME="$fixture/state"
export HOME="$fixture/home"
unset GITHUB_ACTIONS PNPM_JOB_LOCAL_STORE
"${RUSTC_BIN:-rustc}" --edition=2024 -D warnings --test \
  "$ROOT/nix/devenv-modules/tasks/shared/pnpm-store-gc.rs" -o "$fixture/tests"
"$fixture/tests"
# This cfg is never enabled by the production Nix package.
"${RUSTC_BIN:-rustc}" --edition=2024 -D warnings --cfg pnpm_gc_test \
  "$ROOT/nix/devenv-modules/tasks/shared/pnpm-store-gc.rs" -o "$fixture/engine"
export PNPM_GC_TEST_PROC_ROOT="$fixture/proc"
mkdir -p "$PNPM_GC_TEST_PROC_ROOT"
git init --bare -q "$fixture/repo.git"
store="$fixture/retired-root/.devenv/pnpm-store-pure-v1"
mkdir -p "$store/v11/files"
printf 'preserve\n' > "$store/v11/files/sentinel"
"$fixture/engine" --git-dir "$fixture/repo.git" --root "$fixture/retired-root" --observe
test -f "$store/.effect-utils-pnpm-store-cache-maintenance.lock"
test "$(cat "$store/v11/files/sentinel")" = preserve
if flock --shared "$store/.effect-utils-pnpm-store-cache-maintenance.lock" \
  "$fixture/engine" --git-dir "$fixture/repo.git" --root "$fixture/retired-root" --observe; then
  echo "FAIL: observer entered while a consumer held the shared maintenance lease" >&2
  exit 1
fi
if "$fixture/engine" --locked --git-dir "$fixture/repo.git" --root "$fixture/retired-root" --observe; then
  echo "FAIL: observer accepted an unproved inherited lease" >&2
  exit 1
fi
test "$(cat "$store/v11/files/sentinel")" = preserve
echo "PASS: real exclusive lease admission, shared-consumer exclusion, and inherited-lease proof; no payloads deleted"
shared_commit=727cb7544bea32ec031c9f6e5e840cbe717e772a
if git -C "$ROOT" cat-file -e "$shared_commit^{commit}" 2>/dev/null; then
  repo="$HOME/.megarepo/github.com/fixture/store-config/.bare"
  checkout="$HOME/.megarepo/github.com/fixture/store-config/refs/heads/config-proof"
  mkdir -p "$(dirname "$repo")" "$(dirname "$checkout")"
  git clone --quiet --bare --shared "$ROOT" "$repo"
  git --git-dir "$repo" worktree add --no-checkout --quiet --detach "$checkout" "$shared_commit"
  mkdir -p "$checkout/.devenv/pnpm-store-pure-v1/v11/files"
  printf 'preserve\n' > "$checkout/.devenv/pnpm-store-pure-v1/v11/files/sentinel"
  result="$("$fixture/engine" --git-dir "$repo" --root "$checkout")"
  case "$result" in *$'grace\t'*) ;; *) echo "$result"; exit 1 ;; esac
  result="$(PNPM_JOB_LOCAL_STORE=1 "$fixture/engine" --git-dir "$repo" --root "$checkout")"
  case "$result" in *"explicitly selects job-local"*) ;; *) echo "$result"; exit 1 ;; esac
  result="$(GITHUB_ACTIONS=true "$fixture/engine" --git-dir "$repo" --root "$checkout")"
  case "$result" in *"explicitly selects job-local"*) ;; *) echo "$result"; exit 1 ;; esac
  mkdir -p "$checkout/node_modules"
  node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({storeDir:process.argv[2]}))' \
    "$checkout/node_modules/.modules.yaml" "$checkout/.devenv/pnpm-store-pure-v1/v11"
  result="$("$fixture/engine" --git-dir "$repo" --root "$checkout")"
  case "$result" in *"checkout still references a worktree-local store"*) ;; *) echo "$result"; exit 1 ;; esac
  test "$(cat "$checkout/.devenv/pnpm-store-pure-v1/v11/files/sentinel")" = preserve
  echo "PASS: real #1794 ancestry admits an unreferenced cache; legacy projection references still protect it"
else
  echo "Ancestry fixture unavailable in this shallow source checkout; receipt and ownership unit proofs still run"
fi
printf 'pnpm-store-gc fixtures retained at %s\n' "$fixture"
