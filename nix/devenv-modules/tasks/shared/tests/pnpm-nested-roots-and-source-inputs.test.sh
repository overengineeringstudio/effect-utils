#!/usr/bin/env bash
set -euo pipefail

# Two pnpm-12 behaviors this repository depends on, pinned as contracts against
# the repository's own pnpm (nix/pnpm.nix) and the shared helpers that encode
# them. Both were silent under pnpm 11 and both are load-bearing for composed
# workspaces, so each is proven here against real pnpm rather than asserted.
#
#   1. WORKSPACE BOUNDARY. pnpm discovers the workspace by walking UP from the
#      install root. A nested install root without its own pnpm-workspace.yaml
#      is adopted by the nearest ancestor workspace: the ancestor's lockfile is
#      written instead of the nested one and the nested dependency graph is
#      resolved against the wrong root, after which a frozen install fails with
#      ERR_PNPM_NO_LOCKFILE. `--ignore-workspace` does NOT prevent this.
#      Covered: the raw behavior (so the test fails if pnpm ever changes it),
#      and pnpmInstallPolicy.nestedWorkspaceBoundaryShell in both modes.
#   2. SOURCE-INPUT SPECIFIER RELATIVITY. pnpm resolves a `file:` specifier
#      relative to the manifest that declares it and records that
#      importer-relative form in the lockfile. A root-relative staged-source
#      specifier is therefore only correct for the root importer; for a nested
#      importer it does not resolve, and it disagrees with the lockfile so a
#      frozen install rejects the pair. Covered: the resolution/normalization
#      algebra in pnpm-source-input-specifiers.cjs, plus a real install +
#      frozen install at importer depths 0/1/2.

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
SPECIFIERS_CJS="$ROOT/nix/workspace-tools/lib/pnpm-source-input-specifiers.cjs"
STAGE=".devenv/pnpm-source-inputs/current"

_pass=0
_fail=0
fail() {
  echo "FAIL: $1" >&2
  _fail=$((_fail + 1))
}
ok() {
  _pass=$((_pass + 1))
}

tmpdir="$(mktemp -d)"
trap 'chmod -R u+w "$tmpdir" 2>/dev/null || true; rm -rf "$tmpdir"' EXIT

echo "Running pnpm-nested-roots-and-source-inputs test..."

# --- the repository's own pnpm and node, built from the pin ---
nix build --impure --no-link --print-out-paths --expr "
  let
    flake = builtins.getFlake \"$NIX_FLAKE_REF\";
    pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
  in pkgs.symlinkJoin {
    name = \"pnpm-regression-test-tools\";
    paths = [ (import $ROOT/nix/pnpm.nix { inherit pkgs; }) pkgs.nodejs ];
  }
" > "$tmpdir/tools-path" || {
  echo "FAIL: nix build of the pinned pnpm + node" >&2
  exit 1
}
TOOLS="$(cat "$tmpdir/tools-path")/bin"
PNPM="$TOOLS/pnpm"
NODE="$TOOLS/node"
[ -x "$PNPM" ] || { echo "FAIL: pinned pnpm not built" >&2; exit 1; }
pnpm_version="$("$PNPM" --version)"
echo "pinned pnpm: $pnpm_version"

pnpm_run() {
  # cwd is the install root under test; keep every side effect inside $tmpdir.
  local cwd="$1" store="$2"
  shift 2
  (
    cd "$cwd" && env -i PATH="$TOOLS:/usr/bin:/bin" HOME="$store/home" CI=1 \
      "$PNPM" "$@" --ignore-scripts --store-dir "$store/store" \
      --config.enable-global-virtual-store=false \
      --config.virtual-store-dir=node_modules/.pnpm \
      --reporter=silent
  ) >/dev/null 2>"$store/last-stderr" || return $?
}

# ===========================================================================
# 1. WORKSPACE BOUNDARY
# ===========================================================================

# parent workspace that would happily adopt a nested root
make_parent_workspace() {
  local root="$1"
  mkdir -p "$root/$STAGE/repos/foreign/packages/shared" "$root/nested/vendor/shared"
  printf 'packages:\n  - nested\n\noverrides:\n  %s: %s\n' \
    "'@acme/shared'" "'file:$STAGE/repos/foreign/packages/shared'" > "$root/pnpm-workspace.yaml"
  printf '{"name":"parent-root","private":true,"version":"0.0.0"}\n' > "$root/package.json"
  printf '{"name":"@acme/shared","version":"9.9.9"}\n' \
    > "$root/$STAGE/repos/foreign/packages/shared/package.json"
  # the nested root vendors its OWN copy of the same dependency name
  printf '{"name":"@acme/app","version":"0.0.0","dependencies":{"@acme/shared":"file:vendor/shared"}}\n' \
    > "$root/nested/package.json"
  printf '{"name":"@acme/shared","version":"1.0.0"}\n' > "$root/nested/vendor/shared/package.json"
}

