#!/usr/bin/env bash
# mr:setup option contract: without setupCommitMembers, setup is the plain
# tracking apply with root-only readiness; with it, setup prepares and checks
# only the listed, non-skipped members' nested trees on every readiness path.
# Under CI=true, setup uses commit worktrees and prepares/checks every tree.
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
mkdir -p "$workspace/repos/plain" "$workspace/repos/nested" "$workspace/repos/unlisted" "$tmpdir/bin"
touch "$workspace/megarepo.kdl" "$workspace/repos/nested/megarepo.kdl" "$workspace/repos/unlisted/megarepo.json"
calls="$tmpdir/calls"
status_calls="$tmpdir/status-calls"

cat > "$tmpdir/bin/mr" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${MR_CALLS:?}"
case "$*" in
  'root --output json') printf '{"_tag":"Success","root":"%s"}\n' "${MR_ROOT:?}" ;;
  'ls --output json') printf '{"_tag":"Success","members":[{"name":"plain"},{"name":"nested"},{"name":"unlisted"}]}\n' ;;
  'status --output json'|'status --all --output json')
    printf '%s: %s\n' "${PWD#"${MR_ROOT:?}"}" "$*" >> "${MR_STATUS_CALLS:?}"
    case "$PWD:$*" in
      "$MR_ROOT:status --output json") needed="${MR_ROOT_APPLY_NEEDED:-false}" ;;
      "$MR_ROOT:status --all --output json")
        needed=false
        if [ "${MR_NESTED_APPLY_NEEDED:-false}" = true ] || [ "${MR_UNLISTED_APPLY_NEEDED:-true}" = true ]; then
          needed=true
        fi
        ;;
      "$MR_ROOT/repos/nested:status --all --output json") needed="${MR_NESTED_APPLY_NEEDED:-false}" ;;
      "$MR_ROOT/repos/unlisted:status --all --output json") needed="${MR_UNLISTED_APPLY_NEEDED:-true}" ;;
      *) echo "unexpected status scope: $PWD: $*" >&2; exit 2 ;;
    esac
    printf '{"syncNeeded":false,"applyNeeded":%s}\n' "$needed"
    ;;
  apply*) ;;
  *) echo "unexpected mr invocation: $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$tmpdir/bin/mr"
export PATH="$tmpdir/bin:$PATH" MR_ROOT="$workspace" MR_CALLS="$calls" MR_STATUS_CALLS="$status_calls"
# Local cases must not inherit the runner's CI marker.
unset CI

