#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)}"
export BUCK2_RULES_REPO="$repo_root"
"$repo_root/nix/buck2-rules/tests/consumer-root-config.test.sh" "$repo_root"

root="$(nix build --impure --no-link --print-out-paths --expr '
  let
    repo = builtins.toPath (builtins.getEnv "BUCK2_RULES_REPO");
    flake = builtins.getFlake (toString repo);
    system = builtins.currentSystem;
    pkgs = import flake.inputs.nixpkgs { inherit system; };
  in flake.lib.mkConsumerBuckRoot {
    inherit pkgs;
    rules = flake.packages.${system}.buck2-rules;
    capabilities = flake.lib.mkBuck2Capabilities {
      inherit pkgs;
      extraCapabilities.fixture-data = {
        kind = "directory";
        package = pkgs.writeTextDir "payload.txt" "declared vendor payload\n";
        protocol = "fixture/vendor-payload/v1";
      };
    };
    cellName = "fixture";
  }
')"

[ -f "$root/.buckroot" ]
[ -f "$root/.buckconfig" ]
[ -f "$root/BUCK" ]
[ -f "$root/buck2/toolchains/BUCK" ]
[ -f "$root/.buck2/rules/inventory.json" ]
[ -f "$root/.buck2/rules/prelude/prelude.bzl" ]
[ -f "$root/.buck2/capabilities/defs.bzl" ]
[ -f "$root/.buck2/rules/packages/@overeng/buck2-tools/src/typescript-runner.ts" ]
[ -f "$root/.buck2/rules/buck2/dependencies/runtime-closure.ts" ]

config="$(cat "$root/.buckconfig")"
printf '%s\n' "$config" | grep -F 'fixture = .' >/dev/null
printf '%s\n' "$config" | grep -F 'rules = .buck2/rules' >/dev/null
printf '%s\n' "$config" | grep -F 'capabilities = .buck2/capabilities' >/dev/null
printf '%s\n' "$config" | grep -F 'prelude = .buck2/rules/prelude' >/dev/null
printf '%s\n' "$config" | grep -F 'toolchains = fixture' >/dev/null
if printf '%s\n' "$config" | grep -F 'effect_utils' >/dev/null; then
  echo 'consumer root must not mount effect-utils' >&2
  exit 1
fi
if printf '%s\n' "$config" | grep -F '/nix/store/' >/dev/null; then
  echo 'consumer root cell paths must be materialized root-relative paths' >&2
  exit 1
fi

grep -F 'load("@rules//buck2/toolchains:defs.bzl"' "$root/buck2/toolchains/BUCK" >/dev/null
grep -F 'load("@capabilities//:defs.bzl"' "$root/buck2/toolchains/BUCK" >/dev/null
grep -F 'effect_tsgo_toolchain(' "$root/buck2/toolchains/BUCK" >/dev/null
grep -F 'name = "product_tool"' "$root/buck2/toolchains/BUCK" >/dev/null
grep -F 'actual = "//buck2/toolchains:rust"' "$root/BUCK" >/dev/null
grep -F 'name = "typescript-runner.ts"' "$root/.buck2/rules/packages/@overeng/buck2-tools/BUCK" >/dev/null
grep -F 'name = "package_tree_runtime"' "$root/.buck2/rules/BUCK" >/dev/null
grep -F 'name = "package_command_runtime"' "$root/.buck2/rules/BUCK" >/dev/null
grep -F 'name = "runtime-closure.ts"' "$root/.buck2/rules/buck2/dependencies/BUCK" >/dev/null

# Buck writes buck-out under the project root, so queries run in a writable copy.
work="$(mktemp -d)"
cleanup() {
  (cd "$work" && buck2 --isolation-dir consumer-root-contract kill >/dev/null 2>&1) || true
  chmod -R u+w "$work"
  rm -rf "$work"
}
trap cleanup EXIT
cp -R "$root/." "$work/"
chmod -R u+w "$work"
cat >> "$work/buck2/toolchains/BUCK" <<'BUCK'

load("@rules//buck2/toolchains:configured.bzl", "store_directory")

store_directory(
    name = "fixture_data",
    input_id = "fixture-data",
    protocol = "fixture/vendor-payload/v1",
    visibility = ["PUBLIC"],
)
BUCK
mkdir -p "$work/vendor"
cat > "$work/vendor/BUCK" <<'BUCK'
load("@prelude//:prelude.bzl", "native")

native.genrule(
    name = "consume",
    srcs = ["//buck2/toolchains:fixture_data"],
    out = "payload.txt",
    cmd = "cat $(location //buck2/toolchains:fixture_data)/payload.txt > $OUT",
)
BUCK

