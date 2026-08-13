"""Language-neutral portable build-product packaging contract."""

load("//buck2/provenance:defs.bzl", "ProductExecutableInfo")

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
    executable = product_executable.executable
    platform = product_executable.target_platform
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
        "--platform-os", platform.os,
        "--platform-architecture", platform.architecture,
        "--platform-abi", platform.abi,
        "--runtime-contract", platform.runtime_contract,
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
        "_descriptor_tool": attrs.default_only(attrs.exec_dep(
            default = "toolchains//:product_tool",
            providers = [RunInfo],
        )),
    },
)

def build_product(
        name,
        executable,
        product_name,
        entrypoint,
        **kwargs):
    """Packages a payload built under the product's exact target platform."""
    if "default_target_platform" in kwargs:
        fail("build_product target platform is inherited from its executable producer")
    _build_product(
        name = name,
        executable = executable,
        product_name = product_name,
        entrypoint = entrypoint,
        **kwargs
    )