# Runs a task script in the fixture workspace; prints its exit code.
run_script() {
  local script="$1"
  : > "$calls"
  : > "$status_calls"
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
  echo "  status scopes:" >&2
  cat "$status_calls" >&2
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
exec_set="$(setup_task_attr '[ "nested" "plain" ]' exec)"
status_set="$(setup_task_attr '[ "nested" "plain" ]' status)"
[ "$(run_script "$exec_set")" = 0 ] || fail "set setup exec failed"
grep -qx 'apply --worktree-mode tracking --commit-members nested,plain --lock-sync off' "$calls" \
  || fail "set setup must pass exactly the listed members"
echo "  ok"

echo "Test 3: local readiness ignores unlisted missing nested mounts on cold and warm paths"
for cache_hit in 0 1; do
  [ "$(DEVENV_SETUP_OUTER_CACHE_HIT="$cache_hit" run_script "$status_set")" = 0 ] \
    || fail "unlisted missing nested mounts must not block local readiness"
  [ "$(cat "$status_calls")" = $': status --output json\n/repos/nested: status --all --output json' ] \
    || fail "local readiness must check root plus selected nested scope only"
done
echo "  ok"

echo "Test 4: listed missing nested mounts block cold and warm readiness"
for cache_hit in 0 1; do
  [ "$(DEVENV_SETUP_OUTER_CACHE_HIT="$cache_hit" MR_NESTED_APPLY_NEEDED=true run_script "$status_set")" = 1 ] \
    || fail "listed missing nested mounts must make setup run"
  grep -qx '/repos/nested: status --all --output json' "$status_calls" \
    || fail "listed nested scope must be queried"
done
echo "  ok"

echo "Test 5: every non-skipped root remains required"
mv "$workspace/repos/unlisted" "$tmpdir/unlisted"
for cache_hit in 0 1; do
  [ "$(DEVENV_SETUP_OUTER_CACHE_HIT="$cache_hit" run_script "$status_set")" = 1 ] \
    || fail "unlisted missing root mounts must block local readiness"
done
mv "$tmpdir/unlisted" "$workspace/repos/unlisted"
[ "$(DEVENV_SETUP_OUTER_CACHE_HIT=1 MR_ROOT_APPLY_NEEDED=true run_script "$status_set")" = 1 ] \
  || fail "root apply-needed must block warm readiness"
echo "  ok"

echo "Test 6: skipped selected roots are not nested-checked"
[ "$(DEVENV_SETUP_OUTER_CACHE_HIT=1 MEGAREPO_SKIP_MEMBERS=nested MR_NESTED_APPLY_NEEDED=true run_script "$status_set")" = 0 ] \
  || fail "skipped selected nested mounts must not block readiness"
[ "$(cat "$status_calls")" = ': status --output json' ] \
  || fail "skipped selected roots must not get a nested status check"
mv "$workspace/repos/nested" "$tmpdir/nested"
[ "$(DEVENV_SETUP_OUTER_CACHE_HIT=1 MEGAREPO_SKIP_MEMBERS=nested run_script "$status_set")" = 0 ] \
  || fail "skipped selected root mounts may be omitted"
mv "$tmpdir/nested" "$workspace/repos/nested"
[ "$(MEGAREPO_SKIP_MEMBERS=nested run_script "$exec_set")" = 0 ] || fail "skipped setup exec failed"
grep -qx 'apply --worktree-mode tracking --commit-members nested,plain --lock-sync off --skip nested' "$calls" \
  || fail "exec must preserve the skip selection"
echo "  ok"

echo "Test 7: ordinary selected roots are accepted without nested checks"
status_plain="$(setup_task_attr '[ "plain" ]' status)"
[ "$(DEVENV_SETUP_OUTER_CACHE_HIT=1 run_script "$status_plain")" = 0 ] \
  || fail "ordinary selected repos need no megarepo config"
[ "$(cat "$status_calls")" = ': status --output json' ] \
  || fail "ordinary selected repos must not get a nested status check"
echo "  ok"

echo "Test 8: CI applies commit worktrees and prepares every root member's tree"
[ "$(CI=true run_script "$exec_unset")" = 0 ] || fail "unset CI setup exec failed"
grep -qx 'apply --worktree-mode commit --lock-sync off' "$calls" \
  || fail "unset CI setup must apply commit worktrees"
[ "$(CI=true run_script "$exec_set")" = 0 ] || fail "set CI setup exec failed"
grep -qx 'apply --worktree-mode commit --commit-all-members --lock-sync off' "$calls" \
  || fail "set CI setup must prepare every member that mr status --all inspects"
if grep -q 'tracking' "$calls"; then
  fail "CI setup must never use tracking worktrees"
fi
echo "  ok"

echo "Test 9: CI still checks unlisted nested trees on cold and warm paths"
for cache_hit in 0 1; do
  [ "$(CI=true DEVENV_SETUP_OUTER_CACHE_HIT="$cache_hit" run_script "$status_set")" = 1 ] \
    || fail "CI must reject unlisted missing nested mounts"
  [ "$(cat "$status_calls")" = ': status --all --output json' ] \
    || fail "CI readiness must remain recursive at the root"
  [ "$(CI=true DEVENV_SETUP_OUTER_CACHE_HIT="$cache_hit" MR_UNLISTED_APPLY_NEEDED=false run_script "$status_set")" = 0 ] \
    || fail "CI readiness must converge when all nested trees are prepared"
done
echo "  ok"

echo "All megarepo setup commit-members tests passed"
