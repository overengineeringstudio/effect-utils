#!/usr/bin/env bash
# mr:setup option contract: without setupCommitMembers, setup is the plain
# tracking apply with root-only readiness; with it, setup prepares the listed
# members' nested trees and readiness covers nested mounts on every path.
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
NIX_FLAKE_REF="${NIX_FLAKE_REF:-git+file://$ROOT?shallow=1}"

setup_task_attr() {
  local members="$1"
  local attr="$2"
  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      module = (import $ROOT/nix/devenv-modules/tasks/shared/megarepo.nix {
        setupCommitMembers = $members;
      }) { inherit pkgs; lib = pkgs.lib; };
    in module.tasks.\"mr:setup\".$attr
  "
}

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
workspace="$tmpdir/workspace"
mkdir -p "$workspace/repos/plain" "$workspace/repos/nested" "$tmpdir/bin"
touch "$workspace/megarepo.kdl"
calls="$tmpdir/calls"

cat > "$tmpdir/bin/mr" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${MR_CALLS:?}"
case "$*" in
  'root --output json') printf '{"_tag":"Success","root":"%s"}\n' "${MR_ROOT:?}" ;;
  'ls --output json') printf '{"_tag":"Success","members":[{"name":"plain"},{"name":"nested"}]}\n' ;;
  status*) printf '{"syncNeeded":false,"applyNeeded":%s}\n' "${MR_APPLY_NEEDED:-false}" ;;
  apply*) ;;
  *) echo "unexpected mr invocation: $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$tmpdir/bin/mr"
export PATH="$tmpdir/bin:$PATH" MR_ROOT="$workspace" MR_CALLS="$calls"

# Runs a task script in the fixture workspace; prints its exit code.
run_script() {
  local script="$1"
  : > "$calls"
  set +e
  (cd "$workspace" && bash -c "$script") >/dev/null 2>&1
  local code=$?
  set -e
  echo "$code"
}

fail() {
  echo "FAIL: $1" >&2
  echo "  mr calls:" >&2
  sed 's/^/    /' "$calls" >&2
  exit 1
}

echo "Running megarepo setup commit-members tests..."

echo "Test 1: option unset keeps plain tracking setup"
exec_unset="$(setup_task_attr '[ ]' exec)"
status_unset="$(setup_task_attr '[ ]' status)"
[ "$(run_script "$exec_unset")" = 0 ] || fail "unset setup exec failed"
grep -qx 'apply --worktree-mode tracking --lock-sync off' "$calls" \
  || fail "unset setup must run the plain tracking apply"
[ "$(DEVENV_SETUP_OUTER_CACHE_HIT=1 run_script "$status_unset")" = 0 ] \
  || fail "unset cache-hit readiness must pass on root mounts"
if grep -q '^status' "$calls"; then
  fail "unset cache-hit readiness must not query mr status"
fi
[ "$(run_script "$status_unset")" = 0 ] || fail "unset readiness failed"
grep -qx 'status --output json' "$calls" || fail "unset readiness must stay root-only"
echo "  ok"

echo "Test 2: listed members are applied with recursive commit preparation"
exec_set="$(setup_task_attr '[ "nested" "other" ]' exec)"
status_set="$(setup_task_attr '[ "nested" "other" ]' status)"
[ "$(run_script "$exec_set")" = 0 ] || fail "set setup exec failed"
grep -qx 'apply --worktree-mode tracking --commit-members nested,other --lock-sync off' "$calls" \
  || fail "set setup must pass exactly the listed members"
echo "  ok"

echo "Test 3: readiness is recursive, including the outer cache-hit path"
[ "$(DEVENV_SETUP_OUTER_CACHE_HIT=1 run_script "$status_set")" = 0 ] \
  || fail "prepared nested tree must be ready"
grep -qx 'status --all --output json' "$calls" || fail "cache-hit readiness must use mr status --all"
[ "$(DEVENV_SETUP_OUTER_CACHE_HIT=1 MR_APPLY_NEEDED=true run_script "$status_set")" = 1 ] \
  || fail "missing nested mounts must make setup run despite the outer cache hit"
echo "  ok"

echo "All megarepo setup commit-members tests passed"
