#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
buck="${BUCK2_BIN:?Run in the repository devenv shell to use its pinned BUCK2_BIN}"
scratch_parent="${RUNNER_TEMP:-$repo_root/tmp}"
mkdir -p "$scratch_parent"
work="$(mktemp -d "$scratch_parent/buck2-cache-admission.XXXXXXXX")"
cleanup() {
  (cd "$work" && "$buck" --isolation-dir cache-admission-check kill >/dev/null 2>&1) || true
  rm -rf "$work"
}
trap cleanup EXIT

# Exercise the shipped rule implementations, not a parallel guard or a source
# inspection. Only their dependency providers are fixtures: audit providers
# performs real analysis without running Bun or materializing a package tree.
cp -R "$repo_root/buck2" "$work/buck2"
mkdir -p "$work/capabilities" "$work/packages/@overeng/buck2-tools"
touch "$work/.buckroot"
printf 'CAPABILITIES = {}\n' > "$work/capabilities/defs.bzl"
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
# The bundled prelude is supplied by the same pinned Buck binary as the repo's
# normal .buckconfig. No ambient prelude checkout or remote cache is consulted.
cat > "$work/fixture.bzl" <<'BZL'
load("//buck2/materialization.bzl", "PackageTreeInfo")
load("//buck2/javascript.bzl", "vitest_collect", "vitest_test")
load("//buck2/package_tools.bzl", "PackageCommandRuntimeInfo", "package_bin_check")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("//buck2/toolchains:defs.bzl", "BunToolchainInfo", "EffectTsgoToolchainInfo")
load("//buck2/rust:interop.bzl", "RustInteropProductInfo", "rust_interop_smoke")

def _dependency_impl(ctx):
    artifact = ctx.attrs.src
    return [
        DefaultInfo(default_output = artifact),
        PackageTreeInfo(tree = artifact, read_roots = []),
        PackageCommandRuntimeInfo(runtime = artifact, read_roots = []),
        RustInteropProductInfo(package = artifact, kind = "wasm"),
        BunToolchainInfo(executable = "/analysis-only/bin/bun", identity = "analysis-only"),
        EffectTsgoToolchainInfo(
            bun = "/analysis-only/bin/bun",
            executable = "/analysis-only/bin/tsgo",
            identity = "analysis-only",
            runner = artifact,
        ),
        BuckSupportToolInfo(
            content_digest = "analysis-only",
            closure_identity = "analysis-only",
            execution_platform = "analysis-only",
            executable = artifact,
            manifest = artifact,
            protocol = "analysis-only",
            runtime_contract = "analysis-only",
            store_path = "/analysis-only/bin/tool",
            tool_id = "analysis-only",
        ),
    ]

fixture_dependency = rule(
    impl = _dependency_impl,
    attrs = {"src": attrs.source(default = "//:fixture-dependency.txt")},
)

def fixture_negative_cases(suffix, constraint):
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
BUCK
cat > "$work/packages/@overeng/buck2-tools/BUCK" <<'BUCK'
load("//:fixture.bzl", "fixture_dependency")

fixture_dependency(name = "javascript_action_runtime", visibility = ["PUBLIC"])
fixture_dependency(name = "package_command_runtime", visibility = ["PUBLIC"])
BUCK
cat > "$work/BUCK" <<'BUCK'
load("//:fixture.bzl", "fixture_dependency")
load("@rules//buck2:javascript.bzl", "vitest_collect")
load("@rules//buck2:package_tools.bzl", "package_bin_check")
load("@prelude//:prelude.bzl", "native")

native.export_file(name = "fixture-dependency.txt", visibility = ["PUBLIC"])

fixture_dependency(name = "package_tree", visibility = ["PUBLIC"])

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
load("//:fixture.bzl", "fixture_negative_cases")

fixture_negative_cases("$spelling", "$constraint")
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

for family in uncacheable_verdict uncacheable_collect unadmitted_check unadmitted_interop; do
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
