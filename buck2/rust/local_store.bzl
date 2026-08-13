"""Exact Nix-store Rust tools for local-only target probes."""

RustLocalStoreToolchainInfo = provider(fields = [
    "contract",
    "execution_platform",
    "linker",
    "rustc",
    "target_platform",
    "target_triple",
    "toolchain_identity",
])

_CONTRACT = "effect-utils/rust-local-store-toolchain/v1"
_EXECUTION_PLATFORM = "//buck2/platforms:exec_x86_64_linux_local_store"
_TARGET_PLATFORM = "//buck2/platforms:target_x86_64_linux_musl_static"
_TARGET_TRIPLE = "x86_64-unknown-linux-musl"

def _require_nix_store_executable(value, name):
    if not value.startswith("/nix/store/") or "/bin/" not in value:
        fail("{} must be an absolute Nix store executable".format(name))

def _require_toolchain_identity(value):
    if len(value) != 71 or not value.startswith("sha256:"):
        fail("toolchain_identity must be a Nix-authored sha256 identity")

def _rust_local_store_toolchain_impl(ctx):
    _require_nix_store_executable(ctx.attrs.rustc, "rustc")
    _require_nix_store_executable(ctx.attrs.linker, "linker")
    _require_toolchain_identity(ctx.attrs.toolchain_identity)
    if ctx.attrs.contract != _CONTRACT:
        fail("unsupported Rust toolchain contract: {}".format(ctx.attrs.contract))
    if ctx.attrs.execution_platform != _EXECUTION_PLATFORM:
        fail("Rust toolchain execution platform mismatch: {}".format(ctx.attrs.execution_platform))
    if ctx.attrs.target_platform != _TARGET_PLATFORM:
        fail("Rust toolchain target platform mismatch: {}".format(ctx.attrs.target_platform))
    if ctx.attrs.target_triple != _TARGET_TRIPLE:
        fail("the prototype admits only {}".format(_TARGET_TRIPLE))
    return [
        DefaultInfo(),
        RustLocalStoreToolchainInfo(
            contract = ctx.attrs.contract,
            execution_platform = ctx.attrs.execution_platform,
            linker = ctx.attrs.linker,
            rustc = ctx.attrs.rustc,
            target_platform = ctx.attrs.target_platform,
            target_triple = ctx.attrs.target_triple,
            toolchain_identity = ctx.attrs.toolchain_identity,
        ),
    ]

rust_local_store_toolchain = rule(
    impl = _rust_local_store_toolchain_impl,
    attrs = {
        "contract": attrs.string(),
        "execution_platform": attrs.string(),
        "linker": attrs.string(),
        "rustc": attrs.string(),
        "target_platform": attrs.string(),
        "target_triple": attrs.string(),
        "toolchain_identity": attrs.string(),
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
        identifier = "{}-{}".format(toolchain.target_triple, toolchain.toolchain_identity[7:19]),
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
