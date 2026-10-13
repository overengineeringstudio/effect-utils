#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
buck="${BUCK2_BIN:?Run in the repository devenv shell to use its pinned BUCK2_BIN}"
native_shell="${BASH_BIN:-$BASH}"
native_coreutils="${CP_BIN:?Pinned CP_BIN is required for the native TS launcher fixture}"
native_coreutils="${native_coreutils%/cp}/coreutils"
case "$native_shell:$native_coreutils" in
  /nix/store/*:/nix/store/*) ;;
  *) printf 'Native TS launcher fixture requires Nix-pinned Bash and coreutils\n' >&2; exit 1 ;;
esac
scratch_parent="${RUNNER_TEMP:-$repo_root/tmp}"
mkdir -p "$scratch_parent"
work="$(mktemp -d "$scratch_parent/buck2-cache-admission.XXXXXXXX")"
cleanup() {
  (cd "$work" && "$buck" --isolation-dir cache-admission-check kill >/dev/null 2>&1) || true
  (cd "$work" && "$buck" --isolation-dir cache-admission-unverified-outer kill >/dev/null 2>&1) || true
  (cd "$work" && HOME="$work/forged-home" NIX_BUILD_TOP="$work" \
    "$buck" --isolation-dir cache-admission-forged-outer kill >/dev/null 2>&1) || true
  rm -rf "$work"
}
trap cleanup EXIT

# Exercise the shipped rule implementations, not a parallel guard or a source
# inspection. Only their dependency providers are fixtures: audit providers
# performs real analysis without running Bun or materializing a package tree.
# One Darwin-branch launcher fixture additionally executes pinned host tools to
# prove that a fresh declared directory exists before a nested verdict is written.
cp -R "$repo_root/buck2" "$work/buck2"
mkdir -p "$work/capabilities" "$work/packages/@overeng/buck2-tools"
touch "$work/.buckroot"
printf 'CAPABILITIES = {}\nGENERATION = "analysis-only"\n' > "$work/capabilities/defs.bzl"
printf 'analysis-only dependency\n' > "$work/fixture-dependency.txt"
cat > "$work/.buckconfig" <<'CONFIG'
[cells]
  effect_utils = .
  capabilities = capabilities
  prelude = prelude
[cell_aliases]
  rules = effect_utils
  toolchains = effect_utils
  config = prelude
  ovr_config = prelude
  fbsource = prelude
[external_cells]
  prelude = bundled
[parser]
  target_platform_detector_spec = target:effect_utils//...->effect_utils//buck2/platforms:host_platform
[build]
  execution_platforms = effect_utils//buck2/platforms:host_execution_platform
[buck2]
  file_watcher = notify
  remote_cache_enabled = false
  allow_cache_uploads = false
CONFIG
printf '\n[fixture]\n  shell = %s\n  coreutils = %s\n' \
  "$native_shell" "$native_coreutils" >> "$work/.buckconfig"
# The bundled prelude is supplied by the same pinned Buck binary as the repo's
# normal .buckconfig. No ambient prelude checkout or remote cache is consulted.
cat > "$work/fixture.bzl" <<'BZL'
load("//buck2/materialization.bzl", "PackageTreeInfo")
load("//buck2/materialization.bzl", "empty_package_view", "package_tree", "package_view")
load("//buck2/dependencies:defs.bzl", "PnpmDeclaredClosureInfo", "pnpm_package", "pnpm_store_entry", "pnpm_store_scc", "pnpm_store_view")
load("//buck2/javascript.bzl", "vitest_collect", "vitest_test")
load("//buck2/package_tools.bzl", "PackageCommandRuntimeInfo", "package_bin_check")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("//buck2/toolchains:defs.bzl", "BunToolchainInfo", "EffectTsgoToolchainInfo")
load("//buck2/rust:interop.bzl", "RustInteropProductInfo", "rust_interop_smoke")
load("//buck2/toolchains:ts_sandbox.bzl", "TsSandboxToolchainInfo")
load("//buck2/hermetic.bzl", "ts_action", "ts_action_attrs")
load("//buck2/platforms:defs.bzl", "cache_guarded_rule", "ts_action_admission_status", "ts_action_cache_eligible", "ts_action_execution_constraints", "ts_action_policy_attrs")

FixtureTsPolicyInfo = provider(fields = {"admission_status": str, "cache_eligible": bool})

def _fixture_ts_policy_impl(ctx):
    return [
        DefaultInfo(),
        FixtureTsPolicyInfo(
            admission_status = ts_action_admission_status(ctx),
            cache_eligible = ts_action_cache_eligible(ctx),
        ),
    ]

fixture_ts_policy = cache_guarded_rule(
    impl = _fixture_ts_policy_impl,
    attrs = ts_action_policy_attrs(),
    cache_eligible = ts_action_cache_eligible,
)

def fixture_ts_policy_with_helper(name):
    fixture_ts_policy(name = name, exec_compatible_with = ts_action_execution_constraints())

def _fixture_ts_output_impl(ctx):
    if ts_action_admission_status(ctx) != ctx.attrs.expected_status:
        fail("native output fixture must exercise its declared execution branch")
    directory = ctx.actions.declare_output("verdict", dir = True)
    receipt = directory.project("typecheck.ok")
    shell = ctx.attrs._ts_sandbox[TsSandboxToolchainInfo].shell
    ts_action(
        ctx,
        cmd_args([
            shell, "--noprofile", "--norc", "-c",
            'test -d "${1%/*}"; test ! -e "$1"; printf "%s\\n" "$2" > "$1"',
            "--", receipt, ctx.attrs.expected_status,
        ]),
        inputs = [],
        outputs = [directory],
        cacheable = False,
        category = "fixture_typecheck",
    )
    return [DefaultInfo(default_output = receipt)]

fixture_ts_output = rule(
    impl = _fixture_ts_output_impl,
    attrs = dict(ts_action_attrs(), expected_status = attrs.string()),
)

def _dependency_impl(ctx):
    artifact = ctx.attrs.src
    return [
        DefaultInfo(default_output = artifact),
        RunInfo(args = artifact),
        PackageTreeInfo(tree = artifact, read_roots = [], admission_status = "analysis-only"),
        PnpmDeclaredClosureInfo(manifest = artifact, node_modules = artifact, read_roots = [], toolchain_identity = "analysis-only"),
        PackageCommandRuntimeInfo(runtime = artifact, read_roots = []),
        RustInteropProductInfo(package = artifact, kind = "wasm"),
        BunToolchainInfo(executable = "/analysis-only/bin/bun", identity = "analysis-only"),
        EffectTsgoToolchainInfo(
            bun = "/analysis-only/bin/bun",
            executable = "/analysis-only/bin/tsgo",
            identity = "analysis-only",
            runner = artifact,
        ),
        TsSandboxToolchainInfo(
            bubblewrap = "/analysis-only/bin/bwrap",
            bun = "/analysis-only/bin/bun",
            closure_paths = {
                "bun": ["/analysis-only"],
                "effect-tsgo": ["/analysis-only"],
                "buck2-fingerprint": ["/analysis-only"],
            },
            inputs = [artifact],
            shell = read_root_config("fixture", "shell", "/analysis-only/bin/bash"),
        ),
        BuckSupportToolInfo(
            content_digest = "analysis-only",
            closure_identity = "analysis-only",
            execution_platform = "analysis-only",
            executable = artifact,
            manifest = artifact,
            protocol = "analysis-only",
            runtime_contract = "analysis-only",
            store_path = read_root_config("fixture", "coreutils", "/analysis-only/bin/tool"),
            tool_id = "analysis-only",
        ),
    ]

fixture_dependency = rule(
    impl = _dependency_impl,
    attrs = {"src": attrs.source(default = "//:fixture-dependency.txt")},
)

def fixture_materialization_cases(suffix, constraints = []):
    pnpm_package(
        name = "pnpm_extract_" + suffix,
        package_name = "fixture",
        url = "https://example.invalid/fixture.tgz",
        sha256 = "0" * 64,
        size_bytes = 1,
        exec_compatible_with = constraints,
        visibility = ["PUBLIC"],
    )
    pnpm_store_entry(
        name = "pnpm_store_entry_" + suffix,
        package = "//:pnpm_extract_default",
        store_key = "fixture@1",
        runtime = "//:fixture-dependency.txt",
        dependencies = {},
        exec_compatible_with = constraints,
    )
    pnpm_store_scc(
        name = "pnpm_store_scc_" + suffix,
        members = {"fixture@1": "//:pnpm_extract_default"},
        runtime = "//:fixture-dependency.txt",
        internal_edges = {},
        external_edges = {},
        exec_compatible_with = constraints,
    )
    pnpm_store_view(
        name = "pnpm_store_view_" + suffix,
        runtime = "//:fixture-dependency.txt",
        closure = {},
        direct = {},
        bins = {},
        exec_compatible_with = constraints,
    )
    empty_package_view(
        name = "package_tree_" + suffix,
        files = {},
        runtime = "//:package_tree",
        runtime_entry = "fixture.ts",
        exec_compatible_with = constraints,
    )
    package_tree(
        name = "legacy_package_tree_" + suffix,
        node_modules = "//:fixture-dependency.txt",
        files = {},
        runtime = "//:package_tree",
        runtime_entry = "fixture.ts",
        exec_compatible_with = constraints,
    )
    package_view(
        name = "package_view_" + suffix,
        dependency_view = "//:package_tree",
        files = {},
        runtime = "//:package_tree",
        runtime_entry = "fixture.ts",
        exec_compatible_with = constraints,
    )

def fixture_negative_cases(suffix, constraint):
    fixture_materialization_cases(suffix, [constraint])
    vitest_test(
        name = "uncacheable_verdict_" + suffix,
        package_tree = "//:package_tree",
        cacheable = False,
        exec_compatible_with = [constraint],
    )
    vitest_collect(
        name = "uncacheable_collect_" + suffix,
        package_tree = "//:package_tree",
        cacheable = False,
        exec_compatible_with = [constraint],
    )
    package_bin_check(
        name = "unadmitted_check_" + suffix,
        package_tree = "//:package_tree",
        entrypoint = "check.ts",
        exec_compatible_with = [constraint],
    )
    rust_interop_smoke(
        name = "unadmitted_interop_" + suffix,
        product = "//:package_tree",
        script = "//:fixture-dependency.txt",
        exec_compatible_with = [constraint],
    )
BZL
cat > "$work/buck2/toolchains/BUCK" <<'BUCK'
load("//:fixture.bzl", "fixture_dependency")

fixture_dependency(name = "bun", visibility = ["PUBLIC"])
fixture_dependency(name = "effect_tsgo", visibility = ["PUBLIC"])
fixture_dependency(name = "fingerprint_tool", visibility = ["PUBLIC"])
fixture_dependency(name = "tool_action_env", visibility = ["PUBLIC"])
fixture_dependency(name = "tool_node", visibility = ["PUBLIC"])
fixture_dependency(name = "archive_tool", visibility = ["PUBLIC"])
fixture_dependency(name = "ts_sandbox", visibility = ["PUBLIC"])
BUCK
cat > "$work/packages/@overeng/buck2-tools/BUCK" <<'BUCK'
load("//:fixture.bzl", "fixture_dependency")

fixture_dependency(name = "javascript_action_runtime", visibility = ["PUBLIC"])
fixture_dependency(name = "package_command_runtime", visibility = ["PUBLIC"])
BUCK
cat > "$work/BUCK" <<'BUCK'
load("//:fixture.bzl", "fixture_dependency", "fixture_materialization_cases", "fixture_ts_output", "fixture_ts_policy", "fixture_ts_policy_with_helper")
load("//buck2:typescript.bzl", "tsgo_emit")
load("@rules//buck2:javascript.bzl", "vitest_collect")
load("@rules//buck2:package_tools.bzl", "package_bin_check")
load("@prelude//:prelude.bzl", "native")

native.export_file(name = "fixture-dependency.txt", visibility = ["PUBLIC"])

fixture_dependency(name = "package_tree", visibility = ["PUBLIC"])
fixture_materialization_cases("default")
# A caller's valid custom native constraint must survive without cache admission.
fixture_materialization_cases("custom", ["prelude//os/constraints:" + ("macos" if host_info().os.is_macos else "linux")])
tsgo_emit(name = "admitted_emit", package_tree = ":package_tree")
fixture_ts_policy(name = "ts_policy_default")
fixture_ts_policy(name = "ts_policy_cache", exec_compatible_with = ["@rules//buck2/platforms:cache_hermetic"])
fixture_ts_policy_with_helper(name = "ts_policy_helper")
fixture_ts_output(name = "darwin_fresh_verdict", expected_status = "darwin-unsandboxed")
fixture_ts_output(name = "nix_unverified_verdict", expected_status = "nix-outer-sandboxed")
fixture_ts_output(name = "nix_forged_verdict", expected_status = "nix-outer-sandboxed")

vitest_collect(
    name = "admitted_collect",
    package_tree = ":package_tree",
    cacheable = True,
)
vitest_collect(
    name = "default_uncacheable_collect",
    package_tree = ":package_tree",
    cacheable = False,
)
package_bin_check(
    name = "default_unadmitted_check",
    package_tree = ":package_tree",
    entrypoint = "check.ts",
)
BUCK
# Separate packages keep a load-time rejection for one spelling from masking
# another case or breaking the positive controls before analysis starts.
for row in \
  'alias_at @rules//buck2/platforms:cache_hermetic' \
  'alias rules//buck2/platforms:cache_hermetic' \
  'relative //buck2/platforms:cache_hermetic' \
  'canonical effect_utils//buck2/platforms:cache_hermetic'; do
  spelling="${row%% *}"
  constraint="${row#* }"
  mkdir -p "$work/$spelling"
  cat > "$work/$spelling/BUCK" <<BUCK
load("//:fixture.bzl", "fixture_negative_cases", "fixture_ts_policy")

fixture_negative_cases("$spelling", "$constraint")
fixture_ts_policy(name = "ts_policy_$spelling", exec_compatible_with = ["$constraint"])
BUCK
done
mkdir -p "$work/override"
cat > "$work/override/BUCK" <<'BUCK'
load("@rules//buck2:package_tools.bzl", "package_bin_check")

package_bin_check(
    name = "caller_override",
    package_tree = "//:package_tree",
    entrypoint = "check.ts",
    exec_compatible_with = ["@rules//buck2/platforms:cache_hermetic"],
    _cache_admission_constraint = "//buck2/platforms:host_platform",
)
BUCK

cd "$work"
for target in admitted_collect default_uncacheable_collect default_unadmitted_check; do
  if ! "$buck" --isolation-dir cache-admission-check audit providers "effect_utils//:$target" > "$work/$target.log" 2>&1; then
    cat "$work/$target.log" >&2
    printf 'Expected successful rule analysis: %s\n' "$target" >&2
    exit 1
  fi
  printf 'PASS analysis: %s\n' "$target"
done

# Inspect Buck's actual selected execution platform, with root cache policy ON.
# This is analysis-only: no fixture command or remote-cache request executes.
for suffix in default custom; do
  for family in pnpm_extract pnpm_store_entry pnpm_store_view pnpm_store_scc package_tree legacy_package_tree package_view; do
    target="${family}_${suffix}"
    "$buck" --isolation-dir cache-admission-check audit providers "effect_utils//:$target" > "$work/$target.log" 2>&1
    "$buck" --isolation-dir cache-admission-check cquery --output-attribute buck.execution_platform \
      -c buck2.remote_cache_enabled=true -c buck2.allow_cache_uploads=true \
      "effect_utils//:$target" > "$work/$target.platform.log" 2>&1
    if ! grep -Eq 'exec_(linux_x86_64|linux_aarch64|macos_aarch64)([^_[:alnum:]]|$)' "$work/$target.platform.log"; then
      cat "$work/$target.platform.log" >&2
      printf 'Materialization did not resolve to a nonremote native platform: %s\n' "$target" >&2
      exit 1
    fi
    printf 'PASS nonremote platform: %s\n' "$target"
  done
done
"$buck" --isolation-dir cache-admission-check audit providers effect_utils//:admitted_emit > "$work/admitted_emit.log" 2>&1
"$buck" --isolation-dir cache-admission-check cquery --output-attribute buck.execution_platform \
  -c buck2.remote_cache_enabled=true -c buck2.allow_cache_uploads=true \
  effect_utils//:admitted_emit > "$work/admitted_emit.platform.log" 2>&1
if grep -Fq 'darwin-unsandboxed' "$work/admitted_emit.log"; then
  if ! grep -Eq 'exec_macos_aarch64([^_[:alnum:]]|$)' "$work/admitted_emit.platform.log"; then
    cat "$work/admitted_emit.platform.log" >&2
    printf 'Darwin tsgo_emit obtained cache admission despite darwin-unsandboxed\n' >&2
    exit 1
  fi
  printf 'PASS darwin-unsandboxed local platform: tsgo_emit\n'
else
  if ! grep -Eq 'exec_(linux_x86_64|linux_aarch64)_hermetic' "$work/admitted_emit.platform.log"; then
    cat "$work/admitted_emit.platform.log" >&2
    printf 'Linux tsgo_emit lost its mandatory sandbox cache-admitted platform\n' >&2
    exit 1
  fi
  printf 'PASS Linux cache-admitted platform: tsgo_emit\n'
fi

# These real exec_dep analyses run on every host: target configuration remains
# the host, while the selected executor is explicitly Linux or Darwin. No tool
# or sandbox action executes, and no remote-cache request is issued.
for platform in linux_x86_64 linux_aarch64 macos_aarch64; do
  execution_platform="effect_utils//buck2/platforms:exec_$platform"
  "$buck" --isolation-dir cache-admission-check audit providers \
    -c "build.execution_platforms=$execution_platform" \
    effect_utils//:ts_policy_default > "$work/ts-policy-$platform.log" 2>&1 || {
      cat "$work/ts-policy-$platform.log" >&2
      exit 1
    }
  if [[ "$platform" == macos_aarch64 ]]; then
    expected_status=darwin-unsandboxed
  else
    expected_status=linux-bwrap
  fi
  if ! grep -Fq "$expected_status" "$work/ts-policy-$platform.log"; then
    cat "$work/ts-policy-$platform.log" >&2
    printf 'TS admission policy inspected target/host instead of executor: %s\n' "$platform" >&2
    exit 1
  fi
  if [[ "$platform" == macos_aarch64 ]]; then
    if "$buck" --isolation-dir cache-admission-check audit providers \
      -c "build.execution_platforms=$execution_platform" \
      effect_utils//:ts_policy_cache > "$work/ts-policy-cache-$platform.log" 2>&1; then
      printf 'Darwin executor unexpectedly obtained TypeScript cache admission\n' >&2
      exit 1
    fi
    if ! grep -Fq 'darwin-unsandboxed: TypeScript execution cannot use the cache-admitted execution platform' "$work/ts-policy-cache-$platform.log"; then
      cat "$work/ts-policy-cache-$platform.log" >&2
      printf 'Darwin cache override failed for an unrelated reason\n' >&2
      exit 1
    fi
  else
    "$buck" --isolation-dir cache-admission-check audit providers \
      -c "build.execution_platforms=$execution_platform" \
      effect_utils//:ts_policy_cache > "$work/ts-policy-cache-$platform.log" 2>&1
    if ! grep -Fq 'linux-bwrap' "$work/ts-policy-cache-$platform.log"; then
      cat "$work/ts-policy-cache-$platform.log" >&2
      exit 1
    fi
  fi
  printf 'PASS TS executor admission: %s\n' "$platform"
done
"$buck" --isolation-dir cache-admission-check audit providers \
  effect_utils//:ts_policy_helper > "$work/ts-policy-helper.log" 2>&1

# Canonical, relative and aliased cache constraints all resolve to the same
# default-only marker. Exercise them against a real Darwin execution platform.
for spelling in canonical relative alias alias_at; do
  target="effect_utils//$spelling:ts_policy_$spelling"
  if "$buck" --isolation-dir cache-admission-check audit providers \
    -c build.execution_platforms=effect_utils//buck2/platforms:exec_macos_aarch64 \
    "$target" > "$work/ts-policy-darwin-$spelling.log" 2>&1; then
    printf 'Darwin TypeScript override unexpectedly admitted: %s\n' "$spelling" >&2
    exit 1
  fi
  if ! grep -Fq 'darwin-unsandboxed: TypeScript execution cannot use the cache-admitted execution platform' "$work/ts-policy-darwin-$spelling.log"; then
    cat "$work/ts-policy-darwin-$spelling.log" >&2
    printf 'Darwin TypeScript override failed for an unrelated reason: %s\n' "$spelling" >&2
    exit 1
  fi
done
if "$buck" --isolation-dir cache-admission-check audit providers \
  -c build.execution_platforms=effect_utils//buck2/platforms:exec_macos_aarch64_hermetic \
  effect_utils//:ts_policy_default > "$work/ts-policy-darwin-implicit.log" 2>&1; then
  printf 'Darwin TypeScript implicitly selected a cache-admitted executor\n' >&2
  exit 1
fi
if ! grep -Fq 'darwin-unsandboxed: TypeScript execution cannot use the cache-admitted execution platform' "$work/ts-policy-darwin-implicit.log"; then
  cat "$work/ts-policy-darwin-implicit.log" >&2
  exit 1
fi

# A fresh isolated build executes the actual darwin-unsandboxed command emitted
# by ts_action, with pinned host Bash/coreutils fixture providers. This can run
# on Linux too: it tests launcher output ownership, not Darwin containment.
"$buck" --isolation-dir cache-admission-check build \
  -c build.execution_platforms=effect_utils//buck2/platforms:exec_macos_aarch64 \
  --local-only --show-full-json-output effect_utils//:darwin_fresh_verdict \
  > "$work/darwin-fresh-verdict.json" 2> "$work/darwin-fresh-verdict.log" || {
    cat "$work/darwin-fresh-verdict.log" >&2
    exit 1
  }
darwin_receipt="$("${JQ_BIN:?Pinned JQ_BIN is required}" -er \
  '."effect_utils//:darwin_fresh_verdict"' "$work/darwin-fresh-verdict.json")"
IFS= read -r darwin_verdict < "$darwin_receipt"
if [[ "$darwin_verdict" != darwin-unsandboxed ]]; then
  printf 'Darwin launcher did not create and populate its fresh nested verdict\n' >&2
  exit 1
fi
printf 'PASS fresh Darwin-branch nested verdict: declared output created by shared launcher\n'

# The explicit outer boundary must select native nonremote execution on either
# Linux executor, never inherit cache admission from the host or retry bwrap.
for platform in linux_x86_64 linux_aarch64; do
  execution_platform="effect_utils//buck2/platforms:exec_$platform"
  "$buck" --isolation-dir cache-admission-check audit providers \
    -c ts_action.outer_sandbox=nix-build/v1 \
    -c "build.execution_platforms=$execution_platform" \
    effect_utils//:ts_policy_default > "$work/ts-policy-nix-$platform.log" 2>&1 || {
    cat "$work/ts-policy-nix-$platform.log" >&2
    exit 1
  }
  if ! grep -Fq 'nix-outer-sandboxed' "$work/ts-policy-nix-$platform.log"; then
    cat "$work/ts-policy-nix-$platform.log" >&2
    exit 1
  fi
  if "$buck" --isolation-dir cache-admission-check audit providers \
    -c ts_action.outer_sandbox=nix-build/v1 \
    -c "build.execution_platforms=$execution_platform" \
    effect_utils//:ts_policy_cache > "$work/ts-policy-nix-cache-$platform.log" 2>&1; then
    printf 'Nix outer boundary unexpectedly obtained TS cache admission\n' >&2
    exit 1
  fi
  if ! grep -Fq 'nix-outer-sandboxed: TypeScript execution cannot use the cache-admitted execution platform' \
    "$work/ts-policy-nix-cache-$platform.log"; then
    cat "$work/ts-policy-nix-cache-$platform.log" >&2
    exit 1
  fi
done
for spelling in canonical relative alias alias_at; do
  if "$buck" --isolation-dir cache-admission-check audit providers \
    -c ts_action.outer_sandbox=nix-build/v1 \
    -c build.execution_platforms=effect_utils//buck2/platforms:exec_linux_x86_64 \
    "effect_utils//$spelling:ts_policy_$spelling" \
    > "$work/ts-policy-nix-$spelling.log" 2>&1; then
    printf 'Nix outer boundary cache override unexpectedly accepted: %s\n' "$spelling" >&2
    exit 1
  fi
  if ! grep -Fq 'nix-outer-sandboxed: TypeScript execution cannot use the cache-admitted execution platform' \
    "$work/ts-policy-nix-$spelling.log"; then
    cat "$work/ts-policy-nix-$spelling.log" >&2
    exit 1
  fi
done
if "$buck" --isolation-dir cache-admission-check audit providers \
  -c ts_action.outer_sandbox=nix-build/v1 \
  -c build.execution_platforms=effect_utils//buck2/platforms:exec_linux_x86_64_hermetic \
  effect_utils//:ts_policy_default > "$work/ts-policy-nix-implicit.log" 2>&1; then
  printf 'Nix outer boundary implicitly selected a cache-admitted executor\n' >&2
  exit 1
fi
if ! grep -Fq 'nix-outer-sandboxed: TypeScript execution cannot use the cache-admitted execution platform' \
  "$work/ts-policy-nix-implicit.log"; then
  cat "$work/ts-policy-nix-implicit.log" >&2
  exit 1
fi
if "$buck" --isolation-dir cache-admission-check audit providers \
  -c ts_action.outer_sandbox=unknown/v1 effect_utils//:ts_policy_helper \
  > "$work/ts-policy-unknown-outer.log" 2>&1; then
  printf 'Unknown TS outer boundary unexpectedly accepted\n' >&2
  exit 1
fi
if ! grep -Fq 'TypeScript outer sandbox has unsupported declared boundary unknown/v1' \
  "$work/ts-policy-unknown-outer.log"; then
  cat "$work/ts-policy-unknown-outer.log" >&2
  exit 1
fi
# A caller's declaration cannot disable Bubblewrap on an ordinary host. Each
# real action uses its own daemon so inherited context cannot leak between cases.
# The nonexistent fixture bwrap must not be reached as an error fallback either.
for context in unverified forged; do
  target="nix_${context}_verdict"
  isolation="cache-admission-${context}-outer"
  if [[ "$context" == forged ]]; then
    mkdir -p "$work/forged-home"
    outer_env=(env NIX_BUILD_TOP="$work" HOME="$work/forged-home")
  else
    outer_env=(env -u NIX_BUILD_TOP)
  fi
  if "${outer_env[@]}" "$buck" --isolation-dir "$isolation" build \
    -c ts_action.outer_sandbox=nix-build/v1 \
    -c build.execution_platforms=effect_utils//buck2/platforms:exec_linux_x86_64 \
    --local-only --show-full-json-output "effect_utils//:$target" \
    > "$work/nix-$context-verdict.json" 2> "$work/nix-$context-verdict.log"; then
    printf 'Unverified Nix outer boundary unexpectedly executed: %s\n' "$context" >&2
    exit 1
  fi
  for criterion in 'outer sandbox declared but not verified' NIX_BUILD_TOP \
    'action cwd' .buckroot HOME /proc/net/dev lo /home /root /nix/var; do
    if ! grep -Fq "$criterion" "$work/nix-$context-verdict.log"; then
      cat "$work/nix-$context-verdict.log" >&2
      printf 'Outer boundary refusal omitted required criterion %s: %s\n' "$criterion" "$context" >&2
      exit 1
    fi
  done
  if [[ "$context" == forged ]]; then
    for criterion in \
      'Failed criterion: NIX_BUILD_TOP must identify an existing absolute build directory' \
      'Failed criterion: action cwd must be under NIX_BUILD_TOP' \
      'Failed criterion: Buck root (.buckroot) must be under NIX_BUILD_TOP' \
      'Failed criterion: HOME must equal /homeless-shelter'; do
      if grep -Fq "$criterion" "$work/nix-$context-verdict.log"; then
        cat "$work/nix-$context-verdict.log" >&2
        printf 'Forged outer context did not reach the runtime boundary checks\n' >&2
        exit 1
      fi
    done
    if ! grep -Fq 'Failed criterion: /proc/net/dev must contain only lo, including lo' \
      "$work/nix-$context-verdict.log" &&
      ! grep -Fq 'Failed criterion: host homes and /nix/var must not be writable' \
        "$work/nix-$context-verdict.log"; then
      cat "$work/nix-$context-verdict.log" >&2
      printf 'Forged outer context failed without detecting networking or host exposure\n' >&2
      exit 1
    fi
  elif ! grep -Fq \
    'Failed criterion: NIX_BUILD_TOP must identify an existing absolute build directory' \
    "$work/nix-$context-verdict.log"; then
    cat "$work/nix-$context-verdict.log" >&2
    printf 'Missing outer context failed without identifying missing NIX_BUILD_TOP\n' >&2
    exit 1
  fi
  if [[ -n "$(find "$work/buck-out" -type f -name typecheck.ok -path "*$target*")" ]]; then
    printf 'Unverified outer boundary produced a nested verdict: %s\n' "$context" >&2
    exit 1
  fi
  printf 'PASS refused unverified Nix outer boundary: %s\n' "$context"
done

for family in uncacheable_verdict uncacheable_collect unadmitted_check unadmitted_interop pnpm_extract pnpm_store_entry pnpm_store_view pnpm_store_scc package_tree legacy_package_tree package_view; do
  for spelling in canonical relative alias alias_at; do
    target="${family}_${spelling}"
    if "$buck" --isolation-dir cache-admission-check audit providers "effect_utils//$spelling:$target" > "$work/$target.log" 2>&1; then
      cat "$work/$target.log" >&2
      printf 'Cache admission unexpectedly accepted: %s\n' "$target" >&2
      exit 1
    fi
    if ! grep -Fq 'this rule is not eligible for the cache-admitted execution platform' "$work/$target.log"; then
      cat "$work/$target.log" >&2
      printf 'Rule failed for a reason other than cache admission: %s\n' "$target" >&2
      exit 1
    fi
    printf 'PASS rejected: %s\n' "$target"
  done
done

if "$buck" --isolation-dir cache-admission-check audit providers effect_utils//override:caller_override > "$work/override.log" 2>&1; then
  cat "$work/override.log" >&2
  printf 'Caller unexpectedly overrode the rule-owned cache admission marker\n' >&2
  exit 1
fi
if ! grep -Fq 'Error coercing attribute `_cache_admission_constraint`' "$work/override.log" ||
  ! grep -Fq 'default_only is not allowed to be specified' "$work/override.log"; then
  cat "$work/override.log" >&2
  printf 'Caller override failed for a reason other than rule-owned admission\n' >&2
  exit 1
fi
printf 'PASS rejected: caller_override\n'
