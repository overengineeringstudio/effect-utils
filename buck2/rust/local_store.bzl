"""Exact Nix-store Rust tools for local-only target probes."""

RustLocalStoreToolchainInfo = provider(fields = [
    "ar",
    "cc",
    "clippy_driver",
    "contract",
    "cxx",
    "dwp",
    "execution_platform",
    "identity_verifier",
    "linker",
    "nm",
    "objcopy",
    "objdump",
    "python",
    "ranlib",
    "rustc",
    "rustdoc",
    "strip",
    "target_platform",
    "target_triple",
    "tool_path",
    "compile_identity",
    "compile_identity_material",
    "config_integrity_identity",
    "config_integrity_material",
])

_CONTRACT = "effect-utils/rust-local-store-toolchain/v1"
_EXECUTION_PLATFORM = "//buck2/platforms:exec_x86_64_linux_local_store"
_TARGET_PLATFORM = "//buck2/platforms:target_x86_64_linux_musl_static"
_TARGET_TRIPLE = "x86_64-unknown-linux-musl"

def _require_nix_store_executable(value, name):
    if not value.startswith("/nix/store/") or "/bin/" not in value:
        fail("{} must be an absolute Nix store executable".format(name))

def _require_identity(value, name):
    if len(value) != 71 or not value.startswith("sha256:"):
        fail("{} must be a Nix-authored sha256 identity".format(name))

def _require_nix_tool_path(value):
    if not value:
        fail("tool_path must be a non-empty list of immutable Nix store paths")
    for path in value.split(":"):
        if not path.startswith("/nix/store/") or not path.endswith("/bin"):
            fail("tool_path entry must be an immutable Nix store bin directory: {}".format(path))

def _config_integrity_material(ctx):
    return ";".join([
        "ar=" + ctx.attrs.ar,
        "cc=" + ctx.attrs.cc,
        "clippy_driver=" + ctx.attrs.clippy_driver,
        "contract=" + ctx.attrs.contract,
        "cxx=" + ctx.attrs.cxx,
        "dwp=" + ctx.attrs.dwp,
        "execution_platform=" + ctx.attrs.execution_platform,
        "identity_verifier=" + ctx.attrs.identity_verifier,
        "linker=" + ctx.attrs.linker,
        "nm=" + ctx.attrs.nm,
        "objcopy=" + ctx.attrs.objcopy,
        "objdump=" + ctx.attrs.objdump,
        "python=" + ctx.attrs.python,
        "ranlib=" + ctx.attrs.ranlib,
        "rustc=" + ctx.attrs.rustc,
        "rustdoc=" + ctx.attrs.rustdoc,
        "strip=" + ctx.attrs.strip,
        "target_platform=" + ctx.attrs.target_platform,
        "target_triple=" + ctx.attrs.target_triple,
        "tool_path=" + ctx.attrs.tool_path,
    ])

def _compile_identity_material(ctx):
    return ";".join([
        "ar=" + ctx.attrs.ar,
        "cc=" + ctx.attrs.cc,
        "contract=" + ctx.attrs.contract,
        "cxx=" + ctx.attrs.cxx,
        "execution_platform=" + ctx.attrs.execution_platform,
        "linker=" + ctx.attrs.linker,
        "rustc=" + ctx.attrs.rustc,
        "target_platform=" + ctx.attrs.target_platform,
        "target_triple=" + ctx.attrs.target_triple,
        "tool_path=" + ctx.attrs.tool_path,
    ])

