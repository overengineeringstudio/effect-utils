"""Execution proof for Prelude's conventional Rust and C++ toolchain providers."""

load("@prelude//cxx:cxx_toolchain_types.bzl", "CxxToolchainInfo")
load("@prelude//rust:rust_toolchain.bzl", "RustToolchainInfo")

def _impl(ctx):
    identity = ctx.attrs.toolchain_identity
    if len(identity) != 71 or not identity.startswith("sha256:"):
        fail("toolchain_identity must be a Nix-authored sha256 identity")
    rust = ctx.actions.declare_output("rustc.version")
    cxx = ctx.actions.declare_output("cc.version")
    ctx.actions.run(
        [ctx.attrs._rust[RustToolchainInfo].compiler, "--version", "--verbose"],
        category = "conventional_rust_toolchain_probe",
        env = {"EFFECT_UTILS_BUCK2_TOOLCHAIN_IDENTITY": identity},
        local_only = True,
        stdout = rust.as_output(),
    )
    ctx.actions.run(
        [ctx.attrs._cxx[CxxToolchainInfo].c_compiler_info.compiler, "--version"],
        category = "conventional_cxx_toolchain_probe",
        env = {"EFFECT_UTILS_BUCK2_TOOLCHAIN_IDENTITY": identity},
        local_only = True,
        stdout = cxx.as_output(),
    )
    return [DefaultInfo(default_outputs = [rust, cxx])]

conventional_toolchain_probe = rule(
    impl = _impl,
    attrs = {
        "toolchain_identity": attrs.string(),
        "_rust": attrs.default_only(attrs.exec_dep(
            default = "toolchains//:rust",
            providers = [RustToolchainInfo],
        )),
        "_cxx": attrs.default_only(attrs.exec_dep(
            default = "toolchains//:cxx",
            providers = [CxxToolchainInfo],
        )),
    },
)
