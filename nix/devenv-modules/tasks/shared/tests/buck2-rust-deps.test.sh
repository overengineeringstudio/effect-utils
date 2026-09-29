#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
GATE=gate
gate() {
  "$ROOT/scripts/buck2-rust-deps.sh" "$@" "$ROOT/scripts/buck2-rust-foreign-fixups.ts"
}
TASK_MODULE="$ROOT/nix/devenv-modules/tasks/shared/buck2-rust-deps.nix"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
FIXTURE="$TEMP_ROOT/repository"
WORKSPACE_ROOT="workspaces/demo"
WORKSPACE="$FIXTURE/$WORKSPACE_ROOT"
THIRD_PARTY_BUCK_PATH="vendor/cargo/BUCK"
THIRD_PARTY="$FIXTURE/vendor/cargo"
FAKE_REINDEER="$TEMP_ROOT/reindeer"
BUN="${BUN_BIN:-$(command -v bun || true)}"
[ -n "$BUN" ] || { echo "FAIL: bun is required (set BUN_BIN)" >&2; exit 1; }

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
if [ "${FAKE_REINDEER_BEHAVIOR:-generate}" = git-fetch ] || [ "${FAKE_REINDEER_BEHAVIOR:-generate}" = git-archive ]; then
  rule=git_fetch
  [ "$FAKE_REINDEER_BEHAVIOR" = git-fetch ] || rule=git_archive
  cat <<GRAPH
crate_archive(
    name = "example-1.0.0",
    sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    urls = ["https://static.crates.io/crates/example/example-1.0.0.crate"],
)

$rule(
    name = "demo-0123456789abcdef.git",
    repo = "https://github.com/owner/demo",
    rev = "0123456789abcdef0123456789abcdef01234567",
    visibility = [],
)
GRAPH
  exit 0
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
"$GATE" generate "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN"
cmp -s "$TEMP_ROOT/original-lock" "$WORKSPACE/Cargo.lock" || fail "generate changed Cargo.lock"
grep -Fq 'http_archive(' "$THIRD_PARTY/BUCK" || fail "generate did not install the custom-path candidate graph"
# The gate resolves the repository physically (macOS temp dirs live behind /var -> /private/var).
expected_cargo_home="$(cd "$FIXTURE" && pwd -P)/.devenv/reindeer-cargo-home"
[ "$(cat "$FAKE_REINDEER_HOME_LOG")" = "$expected_cargo_home" ] || fail "buckify did not use the repository-pinned Cargo home"
"$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN"

printf '# graph that must survive a failed gate\n' >"$THIRD_PARTY/BUCK"
cp "$THIRD_PARTY/BUCK" "$TEMP_ROOT/graph-before-lock-rewrite"
export FAKE_REINDEER_BEHAVIOR=mutate-lock
if "$GATE" generate "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN" 2>"$TEMP_ROOT/lock-error"; then
  fail "gate accepted a buckify run that rewrote Cargo.lock"
fi
grep -Fq 'changed authoritative workspaces/demo/Cargo.lock' "$TEMP_ROOT/lock-error" || fail "lock rewrite failure was not diagnosed"
cmp -s "$TEMP_ROOT/graph-before-lock-rewrite" "$THIRD_PARTY/BUCK" || fail "failed lock gate replaced the tracked graph"

printf 'authoritative lock bytes\n' >"$WORKSPACE/Cargo.lock"
export FAKE_REINDEER_BEHAVIOR=unpinned
if "$GATE" generate "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN" 2>"$TEMP_ROOT/hash-error"; then
  fail "gate accepted an unpinned http_archive"
fi
grep -Fq 'every generated crate archive must carry one sha256 pin' "$TEMP_ROOT/hash-error" || fail "unpinned archive failure was not diagnosed"
cmp -s "$TEMP_ROOT/graph-before-lock-rewrite" "$THIRD_PARTY/BUCK" || fail "unpinned graph replaced the tracked graph"

