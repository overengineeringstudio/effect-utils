#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
GATE="$ROOT/scripts/buck2-rust-deps.sh"
TASK_MODULE="$ROOT/nix/devenv-modules/tasks/shared/buck2-rust-deps.nix"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
FIXTURE="$TEMP_ROOT/repository"
WORKSPACE_ROOT="workspaces/demo"
WORKSPACE="$FIXTURE/$WORKSPACE_ROOT"
THIRD_PARTY_BUCK_PATH="vendor/cargo/BUCK"
THIRD_PARTY="$FIXTURE/vendor/cargo"
FAKE_REINDEER="$TEMP_ROOT/reindeer"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

mkdir -p "$WORKSPACE" "$THIRD_PARTY/fixups/example"
printf 'vendor = false\nthird_party_dir = "../../vendor/cargo"\n' >"$WORKSPACE/reindeer.toml"
printf 'authoritative lock bytes\n' >"$WORKSPACE/Cargo.lock"
printf '# old graph\n' >"$THIRD_PARTY/BUCK"
printf 'buildscript.run = true\n' >"$THIRD_PARTY/fixups/example/fixups.toml"

cat >"$FAKE_REINDEER" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$CARGO_HOME" >"$FAKE_REINDEER_HOME_LOG"
printf 'invoked\n' >>"$FAKE_REINDEER_CALL_LOG"
if [ "${FAKE_REINDEER_BEHAVIOR:-generate}" = mutate-lock ]; then
  printf 'rewritten lock bytes\n' >Cargo.lock
fi
if [ "${FAKE_REINDEER_BEHAVIOR:-generate}" = unpinned ]; then
  cat <<'UNPINNED'
http_archive(
    name = "example-1.0.0",
    urls = ["https://static.crates.io/crates/example/example-1.0.0.crate"],
)
UNPINNED
  exit 0
fi
cat <<'GRAPH'
# generated graph
http_archive(
    name = "example-1.0.0",
    sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    urls = ["https://static.crates.io/crates/example/example-1.0.0.crate"],
)
GRAPH
FAKE
chmod +x "$FAKE_REINDEER"

export FAKE_REINDEER_HOME_LOG="$TEMP_ROOT/cargo-home"
export FAKE_REINDEER_CALL_LOG="$TEMP_ROOT/calls"
export FAKE_REINDEER_BEHAVIOR=generate
cp "$WORKSPACE/Cargo.lock" "$TEMP_ROOT/original-lock"
"$GATE" generate "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc
cmp -s "$TEMP_ROOT/original-lock" "$WORKSPACE/Cargo.lock" || fail "generate changed Cargo.lock"
grep -Fq 'http_archive(' "$THIRD_PARTY/BUCK" || fail "generate did not install the custom-path candidate graph"
expected_cargo_home="$FIXTURE/.devenv/reindeer-cargo-home"
[ "$(cat "$FAKE_REINDEER_HOME_LOG")" = "$expected_cargo_home" ] || fail "buckify did not use the repository-pinned Cargo home"
"$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc

printf '# graph that must survive a failed gate\n' >"$THIRD_PARTY/BUCK"
cp "$THIRD_PARTY/BUCK" "$TEMP_ROOT/graph-before-lock-rewrite"
export FAKE_REINDEER_BEHAVIOR=mutate-lock
if "$GATE" generate "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc 2>"$TEMP_ROOT/lock-error"; then
  fail "gate accepted a buckify run that rewrote Cargo.lock"
fi
grep -Fq 'changed authoritative workspaces/demo/Cargo.lock' "$TEMP_ROOT/lock-error" || fail "lock rewrite failure was not diagnosed"
cmp -s "$TEMP_ROOT/graph-before-lock-rewrite" "$THIRD_PARTY/BUCK" || fail "failed lock gate replaced the tracked graph"

printf 'authoritative lock bytes\n' >"$WORKSPACE/Cargo.lock"
export FAKE_REINDEER_BEHAVIOR=unpinned
if "$GATE" generate "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc 2>"$TEMP_ROOT/hash-error"; then
  fail "gate accepted an unpinned http_archive"
fi
grep -Fq 'every generated http_archive must carry one sha256 pin' "$TEMP_ROOT/hash-error" || fail "unpinned archive failure was not diagnosed"
cmp -s "$TEMP_ROOT/graph-before-lock-rewrite" "$THIRD_PARTY/BUCK" || fail "unpinned graph replaced the tracked graph"

export FAKE_REINDEER_BEHAVIOR=generate
printf 'authoritative lock bytes\n' >"$WORKSPACE/Cargo.lock"
for key in extra_srcs omit_srcs; do
  printf '%s = ["src/**/*.rs"]\n' "$key" >"$THIRD_PARTY/fixups/example/fixups.toml"
  : >"$FAKE_REINDEER_CALL_LOG"
  if "$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc >"$TEMP_ROOT/$key.stdout" 2>"$TEMP_ROOT/$key.stderr"; then
    fail "gate accepted non-vendored $key"
  fi
  grep -Fq 'non-vendored fixup uses a discarded source key' "$TEMP_ROOT/$key.stderr" || fail "$key failure was not diagnosed"
  [ ! -s "$FAKE_REINDEER_CALL_LOG" ] || fail "$key lint ran Reindeer before rejecting the fixup"
done

mkdir -p "$TEMP_ROOT/outside-workspace"
ln -s "$TEMP_ROOT/outside-workspace" "$FIXTURE/workspaces/escape"
if "$GATE" check "$FIXTURE" "workspaces/escape" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc 2>"$TEMP_ROOT/escape-error"; then
  fail "gate accepted a workspace symlink escaping the repository"
fi
grep -Fq 'workspace root escapes repository' "$TEMP_ROOT/escape-error" || fail "physical workspace escape was not diagnosed"

invalid_prefix_result="$(
  nix-instantiate --eval --strict --expr "
    let
      configured = import $TASK_MODULE {
        workspaceRoot = \"rust\";
        taskPrefix = \"buck2:rust;\$(id)\";
      };
      evaluated = configured {
        lib = {
          splitString = separator: value:
            builtins.filter builtins.isString (builtins.split separator value);
          hasPrefix = prefix: value:
            builtins.substring 0 (builtins.stringLength prefix) value == prefix;
          hasInfix = _: _: false;
          assertMsg = condition: message: if condition then true else throw message;
        };
        pkgs = {};
      };
    in (builtins.tryEval evaluated).success
  "
)"
[ "$invalid_prefix_result" = false ] || fail "task module accepted an unsafe task prefix"

echo "Buck2 Rust dependency gate tests passed."
