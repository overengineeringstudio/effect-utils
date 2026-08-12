"""Exact Nix-store Rust tools for local-only target probes."""

RustLocalStoreToolchainInfo = provider(fields = [
    "execution_platform",
    "linker",
    "rustc",
    "target_triple",
])

def _require_nix_store_executable(value, name):
    if not value.startswith("/nix/store/") or "/bin/" not in value:
        fail("{} must be an absolute Nix store executable".format(name))

def _rust_local_store_toolchain_impl(ctx):
    _require_nix_store_executable(ctx.attrs.rustc, "rustc")
    _require_nix_store_executable(ctx.attrs.linker, "linker")
    if ctx.attrs.target_triple != "x86_64-unknown-linux-musl":
        fail("the prototype admits only x86_64-unknown-linux-musl")
    return [
        DefaultInfo(),
        RustLocalStoreToolchainInfo(
            execution_platform = "x86_64-linux-local-store",
            linker = ctx.attrs.linker,
            rustc = ctx.attrs.rustc,
            target_triple = ctx.attrs.target_triple,
        ),
    ]

rust_local_store_toolchain = rule(
    impl = _rust_local_store_toolchain_impl,
    attrs = {
        "linker": attrs.string(),
        "rustc": attrs.string(),
        "target_triple": attrs.string(),
    },
)

def _rust_static_binary_impl(ctx):
    toolchain = ctx.attrs.toolchain[RustLocalStoreToolchainInfo]
    out = ctx.actions.declare_output(ctx.attrs.binary_name)
    ctx.actions.run(
        [
            toolchain.rustc,
            ctx.attrs.src,
            "--crate-name",
            ctx.attrs.crate_name,
            "--edition=2024",
            "--target",
            toolchain.target_triple,
            "-C",
            "linker=" + toolchain.linker,
            "-C",
            "target-feature=+crt-static",
            "-C",
            "opt-level=2",
            "-C",
            "strip=symbols",
            "-o",
            out.as_output(),
        ],
        category = "rust_compile",
        env = {"PATH": "/nonexistent"},
        identifier = toolchain.target_triple,
        local_only = True,
    )
    return [DefaultInfo(default_output = out), RunInfo(args = cmd_args(out))]

rust_static_binary = rule(
    impl = _rust_static_binary_impl,
    attrs = {
        "binary_name": attrs.string(),
        "crate_name": attrs.string(),
        "src": attrs.source(),
        "toolchain": attrs.exec_dep(providers = [RustLocalStoreToolchainInfo]),
    },
)