# (1a) RAW BEHAVIOR: without its own boundary the nested root is hijacked.
raw="$tmpdir/raw"
mkdir -p "$raw/home"
make_parent_workspace "$raw"
pnpm_run "$raw/nested" "$raw" install --ignore-workspace --no-frozen-lockfile || true
if [ ! -f "$raw/nested/pnpm-lock.yaml" ] && [ -f "$raw/pnpm-lock.yaml" ]; then
  ok
else
  fail "pnpm $pnpm_version no longer hijacks a boundary-less nested root; this test's premise (and the shared boundary helper) needs revisiting"
fi

# (1b) WITH the boundary the nested root owns its install.
scoped="$tmpdir/scoped"
mkdir -p "$scoped/home"
make_parent_workspace "$scoped"
printf 'packages:\n  - .\n' > "$scoped/nested/pnpm-workspace.yaml"
pnpm_run "$scoped/nested" "$scoped" install --no-frozen-lockfile \
  || fail "boundary-scoped nested install failed: $(cat "$scoped/last-stderr")"
[ -f "$scoped/nested/pnpm-lock.yaml" ] \
  && ok || fail "boundary-scoped nested install must write the NESTED lockfile"
[ ! -f "$scoped/pnpm-lock.yaml" ] \
  && ok || fail "boundary-scoped nested install must not write the ancestor lockfile"
resolved_version="$("$NODE" -e 'process.stdout.write(require(process.argv[1]).version)' \
  "$scoped/nested/node_modules/@acme/shared/package.json" 2>/dev/null || echo missing)"
[ "$resolved_version" = "1.0.0" ] \
  && ok || fail "nested root must resolve its own vendored dependency, got '$resolved_version'"
pnpm_run "$scoped/nested" "$scoped" install --frozen-lockfile \
  && ok || fail "frozen install must succeed in a boundary-scoped nested root: $(cat "$scoped/last-stderr")"

