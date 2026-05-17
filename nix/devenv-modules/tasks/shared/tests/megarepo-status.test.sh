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

if [ "$1" != "ls" ] || [ "$2" != "--output" ] || [ "$3" != "json" ]; then
  echo "unexpected mr invocation: $*" >&2
  exit 2
fi

cat <<'JSON'
{
  "_tag": "Success",
  "members": [
    { "name": "one" },
    { "name": "two" }
  ]
}
JSON
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
echo "All megarepo status tests passed"