# A consumer package must analyze `bun_compiled_product_executable`. Its rule
# defaults (`//buck2/toolchains:bun`, `:bun_compile_runtime`) resolve in the
# rules cell against effect-utils' capability projection, so the consumer root
# declares no compile-runtime tool of its own. The module is a stub provider;
# analysis needs no build.
mkdir -p "$work/compiled"
cat > "$work/compiled/defs.bzl" <<'BZL'
load("@rules//buck2:package_tools.bzl", "JavaScriptModuleInfo")

def _stub_module_impl(ctx):
    module = ctx.actions.write("module.js", "")
    descriptor = ctx.actions.write("module.json", "{}")
    return [
        DefaultInfo(default_output = module),
        JavaScriptModuleInfo(module = module, descriptor = descriptor, dependency_closure_identity = "stub"),
    ]

stub_module = rule(impl = _stub_module_impl, attrs = {})
BZL
cat > "$work/compiled/BUCK" <<'BUCK'
load("@rules//buck2/platforms:defs.bzl", "host_platform_label")
load("@rules//buck2/products:defs.bzl", "bun_compiled_product_executable")
load(":defs.bzl", "stub_module")

stub_module(name = "module")

bun_compiled_product_executable(
    name = "compiled",
    module = ":module",
    product_name = "fixture-cli",
    recipe = "bun-compile:fixture",
    target_platform = host_platform_label("rules"),
)
BUCK

mkdir -p "$work/closure"
cat > "$work/closure/defs.bzl" <<'BZL'
load("@rules//buck2/dependencies:defs.bzl", "PnpmDeclaredClosureInfo")

def _view_impl(ctx):
    node_modules = ctx.actions.symlinked_dir("node_modules", {})
    manifest = ctx.actions.write("manifest.json", "{}")
    return [
        DefaultInfo(default_output = node_modules),
        PnpmDeclaredClosureInfo(
            manifest = manifest,
            node_modules = node_modules,
            read_roots = [node_modules],
            toolchain_identity = "fixture",
        ),
    ]

view = rule(impl = _view_impl, attrs = {})
BZL
cat > "$work/closure/BUCK" <<'BUCK'
load("@rules//buck2/dependencies:defs.bzl", "pnpm_runtime_closure")
load(":defs.bzl", "view")

view(name = "view")

pnpm_runtime_closure(
    name = "runtime",
    importers = {"service": ":view"},
    primary = "service",
    runtime = "@rules//buck2/dependencies:runtime-closure.ts",
)
BUCK

(
  cd "$work"
  buck2 --isolation-dir consumer-root-contract uquery \
    'set(rules//:package_tree_runtime rules//:package_command_runtime rules//packages/@overeng/buck2-tools:typescript-runner.ts)' >/dev/null
  buck2 --isolation-dir consumer-root-contract uquery 'rules//buck2/dependencies:runtime-closure.ts' >/dev/null
  vendor_output="$(buck2 --isolation-dir consumer-root-contract build fixture//vendor:consume --show-simple-output)"
  [[ "$(cat "$vendor_output")" == "declared vendor payload" ]]
  buck2 --isolation-dir consumer-root-contract cquery 'fixture//closure:runtime' >/dev/null
  exec_deps="$(buck2 --isolation-dir consumer-root-contract cquery 'deps(fixture//compiled:compiled, 1, exec_deps())')"
  printf '%s\n' "$exec_deps" | grep -F 'rules//buck2/toolchains:bun_compile_runtime' >/dev/null
  providers="$(buck2 --isolation-dir consumer-root-contract audit providers fixture//compiled:compiled)"
  printf '%s\n' "$providers" | grep -F 'ProductExecutableInfo' >/dev/null
  printf '%s\n' "$providers" | grep -F 'bun-compile-runtime=' >/dev/null
)

# Build a native product from the same materialized consumer root. Its prelude
# is a local cell, unlike effect-utils' own bundled external prelude.
mkdir -p "$work/rust-fixture"
cat > "$work/rust-fixture/main.rs" <<'RUST'
fn main() {
    println!("consumer-root-rust");
}
RUST
cat > "$work/rust-fixture/build.rs" <<'RUST'
fn main() {
    // Match rustversion's compiler probe, including its optional Cargo wrapper.
    let rustc = std::env::var_os("RUSTC").expect("RUSTC");
    let wrapper = std::env::var_os("RUSTC_WRAPPER").filter(|value| !value.is_empty());
    let mut command = std::process::Command::new(wrapper.as_ref().unwrap_or(&rustc));
    if wrapper.is_some() {
        command.arg(&rustc);
    }
    assert!(std::env::var_os("RUSTC_WORKSPACE_WRAPPER").is_none_or(|value| value.is_empty()));
    let version = command.arg("--version").output().expect("rustc --version");
    assert!(version.status.success());
    assert!(String::from_utf8(version.stdout).unwrap().starts_with("rustc "));
    println!("cargo:rerun-if-changed=build.rs");
}
RUST
cat > "$work/rust-fixture/Cargo.toml" <<'TOML'
[package]
name = "consumer-root-rust"
version = "0.1.0"
edition = "2021"
TOML
cat > "$work/rust-fixture/BUCK" <<'BUCK'
load("@prelude//:prelude.bzl", "native")
load("@rules//buck2/products:defs.bzl", "build_product")
load("@rules//buck2/platforms:defs.bzl", "host_platform_label")
load("@rules//buck2/rust:defs.bzl", "rust_product_executable")
load("@rules//buck2/rust:defs.bzl", "cargo_build_script")
load("@rules//buck2/rust:defs.bzl", "buildscript_run")