# (1c) The shared helper is what encodes this: assert mode fails closed, and
#      ephemeral mode declares the boundary only for the install. Both are
#      evaluated from the real policy file and executed.
policy_shell() {
  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      policy = import $ROOT/nix/workspace-tools/lib/pnpm-install-policy.nix { lib = pkgs.lib; };
    in policy.nestedWorkspaceBoundaryShell { rootRelPath = \"repos/example\"; ephemeral = $1; }
  "
}
assert_shell="$(policy_shell false)" || fail "nestedWorkspaceBoundaryShell assert mode failed to evaluate"
ephemeral_shell="$(policy_shell true)" || fail "nestedWorkspaceBoundaryShell ephemeral mode failed to evaluate"

guard_dir="$tmpdir/guard"
mkdir -p "$guard_dir"
if (cd "$guard_dir" && ${BASH_BIN:-bash} -c "set -euo pipefail; $assert_shell") 2>"$tmpdir/guard-err"; then
  fail "assert mode must fail closed when pnpm-workspace.yaml is absent"
else
  ok
fi
grep -q "not a workspace boundary" "$tmpdir/guard-err" \
  && ok || fail "assert mode must explain the missing boundary, got: $(cat "$tmpdir/guard-err")"
printf 'packages:\n  - .\n' > "$guard_dir/pnpm-workspace.yaml"
(cd "$guard_dir" && ${BASH_BIN:-bash} -c "set -euo pipefail; $assert_shell") 2>/dev/null \
  && ok || fail "assert mode must pass once the boundary exists"

# Ephemeral mode must make the boundary visible to the install it wraps and
# leave nothing behind, or the prepared tree's fixed-output hash would move.
ephemeral_dir="$tmpdir/ephemeral"
mkdir -p "$ephemeral_dir"
(cd "$ephemeral_dir" && ${BASH_BIN:-bash} -c "set -euo pipefail; $ephemeral_shell; cat pnpm-workspace.yaml > boundary-seen.txt") 2>/dev/null \
  && ok || fail "ephemeral mode must declare a boundary the wrapped install can see"
grep -qxF 'packages:' "$ephemeral_dir/boundary-seen.txt" \
  && ok || fail "ephemeral boundary must be a valid workspace file, got: $(cat "$ephemeral_dir/boundary-seen.txt" 2>/dev/null)"
[ ! -f "$ephemeral_dir/pnpm-workspace.yaml" ] \
  && ok || fail "ephemeral mode must remove the boundary it created"

# An existing boundary is never touched, and never removed.
keep_dir="$tmpdir/ephemeral-keep"
mkdir -p "$keep_dir"
printf 'packages:\n  - members/*\n' > "$keep_dir/pnpm-workspace.yaml"
(cd "$keep_dir" && ${BASH_BIN:-bash} -c "set -euo pipefail; $ephemeral_shell") 2>/dev/null
grep -qxF '  - members/*' "$keep_dir/pnpm-workspace.yaml" \
  && ok || fail "ephemeral mode must never overwrite or remove an existing boundary file"

# ===========================================================================
# 2. SOURCE-INPUT SPECIFIER RELATIVITY
# ===========================================================================

# (2a) The algebra, exercised directly against the shared module.
cat > "$tmpdir/specifiers.test.cjs" <<'PROBE'
const assert = require('node:assert')
const mod = require(process.argv[2])
const source = 'repos/foreign/packages/shared'
const stage = mod.SOURCE_INPUT_STAGE_PATH
assert.strictEqual(stage, '.devenv/pnpm-source-inputs/current')

// the specifier each importer depth must declare
assert.strictEqual(mod.sourceInputSpecifierFor({ importerPath: '.', sourcePath: source }), `file:${stage}/${source}`)
assert.strictEqual(mod.sourceInputSpecifierFor({ importerPath: 'app', sourcePath: source }), `file:../${stage}/${source}`)
assert.strictEqual(
  mod.sourceInputSpecifierFor({ importerPath: 'packages/app', sourcePath: source }),
  `file:../../${stage}/${source}`,
)

// classification is spelling-independent: both forms of the same dependency match
assert.strictEqual(mod.isSourceInputSpecifier({ importerPath: 'packages/app', specifier: `file:../../${stage}/${source}` }), true)
assert.strictEqual(mod.isSourceInputSpecifier({ importerPath: '.', specifier: `file:${stage}/${source}` }), true)
// a root-relative spelling declared by a nested importer does NOT target the stage
assert.strictEqual(mod.isSourceInputSpecifier({ importerPath: 'packages/app', specifier: `file:${stage}/${source}` }), false)
// unrelated specifiers are never claimed
assert.strictEqual(mod.isSourceInputSpecifier({ importerPath: 'packages/app', specifier: 'workspace:^' }), false)
assert.strictEqual(mod.isSourceInputSpecifier({ importerPath: 'packages/app', specifier: 'file:vendor/shared' }), false)

// re-spelling is idempotent and depth-correct; non-source-inputs pass through
const nested = { importerPath: 'packages/app', specifier: `file:../../${stage}/${source}` }
assert.strictEqual(mod.relativizeSourceInputSpecifier(nested), `file:../../${stage}/${source}`)
assert.strictEqual(
  mod.relativizeSourceInputSpecifier({ importerPath: 'app', specifier: `file:../${stage}/${source}` }),
  `file:../${stage}/${source}`,
)
assert.strictEqual(mod.relativizeSourceInputSpecifier({ importerPath: 'packages/app', specifier: 'workspace:^' }), 'workspace:^')

// resolution maps an importer-relative specifier back to its root-relative target
assert.strictEqual(mod.resolveFileSpecifier(nested), `${stage}/${source}`)
assert.strictEqual(mod.resolveFileSpecifier({ importerPath: 'app', specifier: 'file:vendor/shared' }), 'app/vendor/shared')
assert.strictEqual(mod.resolveFileSpecifier({ importerPath: '.', specifier: 'workspace:^' }), null)

// the projection strip is spelling-agnostic and importer-independent: the root
// override and a nested importer's recorded specifier both belong to it
assert.strictEqual(mod.targetsSourceInputStage(`file:${stage}/${source}`), true)
assert.strictEqual(mod.targetsSourceInputStage(`file:../${stage}/${source}`), true)
assert.strictEqual(mod.targetsSourceInputStage(`file:../../${stage}/${source}`), true)
assert.strictEqual(mod.targetsSourceInputStage('file:vendor/shared'), false)
assert.strictEqual(mod.targetsSourceInputStage('file:../../packages/other'), false)
assert.strictEqual(mod.targetsSourceInputStage('workspace:^'), false)
assert.strictEqual(mod.targetsSourceInputStage('^1.0.0'), false)
console.log('ok')
PROBE
if "$NODE" "$tmpdir/specifiers.test.cjs" "$SPECIFIERS_CJS" >/dev/null 2>"$tmpdir/specifiers-err"; then
  ok
else
  fail "pnpm-source-input-specifiers.cjs contract: $(cat "$tmpdir/specifiers-err")"
fi

# (2b) REAL INSTALLS at importer depth 0/1/2 using the module's own answer for
#      the specifier. Each must install and then pass a frozen install, and the
#      lockfile specifier must equal what the module said to declare.
for importer in "." "app" "packages/app"; do
  case "$importer" in
    .) label="root" ;;
    *) label="$(printf '%s' "$importer" | tr '/' '-')" ;;
  esac
  wsroot="$tmpdir/depth-$label"
  mkdir -p "$wsroot/home" "$wsroot/$STAGE/repos/foreign/packages/shared"
  printf '{"name":"@acme/shared","version":"9.9.9","main":"index.js"}\n' \
    > "$wsroot/$STAGE/repos/foreign/packages/shared/package.json"
  printf 'module.exports = "staged"\n' > "$wsroot/$STAGE/repos/foreign/packages/shared/index.js"

  specifier="$("$NODE" -e '
    const mod = require(process.argv[1])
    process.stdout.write(mod.sourceInputSpecifierFor({ importerPath: process.argv[2], sourcePath: "repos/foreign/packages/shared" }))
  ' "$SPECIFIERS_CJS" "$importer")"

  if [ "$importer" = "." ]; then
    printf 'packages:\n  - .\n' > "$wsroot/pnpm-workspace.yaml"
    printf '{"name":"@acme/app","private":true,"version":"0.0.0","dependencies":{"@acme/shared":"%s"}}\n' \
      "$specifier" > "$wsroot/package.json"
    member_dir="$wsroot"
  else
    mkdir -p "$wsroot/$importer"
    printf 'packages:\n  - %s\n' "$importer" > "$wsroot/pnpm-workspace.yaml"
    printf '{"name":"parent-root","private":true,"version":"0.0.0"}\n' > "$wsroot/package.json"
    printf '{"name":"@acme/app","version":"0.0.0","dependencies":{"@acme/shared":"%s"}}\n' \
      "$specifier" > "$wsroot/$importer/package.json"
    member_dir="$wsroot/$importer"
  fi

  pnpm_run "$wsroot" "$wsroot" install --no-frozen-lockfile \
    || fail "depth '$importer': install with specifier '$specifier' failed: $(cat "$wsroot/last-stderr")"
  linked="$("$NODE" -e 'process.stdout.write(require(process.argv[1]).version)' \
    "$member_dir/node_modules/@acme/shared/package.json" 2>/dev/null || echo missing)"
  [ "$linked" = "9.9.9" ] \
    && ok || fail "depth '$importer': must resolve the staged source input, got '$linked'"
  recorded="$(grep -m1 'specifier:' "$wsroot/pnpm-lock.yaml" | sed 's/.*specifier: *//')"
  [ "$recorded" = "$specifier" ] \
    && ok || fail "depth '$importer': lockfile specifier '$recorded' must equal the declared '$specifier'"
  pnpm_run "$wsroot" "$wsroot" install --frozen-lockfile \
    && ok || fail "depth '$importer': frozen install must accept the declared specifier: $(cat "$wsroot/last-stderr")"
