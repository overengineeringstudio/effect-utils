"""Cross-cell analysis fixture for root-owned product provider identities."""

load("@root//buck2/platforms:defs.bzl", "ProductPlatformInfo")
load("@root//buck2/products:defs.bzl", "build_product")
load("@root//buck2/provenance:defs.bzl", "product_executable_info")

def _product_executable_impl(ctx):
    executable = ctx.attrs.executable
    return [
        DefaultInfo(default_output = executable),
        product_executable_info(
            ctx = ctx,
            executable = executable,
            recipe = "cross-cell-provider-identity/v1",
            toolchain = "cross-cell-provider-identity/v1",
            target_platform = ctx.attrs.target_platform[ProductPlatformInfo],
        ),
    ]

_product_executable = rule(
    impl = _product_executable_impl,
    attrs = {
        "executable": attrs.source(),
        "target_platform": attrs.dep(providers = [ProductPlatformInfo]),
    },
)

def cross_cell_product_identity(name, target_platform, executable_target_platform = None):
    if executable_target_platform == None:
        executable_target_platform = target_platform
    executable = name + "_executable"
    _product_executable(
        name = executable,
        executable = "@root//buck2/products:fixture_executable",
        target_platform = executable_target_platform,
    )
    build_product(
        name = name,
        executable = ":" + executable,
        target_platform = target_platform,
        product_name = "cross-cell-provider-identity",
        entrypoint = "bin/cross-cell-provider-identity",
    )
