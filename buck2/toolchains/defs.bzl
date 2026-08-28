"""Configured Rust and TypeScript toolchains realized by pinned Nix inputs."""

load(
    "@effect_utils//buck2/platforms:defs.bzl",
    "ProductPlatformInfo",
    "host_execution_constraints",
    "native_execution_constraints",
    "product_platform_constraints",
)

ConfiguredRustToolchainInfo = provider(fields = {
    "archiver": provider_field(RunInfo),
    "compile_env": provider_field(dict[str, str]),
    "compiler": provider_field(RunInfo),
    "identity": provider_field(str),
    "linker": provider_field(RunInfo),
    "target_platform_abi": str,
    "target_platform_architecture": str,
    "target_platform_os": str,
    "target_platform_runtime_contract": str,
    "target_triple": provider_field(str),
})

def host_rust_target_triple():
    """Returns the Rust target triple for the admitted native host."""
    host = host_info()
    if host.os.is_linux and host.arch.is_x86_64:
        return "x86_64-unknown-linux-gnu"
    if host.os.is_linux and host.arch.is_aarch64:
        return "aarch64-unknown-linux-gnu"
    if host.os.is_macos and host.arch.is_aarch64:
        return "aarch64-apple-darwin"
    fail("configured Rust toolchains support only x86_64-linux, aarch64-linux, and aarch64-darwin")

def _configured_rust_toolchain_impl(ctx):
    platform = ctx.attrs.target_platform[ProductPlatformInfo]
    expected_triple = {
        "linux:x86_64:glibc": "x86_64-unknown-linux-gnu",
        "linux:aarch64:glibc": "aarch64-unknown-linux-gnu",
        "darwin:aarch64:darwin": "aarch64-apple-darwin",
    }.get("{}:{}:{}".format(platform.os, platform.architecture, platform.abi))
    if expected_triple == None or ctx.attrs.target_triple != expected_triple:
        fail("configured Rust target triple does not match the product platform")
    if not ctx.attrs.identity:
        fail("configured Rust toolchain identity must not be empty")
    return [
        DefaultInfo(),
        ConfiguredRustToolchainInfo(
            archiver = ctx.attrs.archiver[RunInfo],
            compile_env = ctx.attrs.compile_env,
            compiler = ctx.attrs.compiler[RunInfo],
            identity = ctx.attrs.identity,
            linker = ctx.attrs.linker[RunInfo],
            target_platform_abi = platform.abi,
            target_platform_architecture = platform.architecture,
            target_platform_os = platform.os,
            target_platform_runtime_contract = platform.runtime_contract,
            target_triple = ctx.attrs.target_triple,
        ),
    ]

_configured_rust_toolchain = rule(
    impl = _configured_rust_toolchain_impl,
    attrs = {
        "archiver": attrs.exec_dep(providers = [RunInfo]),
        "compile_env": attrs.dict(key = attrs.string(), value = attrs.string()),
        "compiler": attrs.exec_dep(providers = [RunInfo]),
        "identity": attrs.string(),
        "linker": attrs.exec_dep(providers = [RunInfo]),
        "target_platform": attrs.dep(providers = [ProductPlatformInfo]),
        "target_triple": attrs.string(),
    },
    is_toolchain_rule = True,
)

def configured_rust_toolchain(
        name,
        archiver,
        compile_env,
        compiler,
        identity,
        linker,
        target_platform,
        target_triple,
        **kwargs):
    """Declares a Nix-realized Rust capability for one native platform pair."""
    if "exec_compatible_with" in kwargs or "target_compatible_with" in kwargs:
        fail("configured_rust_toolchain owns target and execution compatibility")
    _configured_rust_toolchain(
        name = name,
        archiver = archiver,
        compile_env = compile_env,
        compiler = compiler,
        identity = identity,
        linker = linker,
        target_platform = target_platform,
        target_triple = target_triple,
        exec_compatible_with = native_execution_constraints(target_platform),
        target_compatible_with = product_platform_constraints(target_platform),
        **kwargs
    )


PnpmMaterializerToolchainInfo = provider(fields = {
    "bun": str,
    "identity": str,
    "pnpm": str,
    "store_dir": str,
})


def _require_nix_store_binary(executable, binary, tool):
    if not executable.startswith("/nix/store/"):
        fail("{} must resolve to an immutable /nix/store executable: {}".format(tool, executable))
    components = executable.split("/")
    if len(components) < 6 or components[-2:] != ["bin", binary]:
        fail("{} executable must have the shape /nix/store/<realization>/bin/{}: {}".format(tool, binary, executable))
    for component in components[3:]:
        if component == "" or component == "." or component == "..":
            fail("{} executable path is not normalized: {}".format(tool, executable))


