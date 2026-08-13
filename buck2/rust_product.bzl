"""Exact Buck build-product packaging for one Nix-authored static Rust lane."""

BuildProductInfo = provider(fields = ["archive", "descriptor"])

def _single_output(dep):
    outputs = dep[DefaultInfo].default_outputs
    if len(outputs) != 1:
        fail("rust_build_product requires exactly one binary output")
    return outputs[0]

def _impl(ctx):
    identity = ctx.attrs.compile_identity
    if len(identity) != 71 or not identity.startswith("sha256:"):
        fail("compile_identity must be a Nix-authored sha256 identity")
    archive = ctx.actions.declare_output("artifact.tar")
    descriptor = ctx.actions.declare_output("descriptor.json")
    ctx.actions.run(
        [
            ctx.attrs._packager[RunInfo],
            "product",
            "--binary", _single_output(ctx.attrs.binary),
            "--binary-name", ctx.attrs.binary_name,
            "--target", str(ctx.label),
            "--toolchain-identity", identity,
            "--archive", archive.as_output(),
            "--descriptor", descriptor.as_output(),
        ],
        category = "rust_build_product",
        env = {"PATH": "/nonexistent"},
        identifier = ctx.attrs.binary_name,
        local_only = True,
    )
    return [
        DefaultInfo(
            default_output = archive,
            other_outputs = [descriptor],
            sub_targets = {
                "descriptor": [DefaultInfo(default_output = descriptor)],
            },
        ),
        BuildProductInfo(archive = archive, descriptor = descriptor),
    ]

rust_build_product = rule(
    impl = _impl,
    attrs = {
        "binary": attrs.dep(),
        "binary_name": attrs.string(),
        "compile_identity": attrs.string(),
        "_packager": attrs.default_only(attrs.exec_dep(
            default = "toolchains//:package_evidence_tool",
            providers = [RunInfo],
        )),
    },
)