export FAKE_REINDEER_BEHAVIOR=generate
printf 'authoritative lock bytes\n' >"$WORKSPACE/Cargo.lock"
for key in extra_srcs omit_srcs; do
  printf '%s = ["src/**/*.rs"]\n' "$key" >"$THIRD_PARTY/fixups/example/fixups.toml"
  : >"$FAKE_REINDEER_CALL_LOG"
  if "$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN" >"$TEMP_ROOT/$key.stdout" 2>"$TEMP_ROOT/$key.stderr"; then
    fail "gate accepted non-vendored $key"
  fi
  grep -Fq 'non-vendored fixup uses a discarded source key' "$TEMP_ROOT/$key.stderr" || fail "$key failure was not diagnosed"
  [ ! -s "$FAKE_REINDEER_CALL_LOG" ] || fail "$key lint ran Reindeer before rejecting the fixup"
done

mkdir -p "$TEMP_ROOT/outside-workspace"
ln -s "$TEMP_ROOT/outside-workspace" "$FIXTURE/workspaces/escape"
if "$GATE" check "$FIXTURE" "workspaces/escape" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN" 2>"$TEMP_ROOT/escape-error"; then
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

mkdir -p "$FIXTURE/decoy"
printf 'vendor = false\nthird_party_dir = "../../decoy"\n' >"$WORKSPACE/reindeer.toml"
if "$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN" 2>"$TEMP_ROOT/graph-mismatch-error"; then
  fail "gate accepted a BUCK path that disagrees with reindeer.toml"
fi
grep -Fq 'third-party BUCK disagrees' "$TEMP_ROOT/graph-mismatch-error" || fail "third-party graph mismatch was not diagnosed"

# A matching key inside a non-root table must not mask the root setting Reindeer uses.
printf 'vendor = false\nthird_party_dir = "../../decoy"\n\n[buck]\nthird_party_dir = "../../vendor/cargo"\n' >"$WORKSPACE/reindeer.toml"
if "$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN" 2>"$TEMP_ROOT/table-decoy-error"; then
  fail "gate accepted third_party_dir from a non-root table"
fi
grep -Fq 'third-party BUCK disagrees' "$TEMP_ROOT/table-decoy-error" || fail "non-root third_party_dir decoy was not diagnosed"

printf 'third_party_dir = "../../vendor/cargo"\n\n[vendor]\ngitignore_checksum_exclude = []\n' >"$WORKSPACE/reindeer.toml"
if "$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN" 2>"$TEMP_ROOT/vendor-table-error"; then
  fail "gate accepted a vendoring table instead of vendor = false"
fi
grep -Fq 'must select root-level vendor = false' "$TEMP_ROOT/vendor-table-error" || fail "vendoring table was not diagnosed"

printf 'third_party_dir = "../../vendor/cargo"\n\n[buck]\nvendor = false\n' >"$WORKSPACE/reindeer.toml"
if "$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN" 2>"$TEMP_ROOT/vendor-nested-error"; then
  fail "gate accepted vendor = false from a non-root table"
fi
grep -Fq 'must select root-level vendor = false' "$TEMP_ROOT/vendor-nested-error" || fail "non-root vendor setting was not diagnosed"

# TOML literal strings are valid Reindeer input.
printf 'buildscript.run = true\n' >"$THIRD_PARTY/fixups/example/fixups.toml"
printf 'authoritative lock bytes\n' >"$WORKSPACE/Cargo.lock"
export FAKE_REINDEER_BEHAVIOR=generate
printf "vendor = false\nthird_party_dir = '../../vendor/cargo'\n" >"$WORKSPACE/reindeer.toml"
"$GATE" generate "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN"
"$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN"