def _pnpm_materializer_toolchain_impl(ctx):
    _require_nix_store_binary(ctx.attrs.bun, "bun", "Bun")
    _require_nix_store_binary(ctx.attrs.pnpm, "pnpm", "pnpm")
    if not ctx.attrs.store_dir or ctx.attrs.store_dir.startswith("/"):
        fail("pnpm materializer store_dir must be a non-empty project-relative path")
    return [
        DefaultInfo(),
        PnpmMaterializerToolchainInfo(
            bun = ctx.attrs.bun,
            identity = "bun={};pnpm={};store={}".format(ctx.attrs.bun, ctx.attrs.pnpm, ctx.attrs.store_dir),
            pnpm = ctx.attrs.pnpm,
            store_dir = ctx.attrs.store_dir,
        ),
    ]


_pnpm_materializer_toolchain = rule(
    impl = _pnpm_materializer_toolchain_impl,
    attrs = {
        "bun": attrs.string(),
        "pnpm": attrs.string(),
        "store_dir": attrs.string(),
    },
)


def pnpm_materializer_toolchain(name, bun_by_platform, pnpm_by_platform, store_dir, **kwargs):
    """Declares the exact Nix Bun/pnpm pair used by local pnpm deploy actions."""
    if "exec_compatible_with" in kwargs:
        fail("pnpm_materializer_toolchain owns execution compatibility")
    platform = _host_nix_platform()
    bun = bun_by_platform.get(platform)
    pnpm = pnpm_by_platform.get(platform)
    if bun == None or pnpm == None:
        fail("pnpm materializer has no tool realization for {}".format(platform))
    _require_nix_store_binary(bun, "bun", "Bun")
    _require_nix_store_binary(pnpm, "pnpm", "pnpm")
    _pnpm_materializer_toolchain(
        name = name,
        bun = bun,
        pnpm = pnpm,
        store_dir = store_dir,
        exec_compatible_with = host_execution_constraints(),
        **kwargs
    )


EffectTsgoToolchainInfo = provider(fields = {
    "bun": str,
    "executable": str,
    "identity": str,
    "runner": Artifact,
})


def _effect_tsgo_toolchain_impl(ctx):
    _require_nix_store_binary(ctx.attrs.bun, "bun", "Bun")
    _require_nix_store_binary(ctx.attrs.executable, "tsgo", "effect-tsgo")
    return [
        DefaultInfo(),
        EffectTsgoToolchainInfo(
            bun = ctx.attrs.bun,
            executable = ctx.attrs.executable,
            identity = "bun={};tsgo={}".format(ctx.attrs.bun, ctx.attrs.executable),
            runner = ctx.attrs.runner,
        ),
    ]


_effect_tsgo_toolchain = rule(
    impl = _effect_tsgo_toolchain_impl,
    attrs = {
        "bun": attrs.string(),
        "executable": attrs.string(),
        "runner": attrs.source(),
    },
)


def _host_nix_platform():
    host = host_info()
    if host.os.is_linux and host.arch.is_x86_64:
        return "x86_64-linux"
    if host.os.is_linux and host.arch.is_aarch64:
        return "aarch64-linux"
    if host.os.is_macos and host.arch.is_aarch64:
        return "aarch64-darwin"
    fail("configured Nix toolchains support only x86_64-linux, aarch64-linux, and aarch64-darwin")


def effect_tsgo_toolchain(name, bun_by_platform, executable_by_platform, runner, **kwargs):
    """Declares the exact Nix Bun/effect-tsgo pair used by TypeScript actions."""
    if "exec_compatible_with" in kwargs:
        fail("effect_tsgo_toolchain owns execution compatibility")
    platform = _host_nix_platform()
    bun = bun_by_platform.get(platform)
    executable = executable_by_platform.get(platform)
    if bun == None or executable == None:
        fail("effect-tsgo has no tool realization for {}".format(platform))
    _require_nix_store_binary(bun, "bun", "Bun")
    _require_nix_store_binary(executable, "tsgo", "effect-tsgo")
    _effect_tsgo_toolchain(
        name = name,
        bun = bun,
        executable = executable,
        runner = runner,
        exec_compatible_with = host_execution_constraints(),
        **kwargs
    )