done

# (2c) The regression itself: a NESTED importer declaring the root-relative
#      spelling must not silently resolve. This is the shape that produced a
#      frozen-install rejection, so it stays pinned.
badroot="$tmpdir/rootrel-nested"
mkdir -p "$badroot/home" "$badroot/packages/app" "$badroot/$STAGE/repos/foreign/packages/shared"
printf '{"name":"@acme/shared","version":"9.9.9"}\n' \
  > "$badroot/$STAGE/repos/foreign/packages/shared/package.json"
printf 'packages:\n  - packages/app\n' > "$badroot/pnpm-workspace.yaml"
printf '{"name":"parent-root","private":true,"version":"0.0.0"}\n' > "$badroot/package.json"
printf '{"name":"@acme/app","version":"0.0.0","dependencies":{"@acme/shared":"file:%s/repos/foreign/packages/shared"}}\n' \
  "$STAGE" > "$badroot/packages/app/package.json"
if pnpm_run "$badroot" "$badroot" install --no-frozen-lockfile; then
  fail "a nested importer's root-relative staged specifier must not resolve (pnpm changed; revisit the relativization contract)"
else
  ok
fi

echo ""
echo "$_pass passed, $_fail failed"
[ "$_fail" -eq 0 ] && echo "pnpm-nested-roots-and-source-inputs test passed"
[ "$_fail" -eq 0 ]