def _rust_local_store_toolchain_impl(ctx):
    for name, executable in [
        ("ar", ctx.attrs.ar),
        ("cc", ctx.attrs.cc),
        ("clippy_driver", ctx.attrs.clippy_driver),
        ("cxx", ctx.attrs.cxx),
        ("dwp", ctx.attrs.dwp),
        ("identity_verifier", ctx.attrs.identity_verifier),
        ("linker", ctx.attrs.linker),
        ("nm", ctx.attrs.nm),
        ("objcopy", ctx.attrs.objcopy),
        ("objdump", ctx.attrs.objdump),
        ("python", ctx.attrs.python),
        ("ranlib", ctx.attrs.ranlib),
        ("rustc", ctx.attrs.rustc),
        ("rustdoc", ctx.attrs.rustdoc),
        ("strip", ctx.attrs.strip),
    ]:
        _require_nix_store_executable(executable, name)
    _require_nix_tool_path(ctx.attrs.tool_path)
    _require_identity(ctx.attrs.config_integrity_identity, "config_integrity_identity")
    _require_identity(ctx.attrs.compile_identity, "compile_identity")
    if ctx.attrs.config_integrity_material != _config_integrity_material(ctx):
        fail("Rust config-integrity material does not match the configured fields")
    if ctx.attrs.compile_identity_material != _compile_identity_material(ctx):
        fail("Rust compile-identity material does not match the configured fields")
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
            ar = ctx.attrs.ar,
            cc = ctx.attrs.cc,
            clippy_driver = ctx.attrs.clippy_driver,
            contract = ctx.attrs.contract,
            cxx = ctx.attrs.cxx,
            dwp = ctx.attrs.dwp,
            execution_platform = ctx.attrs.execution_platform,
            identity_verifier = ctx.attrs.identity_verifier,
            linker = ctx.attrs.linker,
            nm = ctx.attrs.nm,
            objcopy = ctx.attrs.objcopy,
            objdump = ctx.attrs.objdump,
            python = ctx.attrs.python,
            ranlib = ctx.attrs.ranlib,
            rustc = ctx.attrs.rustc,
            rustdoc = ctx.attrs.rustdoc,
            strip = ctx.attrs.strip,
            target_platform = ctx.attrs.target_platform,
            target_triple = ctx.attrs.target_triple,
            tool_path = ctx.attrs.tool_path,
            compile_identity = ctx.attrs.compile_identity,
            compile_identity_material = ctx.attrs.compile_identity_material,
            config_integrity_identity = ctx.attrs.config_integrity_identity,
            config_integrity_material = ctx.attrs.config_integrity_material,
        ),
    ]

rust_local_store_toolchain = rule(
    impl = _rust_local_store_toolchain_impl,
    attrs = {
        "ar": attrs.string(),
        "cc": attrs.string(),
        "clippy_driver": attrs.string(),
        "contract": attrs.string(),
        "cxx": attrs.string(),
        "dwp": attrs.string(),
        "execution_platform": attrs.string(),
        "identity_verifier": attrs.string(),
        "linker": attrs.string(),
        "nm": attrs.string(),
        "objcopy": attrs.string(),
        "objdump": attrs.string(),
        "python": attrs.string(),
        "ranlib": attrs.string(),
        "rustc": attrs.string(),
        "rustdoc": attrs.string(),
        "strip": attrs.string(),
        "target_platform": attrs.string(),
        "target_triple": attrs.string(),
        "tool_path": attrs.string(),
        "compile_identity": attrs.string(),
        "compile_identity_material": attrs.string(),
        "config_integrity_identity": attrs.string(),
        "config_integrity_material": attrs.string(),
    },
)

def _config_integrity_impl(ctx):
    toolchain = ctx.attrs.toolchain[RustLocalStoreToolchainInfo]
    out = ctx.actions.declare_output("config-integrity.txt")
    ctx.actions.run(
        [
            toolchain.identity_verifier,
            toolchain.config_integrity_material,
            toolchain.config_integrity_identity,
            "--stamp",
            out.as_output(),
        ],
        category = "rust_toolchain_config_integrity",
        env = {"PATH": "/nonexistent"},
        identifier = toolchain.config_integrity_identity[7:19],
        local_only = True,
    )
    return [DefaultInfo(default_output = out)]

rust_toolchain_config_integrity = rule(
    impl = _config_integrity_impl,
    attrs = {
        "toolchain": attrs.exec_dep(providers = [RustLocalStoreToolchainInfo]),
    },
)

def _rust_static_binary_impl(ctx):
    toolchain = ctx.attrs.toolchain[RustLocalStoreToolchainInfo]
    out = ctx.actions.declare_output(ctx.attrs.binary_name)
    ctx.actions.run(
        [
            toolchain.identity_verifier,
            toolchain.compile_identity_material,
            toolchain.compile_identity,
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
        identifier = "{}-{}".format(toolchain.target_triple, toolchain.compile_identity[7:19]),
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
