"""Execution proof for Prelude's conventional Rust and C++ toolchain providers."""

load("@prelude//cxx:cxx_toolchain_types.bzl", "CxxToolchainInfo")
load("@prelude//rust:rust_toolchain.bzl", "RustToolchainInfo")

def _configured_bash():
    bins = read_root_config("rust_toolchain", "tool_path", "").split(":")
    if not bins or not bins[0].startswith("/nix/store/"):
        fail("rust_toolchain.tool_path must expose an immutable Nix store bash bin dir")
    return bins[0] + "/bash"

def _impl(ctx):
    identity = ctx.attrs.toolchain_identity
    if len(identity) != 71 or not identity.startswith("sha256:"):
        fail("toolchain_identity must be a Nix-authored sha256 identity")
    # This Buck2 build cannot bind an action's stdout to an output artifact, so
    # each probe redirects through the immutable store bash from tool_path.
    bash = _configured_bash()
    rust = ctx.actions.declare_output("rustc.version")
    cxx = ctx.actions.declare_output("cc.version")
    for out, provider_command, extra_args, category in [
        (
            rust,
            ctx.attrs._rust[RustToolchainInfo].compiler,
            ["--version", "--verbose"],
            "conventional_rust_toolchain_probe",
        ),
        (
            cxx,
            ctx.attrs._cxx[CxxToolchainInfo].c_compiler_info.compiler,
            ["--version"],
            "conventional_cxx_toolchain_probe",
        ),
    ]:
        ctx.actions.run(
            cmd_args(
                bash,
                "-c",
                'out="$1"; shift; exec "$@" > "$out"',
                "conventional_probe",
                out.as_output(),
                provider_command,
                extra_args,
            ),
            category = category,
            env = {"EFFECT_UTILS_BUCK2_TOOLCHAIN_IDENTITY": identity},
            local_only = True,
        )
    return [DefaultInfo(default_outputs = [rust, cxx])]

conventional_toolchain_probe = rule(
    impl = _impl,
    attrs = {
        "toolchain_identity": attrs.string(),
        "_rust": attrs.default_only(attrs.toolchain_dep(
            default = "toolchains//:rust",
            providers = [RustToolchainInfo],
        )),
        "_cxx": attrs.default_only(attrs.toolchain_dep(
            default = "toolchains//:cxx",
            providers = [CxxToolchainInfo],
        )),
    },
)
