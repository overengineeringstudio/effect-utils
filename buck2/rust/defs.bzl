"""Thin Prelude rust_binary to ProductExecutableInfo adapter."""

load("//buck2/platforms:defs.bzl", "ProductPlatformInfo", "product_platform_constraints")
load("//buck2/provenance:defs.bzl", "product_executable_info")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("//buck2/toolchains:defs.bzl", "ConfiguredRustToolchainInfo")


def _single_binary_output(dep):
    outputs = dep[DefaultInfo].default_outputs
    if len(outputs) != 1:
        fail("rust_product_executable requires exactly one rust_binary default output")
    return outputs[0]


def _rust_product_executable_impl(ctx):
    platform = ctx.attrs.target_platform[ProductPlatformInfo]
    toolchain = ctx.attrs._rust_toolchain[ConfiguredRustToolchainInfo]
    expected = (
        str(ctx.attrs.target_platform.label.raw_target()),
        platform.os,
        platform.architecture,
        platform.abi,
        platform.runtime_contract,
        platform.rust_target_triple,
    )
    actual = (
        toolchain.target_platform_label,
        toolchain.target_platform_os,
        toolchain.target_platform_architecture,
        toolchain.target_platform_abi,
        toolchain.target_platform_runtime_contract,
        toolchain.target_triple,
    )
    if actual != expected:
        fail("rust_product_executable toolchain platform {} does not match target {}".format(actual, expected))
    executable = _single_binary_output(ctx.attrs.binary)
    return [
        DefaultInfo(default_output = executable),
        product_executable_info(
            ctx,
            executable = executable,
            recipe = ctx.attrs.recipe,
            toolchain = toolchain.identity,
            target_platform = platform,
        ),
    ]


_rust_product_executable = rule(
    impl = _rust_product_executable_impl,
    attrs = {
        "binary": attrs.dep(providers = [DefaultInfo]),
        "recipe": attrs.string(),
        "target_platform": attrs.dep(providers = [ProductPlatformInfo]),
        "_rust_toolchain": attrs.default_only(attrs.toolchain_dep(
            default = "//buck2/toolchains:rust",
            providers = [ConfiguredRustToolchainInfo],
        )),
    },
)


def rust_product_executable(name, binary, recipe, target_platform, **kwargs):
    """Adapts one Prelude rust_binary for buck2/products:build_product."""
    if "target_compatible_with" in kwargs:
        fail("rust_product_executable owns target compatibility")
    _rust_product_executable(
        name = name,
        binary = binary,
        recipe = recipe,
        target_platform = target_platform,
        target_compatible_with = product_platform_constraints(target_platform),
        **kwargs
    )


def _cargo_build_script_impl(ctx):
    build_script = ctx.attrs.build_script[DefaultInfo].default_outputs
    if len(build_script) != 1:
        fail("cargo_build_script requires exactly one rust_binary default output")
    shell = ctx.attrs._shell[BuckSupportToolInfo]
    tree = ctx.actions.symlinked_dir("manifest_tree", ctx.attrs.srcs)
    package_dir = tree.project(ctx.attrs.package_path)
    launcher = ctx.actions.declare_output("launcher.sh")

    # Prelude buildscript_run points CARGO_MANIFEST_DIR at a fresh directory holding only
    # the manifest_dir entries, so `$CARGO_MANIFEST_DIR/..` escapes the package layout.
    # The launcher re-anchors the build script in the repository-relative tree, where
    # `$CARGO_MANIFEST_DIR/../<pkg>/<file>` reaches the declared inputs.
    ctx.actions.write(
        launcher,
        [
            "#!{}".format(shell.store_path),
            "set -eu",
            'here=$(cd -P -- "${0%/*}" && pwd)',
            # Prelude sets RUSTC relative to the directory it runs the script in; Cargo
            # promises a RUSTC runnable from the build script, so pin it before moving.
            'case "${RUSTC:-}" in "" | /*) ;; *) export RUSTC="$PWD/$RUSTC" ;; esac',
            cmd_args(
                cmd_args(package_dir, relative_to = (launcher, 1), quote = "shell"),
                format = 'cd -P -- "$here"/{}',
            ),
            'export CARGO_MANIFEST_DIR="$PWD"',
            # Set by the Nix-sandboxed prelude (nix/buck2-rules) to the loader that runs
            # portable-interpreter build scripts; unset on hosts, where they run directly.
            'loader="${BUCK2_RUST_BUILD_SCRIPT_LOADER:-}"',
            cmd_args(
                cmd_args(build_script[0], relative_to = (launcher, 1), quote = "shell"),
                format = 'exec $loader "$here"/{}',
            ),
            "",
        ],
        is_executable = True,
        allow_args = True,
    )
    return [
        # buildscript_run's manifest_dir: the package subtree.
        DefaultInfo(default_output = package_dir),
        # buildscript_run's buildscript: the launcher, carrying everything it execs or reads.
        RunInfo(args = cmd_args(launcher, hidden = [
            ctx.attrs.build_script[RunInfo],
            tree,
            shell.executable,
            shell.manifest,
        ])),
    ]


cargo_build_script = rule(
    impl = _cargo_build_script_impl,
    attrs = {
        "build_script": attrs.exec_dep(providers = [RunInfo]),
        # Repository-relative paths: the package's own files and the inputs its build
        # script reads from other packages, so `$CARGO_MANIFEST_DIR/../<pkg>/<file>` resolves.
        "srcs": attrs.dict(key = attrs.string(), value = attrs.source()),
        "package_path": attrs.string(),
        "_shell": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:tool_rust_shell",
            providers = [BuckSupportToolInfo],
        )),
    },
    doc = "A first-party Cargo build script run with CARGO_MANIFEST_DIR in its repository-relative layout.",
)