# Git sources: pinned by a fetched GitHub commit tarball digest in git-archives.json.
github_archive="$TEMP_ROOT/github/owner/demo/archive/0123456789abcdef0123456789abcdef01234567.tar.gz"
mkdir -p "$(dirname "$github_archive")" "$TEMP_ROOT/tree/demo-0123456789abcdef0123456789abcdef01234567/src"
printf 'pub fn demo() {}\n' >"$TEMP_ROOT/tree/demo-0123456789abcdef0123456789abcdef01234567/src/lib.rs"
tar -C "$TEMP_ROOT/tree" -czf "$github_archive" demo-0123456789abcdef0123456789abcdef01234567
export BUCK2_RUST_DEPS_GITHUB_ORIGIN="file://$TEMP_ROOT/github"
export FAKE_REINDEER_BEHAVIOR=git-archive
"$GATE" generate "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN"
git_archives="$THIRD_PARTY/git-archives.json"
expected_digest="$(sha256sum "$github_archive" | cut -d' ' -f1)"
grep -Fq "\"sha256\": \"$expected_digest\"" "$git_archives" || fail "generate did not pin the fetched tarball digest"
grep -Fq '"strip_prefix": "demo-0123456789abcdef0123456789abcdef01234567"' "$git_archives" || fail "generate did not record the tarball prefix"
grep -Fq '"url": "https://github.com/owner/demo/archive/0123456789abcdef0123456789abcdef01234567.tar.gz"' "$git_archives" || fail "generate did not record the canonical archive url"
"$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN"

printf 'pub fn drifted() {}\n' >"$TEMP_ROOT/tree/demo-0123456789abcdef0123456789abcdef01234567/src/lib.rs"
tar -C "$TEMP_ROOT/tree" -czf "$github_archive" demo-0123456789abcdef0123456789abcdef01234567
if "$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN" 2>"$TEMP_ROOT/git-drift-error"; then
  fail "gate accepted a git archive whose fetched digest drifted from its pin"
fi
grep -Fq 'no longer matches its pinned sha256' "$TEMP_ROOT/git-drift-error" || fail "git archive drift was not diagnosed"
grep -Fq 'delete this pin from' "$TEMP_ROOT/git-drift-error" || fail "git archive drift error does not name the remedy"

export FAKE_REINDEER_BEHAVIOR=git-fetch
if "$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN" 2>"$TEMP_ROOT/git-fetch-error"; then
  fail "gate accepted an unpinned git_fetch"
fi
grep -Fq 'git_fetch = "git_archive"' "$TEMP_ROOT/git-fetch-error" || fail "unpinned git_fetch was not diagnosed"

cp "$git_archives" "$TEMP_ROOT/git-archives.json"
export FAKE_REINDEER_BEHAVIOR=generate
"$GATE" generate "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN"
[ ! -e "$git_archives" ] || fail "generate kept git pins for a graph without git sources"
cp "$TEMP_ROOT/git-archives.json" "$git_archives"
if "$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN" 2>"$TEMP_ROOT/git-stale-error"; then
  fail "gate accepted git pins for a graph without git sources"
fi
grep -Fq 'pins git sources the graph no longer has' "$TEMP_ROOT/git-stale-error" || fail "stale git pins were not diagnosed"
rm "$git_archives"

# Both workspace locks are real; the consumer's Cargo graph reaches the provider
# through a path dependency, while each workspace owns a registry archive.
for workspace in a b; do
  fixture_workspace="scripts/fixtures/rust-foreign/$workspace"
  "$GATE" check "$ROOT" "$fixture_workspace" "$fixture_workspace/third-party/BUCK" \
    "$(command -v reindeer)" "$(command -v cargo)" "$(command -v rustc)" "$BUN"
done

fixture_a_graph="$ROOT/scripts/fixtures/rust-foreign/a/third-party/BUCK"
fixture_b_graph="$ROOT/scripts/fixtures/rust-foreign/b/third-party/BUCK"
if grep -Fq 'foreign-shared' "$fixture_a_graph"; then
  fail "consumer Reindeer graph includes a first-party foreign package"
fi
grep -Fq 'name = "memchr"' "$fixture_a_graph" || fail "consumer registry dependency missing"
grep -Fq 'name = "itoa"' "$fixture_b_graph" || fail "provider registry dependency missing"

echo "Buck2 Rust dependency gate tests passed."
