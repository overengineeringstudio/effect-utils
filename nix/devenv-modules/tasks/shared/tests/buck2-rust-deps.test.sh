#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
GATE=gate
gate() {
  local -a args=("$@")
  if [ "${args[5]}" = /fake/cargo ]; then args[5]="$FAKE_CARGO"; fi
  "$ROOT/scripts/buck2-rust-deps.sh" "${args[@]}" "$ROOT/scripts/buck2-rust-supply-manifest.ts" "${TEST_GIT_SOURCES:-}"
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
FAKE_CARGO="$TEMP_ROOT/cargo"
BUN="${BUN_BIN:-$(command -v bun || true)}"
[ -n "$BUN" ] || { echo "FAIL: bun is required (set BUN_BIN)" >&2; exit 1; }

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

mkdir -p "$WORKSPACE" "$THIRD_PARTY/fixups/example"
printf 'vendor = false\ncargo_env = true\nthird_party_dir = "../../vendor/cargo"\n' >"$WORKSPACE/reindeer.toml"
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
cat >"$FAKE_CARGO" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' '{"packages":[],"workspace_members":[],"resolve":{"root":null,"nodes":[]}}'
FAKE
chmod +x "$FAKE_CARGO"

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
printf 'cargo_env = ["CARGO_PKG_VERSION_PATCH"]\n' >"$THIRD_PARTY/fixups/example/fixups.toml"
: >"$FAKE_REINDEER_CALL_LOG"
if "$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN" 2>"$TEMP_ROOT/fixup-cargo-env-error"; then
  fail "gate accepted a per-crate Cargo environment override"
fi
grep -Fq 'per-crate cargo_env overrides the full root-level Cargo package environment' "$TEMP_ROOT/fixup-cargo-env-error" || fail "per-crate override was not diagnosed"
[ ! -s "$FAKE_REINDEER_CALL_LOG" ] || fail "per-crate override ran Reindeer before rejecting the fixup"

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
printf 'vendor = false\ncargo_env = true\nthird_party_dir = "../../decoy"\n' >"$WORKSPACE/reindeer.toml"
if "$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN" 2>"$TEMP_ROOT/graph-mismatch-error"; then
  fail "gate accepted a BUCK path that disagrees with reindeer.toml"
fi
grep -Fq 'third-party BUCK disagrees' "$TEMP_ROOT/graph-mismatch-error" || fail "third-party graph mismatch was not diagnosed"

# A matching key inside a non-root table must not mask the root setting Reindeer uses.
printf 'vendor = false\ncargo_env = true\nthird_party_dir = "../../decoy"\n\n[buck]\nthird_party_dir = "../../vendor/cargo"\n' >"$WORKSPACE/reindeer.toml"
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

# Missing or nested cargo_env must not silently omit Cargo package metadata.
printf 'vendor = false\nthird_party_dir = "../../vendor/cargo"\n' >"$WORKSPACE/reindeer.toml"
if "$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN" 2>"$TEMP_ROOT/cargo-env-error"; then
  fail "gate accepted missing cargo_env"
fi
grep -Fq 'cargo_env must be the root-level boolean true' "$TEMP_ROOT/cargo-env-error" || fail "missing cargo_env was not diagnosed"
printf 'vendor = false\nthird_party_dir = "../../vendor/cargo"\n\n[buck]\ncargo_env = true\n' >"$WORKSPACE/reindeer.toml"
if "$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN" 2>"$TEMP_ROOT/cargo-env-nested-error"; then
  fail "gate accepted nested cargo_env"
fi
grep -Fq 'cargo_env must be the root-level boolean true' "$TEMP_ROOT/cargo-env-nested-error" || fail "nested cargo_env was not diagnosed"

# TOML literal strings are valid Reindeer input.
printf 'buildscript.run = true\n' >"$THIRD_PARTY/fixups/example/fixups.toml"
printf 'authoritative lock bytes\n' >"$WORKSPACE/Cargo.lock"
export FAKE_REINDEER_BEHAVIOR=generate
printf "vendor = false\ncargo_env = true\nthird_party_dir = '../../vendor/cargo'\n" >"$WORKSPACE/reindeer.toml"
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

# A declared Nix source pins locally produced bytes without fetching GitHub.
source_archive="$TEMP_ROOT/local-source.tgz"
cp "$github_archive" "$source_archive"
source_config="$TEMP_ROOT/git-sources.json"
printf '{"owner/demo":{"rev":"0123456789abcdef0123456789abcdef01234567","archive":"%s"}}\n' "$source_archive" > "$source_config"
rm "$git_archives"
export TEST_GIT_SOURCES="$source_config"
export BUCK2_RUST_DEPS_GITHUB_ORIGIN="file://$TEMP_ROOT/no-github"
"$GATE" generate "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN"
grep -Fq '"source": "nix"' "$git_archives" || fail "declared source did not select the Nix archive pin"
source_digest="$(sha256sum "$source_archive" | cut -d' ' -f1)"
grep -Fq "\"sha256\": \"$source_digest\"" "$git_archives" || fail "declared source digest was not pinned"
"$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN"
unset TEST_GIT_SOURCES
if "$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN" 2>"$TEMP_ROOT/missing-source-error"; then
  fail "gate accepted a Nix source pin with no declared override"
fi
grep -Fq 'no declared gitSources input' "$TEMP_ROOT/missing-source-error" || fail "missing private source override was not diagnosed"
export TEST_GIT_SOURCES="$source_config"
printf '{"owner/demo":{"rev":"ffffffffffffffffffffffffffffffffffffffff","archive":"%s"}}\n' "$source_archive" > "$source_config"
if "$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN" 2>"$TEMP_ROOT/source-rev-error"; then
  fail "gate accepted a Nix source at another commit"
fi
grep -Fq 'must match Cargo.lock rev' "$TEMP_ROOT/source-rev-error" || fail "source rev mismatch was not diagnosed"
printf '{"owner/demo":{"rev":"0123456789abcdef0123456789abcdef01234567","archive":"%s"}}\n' "$source_archive" > "$source_config"
printf 'pub fn changed_again() {}\n' > "$TEMP_ROOT/tree/demo-0123456789abcdef0123456789abcdef01234567/src/lib.rs"
tar -C "$TEMP_ROOT/tree" -czf "$source_archive" demo-0123456789abcdef0123456789abcdef01234567
if "$GATE" check "$FIXTURE" "$WORKSPACE_ROOT" "$THIRD_PARTY_BUCK_PATH" "$FAKE_REINDEER" /fake/cargo /fake/rustc "$BUN" 2>"$TEMP_ROOT/source-drift-error"; then
  fail "gate accepted source archive drift at the pinned rev"
fi
grep -Fq 'no longer matches its pinned Nix source sha256' "$TEMP_ROOT/source-drift-error" || fail "source archive drift was not diagnosed"
unset TEST_GIT_SOURCES

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
grep -Fq 'name = "renamed_itoa"' "$fixture_a_graph" || fail "root dependency rename missing"
grep -Fq 'name = "itoa"' "$fixture_b_graph" || fail "provider registry dependency missing"
grep -Fq 'name = "unicode-width"' "$fixture_a_graph" ||
  fail "hyphenated foreign registry dependency lost its package-named alias"
if grep -Fq 'name = "unicode_width"' "$fixture_a_graph"; then
  fail "Cargo extern crate spelling incorrectly became the public package alias"
fi
grep -Fq 'name = "unicode-width"' "$fixture_b_graph" ||
  fail "provider hyphenated registry dependency missing"
REPO_ROOT="$ROOT" "$BUN" -e '
  const root = process.env.REPO_ROOT
  const lock = Bun.TOML.parse(await Bun.file(`${root}/scripts/fixtures/rust-foreign/a/Cargo.lock`).text())
  const itoa = lock.package.find((entry) => entry.name === "itoa")
  const graph = await Bun.file(`${root}/scripts/fixtures/rust-foreign/a/third-party/BUCK`).text()
  if (!itoa?.checksum || !graph.includes(`sha256 = "${itoa.checksum}"`)) {
    console.error("foreign registry archive is not pinned to the authoritative Cargo.lock")
    process.exit(1)
  }
  const yanked = lock.package.find((entry) => entry.name === "yoke-derive")
  if (
    yanked?.version !== "0.8.3" ||
    !yanked.checksum ||
    !graph.includes(`name = "yoke-derive"`) ||
    !graph.includes(`sha256 = "${yanked.checksum}"`)
  ) {
    console.error("foreign supply dropped the locked yanked yoke-derive release")
    process.exit(1)
  }
  // pulp 0.22.3 is a registry crate whose build.rs unwraps all three parts.
  // Reindeer must set them for compilation and execution without a per-crate env fixup.
  for (const [rule, name] of [["rust_binary", "pulp-0.22-build-script-build"], ["buildscript_run", "pulp-0.22-build-script-run"]]) {
    const blocks = [...graph.matchAll(new RegExp(`^${rule}\\(\\n([\\s\\S]*?)^\\)`, "gm"))]
    const block = blocks.find(([, body]) => body.includes(`name = "${name}",`))?.[0]
    if (!block) throw new Error(`missing ${name}`)
    for (const [part, value] of [["MAJOR", "0"], ["MINOR", "22"], ["PATCH", "3"]]) {
      if (!block.includes(`"CARGO_PKG_VERSION_${part}": "${value}"`)) {
        throw new Error(`${name} lacks package version ${part}`)
      }
    }
  }
'

foreign_repo="$TEMP_ROOT/foreign-repository"
mkdir -p "$foreign_repo/scripts/fixtures"
cp "$ROOT/.buckconfig" "$ROOT/.buckroot" "$ROOT/.watchmanconfig" "$foreign_repo/"
cp -R "$ROOT/scripts/fixtures/rust-foreign" "$foreign_repo/scripts/fixtures/"
foreign_workspace="scripts/fixtures/rust-foreign/a"
foreign_graph="$foreign_workspace/third-party/BUCK"
real_reindeer="$(command -v reindeer)"
real_cargo="$(command -v cargo)"
real_rustc="$(command -v rustc)"
rm "$foreign_repo/$foreign_workspace/foreign-packages.json"
if "$GATE" generate "$foreign_repo" "$foreign_workspace" "$foreign_graph" \
  "$real_reindeer" "$real_cargo" "$real_rustc" "$BUN" 2>"$TEMP_ROOT/undeclared-error"; then
  fail "gate accepted an undeclared external Cargo path package"
fi
grep -Fq 'undeclared external Cargo path dependencies' "$TEMP_ROOT/undeclared-error" ||
  fail "undeclared external Cargo package was not diagnosed"

cp "$ROOT/$foreign_workspace/foreign-packages.json" \
  "$foreign_repo/$foreign_workspace/foreign-packages.json"
cat >"$foreign_repo/$foreign_workspace/app/Cargo.toml" <<'TOML'
[package]
name = "foreign-consumer"
version.workspace = true
edition.workspace = true
workspace = ".."

[dependencies]
foreign-shared = { path = "../../b/crates/shared" }
renamed_memchr = { package = "memchr", version = "2.7.5" }
renamed_itoa = { package = "itoa", version = "1.0.15" }
old_toml_datetime = { package = "toml_datetime", version = "0.6.11" }
TOML
"$GATE" generate "$foreign_repo" "$foreign_workspace" "$foreign_graph" \
  "$real_reindeer" "$real_cargo" "$real_rustc" "$BUN"
FOREIGN_REPO="$foreign_repo" "$BUN" -e '
  const root = process.env.FOREIGN_REPO;
  const workspace = "scripts/fixtures/rust-foreign/a";
  const resolutionPath = `${root}/${workspace}/third-party/cargo-resolution.json`;
  const resolution = await Bun.file(resolutionPath).json();
  const edge = resolution.dependencies.find((entry) =>
    entry.manifestPath === `${workspace}/app/Cargo.toml` &&
    entry.name === "renamed_memchr" && entry.kind === "normal");
  const lock = Bun.TOML.parse(await Bun.file(`${root}/${workspace}/Cargo.lock`).text());
  const pinned = lock.package.find((entry) => entry.name === "memchr");
  const graph = await Bun.file(`${root}/${workspace}/third-party/BUCK`).text();
  if (!edge || edge.package !== "memchr" || edge.version !== pinned?.version ||
      !graph.includes(`name = "${edge.alias}"`) ||
      !graph.includes(`sha256 = "${pinned.checksum}"`)) {
    throw new Error("member renamed dependency lost its exact locked registry resolution");
  }
  edge.version = "0.0.0";
  await Bun.write(resolutionPath, `${JSON.stringify(resolution, null, 2)}\n`);
'
if "$GATE" check "$foreign_repo" "$foreign_workspace" "$foreign_graph" \
  "$real_reindeer" "$real_cargo" "$real_rustc" "$BUN" 2>"$TEMP_ROOT/resolution-stale-error"; then
  fail "gate accepted stale Cargo edge resolution"
fi
grep -Fq 'cargo-resolution.json is stale' "$TEMP_ROOT/resolution-stale-error" ||
  fail "stale Cargo edge resolution was not diagnosed"
"$GATE" generate "$foreign_repo" "$foreign_workspace" "$foreign_graph" \
  "$real_reindeer" "$real_cargo" "$real_rustc" "$BUN"
"$GATE" check "$foreign_repo" "$foreign_workspace" "$foreign_graph" \
  "$real_reindeer" "$real_cargo" "$real_rustc" "$BUN"

echo "Buck2 Rust dependency gate tests passed."