native.rust_binary(
    name = "binary",
    crate = "consumer_root_rust",
    crate_root = "main.rs",
    srcs = ["main.rs"],
    edition = "2021",
)
cargo_build_script(
    name = "build-script",
    build_script = ":build-script-binary",
    package_path = "rust-fixture",
    srcs = {
        "rust-fixture/build.rs": "build.rs",
        "rust-fixture/main.rs": "main.rs",
    },
)

native.rust_binary(
    name = "build-script-binary",
    crate = "build_script_build",
    crate_root = "build.rs",
    srcs = ["build.rs"],
    edition = "2021",
)

buildscript_run(
    name = "build-script-run",
    package_name = "consumer-root-rust",
    buildscript_rule = ":build-script",
    manifest_dir = ":build-script",
    version = "0.1.0",
)


rust_product_executable(
    name = "executable",
    binary = ":binary",
    recipe = "cargo-workspace:consumer-root-rust@0.1.0",
    target_platform = host_platform_label(cell = "rules"),
)

build_product(
    name = "product",
    entrypoint = "bin/consumer-root-rust",
    executable = ":executable",
    product_name = "consumer-root-rust",
    target_platform = host_platform_label(cell = "rules"),
)
BUCK
# A fresh isolation captures these deliberately broken wrappers in the daemon.
# A wrapper returning no version reproduces rustversion's ambient-wrapper failure.
cat > "$work/ambient-rust-wrapper" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$work/ambient-rust-wrapper"
(
  cd "$work"
  buck2 --isolation-dir consumer-root-contract kill >/dev/null 2>&1 || true
  RUSTC_WRAPPER="$work/ambient-rust-wrapper" \
    RUSTC_WORKSPACE_WRAPPER="$work/ambient-rust-wrapper" \
    buck2 --isolation-dir consumer-root-contract build 'fixture//rust-fixture:build-script-run[rustc_flags]' >/dev/null
)
# The launcher generated by cargo_build_script is executed directly by Prelude.
# Its shebang must point to a native executable, not to a shell-script wrapper.
launcher="$(find "$work/buck-out/consumer-root-contract/art" -path '*/__build-script__/launcher.sh' -print -quit)"
[[ -n "$launcher" ]]
IFS= read -r shebang < "$launcher"
[[ "$shebang" == '#!'* ]]
interpreter="${shebang#\#!}"
case "$(file -b "$interpreter")" in
  'Mach-O '*|'ELF '*) ;;
  *) echo "build-script launcher interpreter is not native: $interpreter" >&2; exit 1 ;;
esac

export BUCK2_CONSUMER_FIXTURE="$work"
product="$(nix build --impure --no-link --print-out-paths --expr '
  let
    repo = builtins.toPath (builtins.getEnv "BUCK2_RULES_REPO");
    source = builtins.path {
      path = builtins.toPath (builtins.getEnv "BUCK2_CONSUMER_FIXTURE");
      name = "consumer-root-native-fixture";
    };
    flake = builtins.getFlake (toString repo);
    system = builtins.currentSystem;
    pkgs = import flake.inputs.nixpkgs { inherit system; };
  in (flake.lib.mkBuckProductFromSource { inherit pkgs; }) {
    repositorySource = source;
    capabilities = flake.lib.mkBuck2Capabilities {
      inherit pkgs;
      extraCapabilities.fixture-data = {
        kind = "directory";
        package = pkgs.writeTextDir "payload.txt" "declared vendor payload\n";
        protocol = "fixture/vendor-payload/v1";
      };
    };
    pnpmArchives = flake.packages.${system}.buck2-pnpm-archives;
    producerCommit = "0000000000000000000000000000000000000000";
    product = {
      name = "consumer-root-rust";
      target = "//rust-fixture:product";
      outputName = "artifact.tar";
      kind = "native";
      cargoWorkspaceRoot = "rust-fixture";
    };
  }
')"
tar -xOf "$product/artifact.tar" bin/consumer-root-rust > "$work/consumer-root-rust"
chmod +x "$work/consumer-root-rust"
[[ "$("$work/consumer-root-rust")" == "consumer-root-rust" ]]

echo 'buck2 consumer root contract passed'
