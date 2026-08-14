"""Language-neutral portable build-product packaging contract."""

load("@root//buck2/platforms:defs.bzl", "ProductPlatformInfo", "native_execution_constraints")
load("@root//buck2/provenance:defs.bzl", "ProductExecutableInfo")

BuildProductInfo = provider(fields = {
    "descriptor": Artifact,
    "payload": Artifact,
})

def _build_product_impl(ctx):
    if not ctx.attrs.product_name:
        fail("build_product product_name must not be empty")
    entrypoint = ctx.attrs.entrypoint
    if not entrypoint or entrypoint.startswith("/"):
        fail("build_product entrypoint must be a normalized relative path")
    for component in entrypoint.split("/"):
        if component == "" or component == "." or component == "..":
            fail("build_product entrypoint must be a normalized relative path")
    product_executable = ctx.attrs.executable[ProductExecutableInfo]
    target_platform = ctx.attrs.target_platform[ProductPlatformInfo]
    actual_platform = (
        product_executable.target_platform_os,
        product_executable.target_platform_architecture,
        product_executable.target_platform_abi,
        product_executable.target_platform_runtime_contract,
    )
    expected_platform = (
        target_platform.os,
        target_platform.architecture,
        target_platform.abi,
        target_platform.runtime_contract,
    )
    if actual_platform != expected_platform:
        fail("build_product executable platform {} does not match requested target platform {}".format(actual_platform, expected_platform))
    executable = product_executable.executable
    provenance = product_executable.provenance
    payload = ctx.actions.declare_output("artifact.tar")
    descriptor = ctx.actions.declare_output("descriptor.json")
    args = cmd_args([
        ctx.attrs._descriptor_tool[RunInfo],
        "package",
        "--executable", executable,
        "--entrypoint", entrypoint,
        "--artifact", payload.as_output(),
        "--name", ctx.attrs.product_name,
        "--target", str(ctx.label.raw_target()),
        "--platform-os", product_executable.target_platform_os,
        "--platform-architecture", product_executable.target_platform_architecture,
        "--platform-abi", product_executable.target_platform_abi,
        "--runtime-contract", product_executable.target_platform_runtime_contract,
        "--provenance", provenance.artifact,
        "--descriptor", descriptor.as_output(),
    ])
    # One action owns deterministic archive creation, native executable
    # inspection, and digesting the exact archive named by the descriptor.
    ctx.actions.run(args, category = "build_product_package", local_only = True)
    return [
        DefaultInfo(
            default_output = payload,
            other_outputs = [descriptor, provenance.artifact],
            sub_targets = {
                "descriptor": [DefaultInfo(default_output = descriptor)],
                "provenance": [DefaultInfo(default_output = provenance.artifact)],
            },
        ),
        BuildProductInfo(descriptor = descriptor, payload = payload),
    ]

_build_product = rule(
    impl = _build_product_impl,
    attrs = {
        "executable": attrs.dep(providers = [ProductExecutableInfo]),
        "product_name": attrs.string(),
        "entrypoint": attrs.string(),
        "target_platform": attrs.dep(providers = [ProductPlatformInfo]),
        "_descriptor_tool": attrs.default_only(attrs.exec_dep(
            default = "toolchains//:product_tool",
            providers = [RunInfo],
        )),
    },
)

def build_product(
        name,
        executable,
        target_platform,
        product_name,
        entrypoint,
        **kwargs):
    """Packages a payload built under the product's exact target platform."""
    _build_product(
        name = name,
        executable = executable,
        target_platform = target_platform,
        product_name = product_name,
        entrypoint = entrypoint,
        default_target_platform = target_platform,
        exec_compatible_with = native_execution_constraints(target_platform),
        **kwargs
    )
