#!/usr/bin/env bash
# Tests for megarepo task output checks.
#
# Warm shell setup may skip expensive task execution, but task status still has
# to validate the current workspace outputs against the current megarepo config.
set -euo pipefail

assert_exit_code() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected exit code: $expected"
    echo "  actual exit code:   $actual"
    exit 1
  fi
  echo "  ok: $label"
}

check_workspace_members() {
  set -o pipefail
  [ -d ./repos ] || exit 1

  _mr_skip_csv="${MEGAREPO_SKIP_MEMBERS:-}"

  should_skip_member() {
    local member="$1"
    if [ -z "$_mr_skip_csv" ]; then
      return 1
    fi

    case ",$_mr_skip_csv," in
      *,"$member",*) return 0 ;;
      *) return 1 ;;
    esac
  }

  members=$(mr ls --output json | jq -r '
    select(._tag == "Success")
    | (.members // .value.members // .value.value.members // [])
    | .[].name
  ') || exit 1

  for member in $members; do
    if should_skip_member "$member"; then
      continue
    fi
    if [ ! -L "./repos/$member" ] && [ ! -d "./repos/$member" ]; then
      exit 1
    fi
  done
}

run_check() {
  (
    cd "$workspace"
    check_workspace_members
  )
}

run_status_check() {
  (
    cd "$workspace"
    check_workspace_members
    status_json=$(mr status --output json 2>/dev/null) || exit 1
    echo "$status_json" \
      | jq -e '(.syncNeeded // false) == false and (.applyNeeded // false) == false' \
      >/dev/null 2>&1
  )
}

echo "Running megarepo status tests..."
echo ""

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

workspace="$tmpdir/workspace"
mkdir -p "$workspace/repos/one" "$workspace/.devenv/task-cache/mr-apply" "$tmpdir/bin"
touch "$workspace/megarepo.kdl"

cat > "$tmpdir/bin/mr" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [ "$1" = "ls" ] && [ "$2" = "--output" ] && [ "$3" = "json" ]; then
  cat <<'JSON'
{
  "_tag": "Success",
  "members": [
    { "name": "one" },
    { "name": "two" }
  ]
}
JSON
  exit 0
fi

if [ "$1" = "status" ] && [ "$2" = "--output" ] && [ "$3" = "json" ]; then
  if [ -n "${MR_STATUS_JSON:-}" ]; then
    printf '%s\n' "$MR_STATUS_JSON"
  else
    cat <<'JSON'
{"syncNeeded":false,"applyNeeded":false}
JSON
  fi
  exit 0
fi

echo "unexpected mr invocation: $*" >&2
exit 2
EOF
chmod +x "$tmpdir/bin/mr"
export PATH="$tmpdir/bin:$PATH"

echo "Test 1: missing configured member fails even with stale cached manifest"
printf 'one\n' > "$workspace/.devenv/task-cache/mr-apply/members.txt"
set +e
run_check
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "current mr ls output is authoritative"

echo ""
echo "Test 2: materialized configured members pass"
mkdir -p "$workspace/repos/two"
set +e
run_check
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "all current members materialized"

echo ""
echo "Test 3: explicit skip allows intentionally omitted member"
rm -rf "$workspace/repos/two"
set +e
MEGAREPO_SKIP_MEMBERS=two run_check
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "skipped member is ignored"

echo ""
echo "Test 4: status check re-runs when apply or sync is needed"
mkdir -p "$workspace/repos/two"
export MR_STATUS_JSON='{"syncNeeded":false,"applyNeeded":false}'
set +e
run_status_check
exit_code=$?
set -e
assert_exit_code 0 "$exit_code" "clean status is cacheable"

export MR_STATUS_JSON='{"syncNeeded":true,"applyNeeded":false}'
set +e
run_status_check
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "syncNeeded invalidates cache"

export MR_STATUS_JSON='{"syncNeeded":false,"applyNeeded":true}'
set +e
run_status_check
exit_code=$?
set -e
assert_exit_code 1 "$exit_code" "applyNeeded invalidates cache"
unset MR_STATUS_JSON

echo ""
echo "Test 5: shared module points setup checks at mr:setup"
module_file="$(cd "$(dirname "$0")/.." && pwd)/megarepo.nix"
if ! grep -F 'after = [ "mr:setup" ];' "$module_file" >/dev/null; then
  echo "FAIL: mr:check should depend on mr:setup"
  exit 1
fi
if grep -F '[devenv] Fix: devenv tasks run mr:apply' "$module_file" >/dev/null; then
  echo "FAIL: setup repair hint should not point at mr:apply"
  exit 1
fi
if ! grep -F '[devenv] Fix: devenv tasks run mr:setup' "$module_file" >/dev/null; then
  echo "FAIL: setup repair hint should point at mr:setup"
  exit 1
fi
echo "  ok: setup task is the canonical setup dependency"

echo ""
echo "All megarepo status tests passed"
