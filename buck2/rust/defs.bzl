"""Thin Prelude rust_binary to ProductExecutableInfo adapter."""

load("@effect_utils//buck2/platforms:defs.bzl", "ProductPlatformInfo", "product_platform_constraints")
load("@effect_utils//buck2/provenance:defs.bzl", "product_executable_info")
load("@effect_utils//buck2/toolchains:defs.bzl", "ConfiguredRustToolchainInfo")


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
            default = "toolchains//:rust",
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
