"""Configured Rust and TypeScript toolchains realized by pinned Nix inputs."""

load("@prelude//go:toolchain.bzl", "GoToolchainInfo", "parse_go_version")
load("@prelude//go_bootstrap:go_bootstrap.bzl", "GoBootstrapToolchainInfo")
load("@prelude//python_bootstrap:python_bootstrap.bzl", "PythonBootstrapToolchainInfo")
load(
    "//buck2/platforms:defs.bzl",
    "admitted_rust_target_triple",
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
    "target_platform_label": str,
    "target_triple": provider_field(str),
})

def host_capability_platform():
    """Returns the projection platform key for the admitted native host.

    This is the same spelling the composition capability resolver keys its
    projection by (`composition-capability-resolver.ts` `executionPlatform`), so
    it indexes `CAPABILITIES` directly. Every capability consumer must use this
    one helper: a second spelling of the macOS key is how a toolchain silently
    misses its realization.
    """
    host = host_info()
    if host.os.is_linux and host.arch.is_x86_64:
        return "x86_64-linux"
    if host.os.is_linux and host.arch.is_aarch64:
        return "aarch64-linux"
    if host.os.is_macos and host.arch.is_aarch64:
        return "aarch64-macos"
    fail("Nix capabilities admit only x86_64-linux, aarch64-linux, and aarch64-macos")

def require_capability(capabilities, generation, platform, tool_id):
    """Returns the projected metadata for one tool, or fails with the reason."""
    platform_capabilities = capabilities.get(platform)
    if platform_capabilities == None:
        fail("generated Buck capabilities do not contain native platform {}".format(platform))
    metadata = platform_capabilities.get(tool_id)
    if metadata == None:
        fail("generated Buck capabilities do not contain {} for {}".format(tool_id, platform))
    for field in ["closureIdentity", "contentDigest", "executableStorePath", "generation"]:
        if not metadata.get(field):
            fail("generated {} capability has no {}".format(tool_id, field))
    if metadata["generation"] != generation:
        fail("generated {} capability belongs to a stale generation".format(tool_id))
    executable = metadata["executableStorePath"]
    if not executable.startswith("/nix/store/") or "/bin/" not in executable:
        fail("generated {} capability is not an immutable Nix executable: {}".format(tool_id, executable))
    if not metadata["closureIdentity"].startswith("/nix/store/"):
        fail("generated {} capability has a non-Nix closure identity".format(tool_id))
    if len(metadata["contentDigest"]) != 64:
        fail("generated {} capability has an invalid content digest".format(tool_id))
    return metadata

def host_rust_target_triple():
    """Returns the Rust target triple for the admitted native host."""
    host = host_info()
    if host.os.is_linux and host.arch.is_x86_64:
        return admitted_rust_target_triple("linux", "x86_64", "glibc", "elf-dynamic/v1")
    if host.os.is_linux and host.arch.is_aarch64:
        return admitted_rust_target_triple("linux", "aarch64", "glibc", "elf-dynamic/v1")
    if host.os.is_macos and host.arch.is_aarch64:
        return admitted_rust_target_triple("darwin", "aarch64", "darwin", "mach-o-dynamic/v1")
    fail("configured Rust toolchains support only x86_64-linux, aarch64-linux, and aarch64-darwin")

def _configured_rust_toolchain_impl(ctx):
    platform = ctx.attrs.target_platform[ProductPlatformInfo]
    if ctx.attrs.target_triple != platform.rust_target_triple:
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
            target_platform_label = str(ctx.attrs.target_platform.label.raw_target()),
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


BunToolchainInfo = provider(fields = {
    "executable": str,
    "identity": str,
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


def _nix_python_bootstrap_toolchain_impl(ctx):
    _require_nix_store_binary(ctx.attrs.interpreter, "python3", "Python bootstrap")
    return [
        DefaultInfo(),
        PythonBootstrapToolchainInfo(interpreter = ctx.attrs.interpreter),
    ]


_nix_python_bootstrap_toolchain = rule(
    impl = _nix_python_bootstrap_toolchain_impl,
    attrs = {
        "interpreter": attrs.string(),
    },
    is_toolchain_rule = True,
)


def nix_python_bootstrap_toolchain(name, capabilities, generation, **kwargs):
    """Declares the exact Nix interpreter prelude's bootstrap scripts run under.

    Prelude's own Rust rules pull bootstrap-interpreter targets in
    (`@prelude//rust/tools:transitive_dependency_symlinks`), and prelude's ambient
    `system_...` bootstrap toolchain resolves the interpreter by bare basename off the
    ambient PATH. That is the one non-hermetic term the whole Rust graph would otherwise
    carry, so the interpreter comes from the same projected capability set as every other
    tool.

    [Decision 0028](../../context/buck2/.decisions/0028-hermetic-python-bootstrap-for-consumer-cells.md)
    admits exactly this realization; `buck2-no-python-actions.test.sh` holds the boundary.
    """
    if "exec_compatible_with" in kwargs:
        fail("nix_python_bootstrap_toolchain owns execution compatibility")
    platform = host_capability_platform()
    interpreter = require_capability(
        capabilities,
        generation,
        platform,
        "python-bootstrap",
    )["executableStorePath"]
    _require_nix_store_binary(interpreter, "python3", "Python bootstrap")
    _nix_python_bootstrap_toolchain(
        name = name,
        interpreter = interpreter,
        exec_compatible_with = host_execution_constraints(),
        **kwargs
    )


def _bun_toolchain_impl(ctx):
    _require_nix_store_binary(ctx.attrs.executable, "bun", "Bun")
    return [
        DefaultInfo(),
        BunToolchainInfo(
            executable = ctx.attrs.executable,
            identity = ctx.attrs.executable,
        ),
    ]


_bun_toolchain = rule(
    impl = _bun_toolchain_impl,
    attrs = {
        "executable": attrs.string(),
    },
)


def bun_toolchain(name, capabilities, generation, **kwargs):
    """Declares the exact Nix Bun executable used by JavaScript actions."""
    if "exec_compatible_with" in kwargs:
        fail("bun_toolchain owns execution compatibility")
    platform = host_capability_platform()
    executable = require_capability(capabilities, generation, platform, "bun")["executableStorePath"]
    _require_nix_store_binary(executable, "bun", "Bun")
    _bun_toolchain(
        name = name,
        executable = executable,
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


def effect_tsgo_toolchain(name, capabilities, generation, runner, **kwargs):
    """Declares the exact Nix Bun/effect-tsgo pair used by TypeScript actions."""
    if "exec_compatible_with" in kwargs:
        fail("effect_tsgo_toolchain owns execution compatibility")
    platform = host_capability_platform()
    bun = require_capability(capabilities, generation, platform, "bun")["executableStorePath"]
    executable = require_capability(
        capabilities,
        generation,
        platform,
        "effect-tsgo",
    )["executableStorePath"]
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


def _nix_go_bootstrap_toolchain_impl(ctx):
    _require_nix_store_binary(ctx.attrs.go, "go", "Go")
    return [
        DefaultInfo(),
        GoBootstrapToolchainInfo(
            env_go_arch = ctx.attrs.env_go_arch,
            env_go_os = ctx.attrs.env_go_os,
            # `go` locates its own GOROOT relative to the realized executable, and
            # the capability resolver already realpath'd it, so declaring GOROOT
            # would only restate what the store path says.
            env_go_root = None,
            go = RunInfo(args = [ctx.attrs.go]),
            go_wrapper = ctx.attrs.go_wrapper[RunInfo],
        ),
    ]


_nix_go_bootstrap_toolchain = rule(
    impl = _nix_go_bootstrap_toolchain_impl,
    attrs = {
        "env_go_arch": attrs.string(),
        "env_go_os": attrs.string(),
        "go": attrs.string(),
        "go_wrapper": attrs.exec_dep(providers = [RunInfo], default = "prelude//go_bootstrap/tools:go_wrapper_py"),
    },
    is_toolchain_rule = True,
)


def go_platform_pair():
    """Returns the (GOOS, GOARCH) pair for the admitted native host."""
    host = host_info()
    if host.os.is_linux and host.arch.is_x86_64:
        return ("linux", "amd64")
    if host.os.is_linux and host.arch.is_aarch64:
        return ("linux", "arm64")
    if host.os.is_macos and host.arch.is_aarch64:
        return ("darwin", "arm64")
    fail("Go toolchains support only x86_64-linux, aarch64-linux, and aarch64-darwin")


def nix_go_bootstrap_toolchain(name, capabilities, generation, **kwargs):
    """Declares the exact Nix Go distribution every Go action compiles with.

    This is prelude's `GoBootstrapToolchainInfo`, i.e. the `go build` driver rather
    than the per-package compile/link graph. Upstream's
    `system_go_bootstrap_toolchain` resolves the bare name `go` off the ambient
    PATH; the capability projection makes it an immutable store realization that is
    part of every Go action's key.
    """
    if "exec_compatible_with" in kwargs:
        fail("nix_go_bootstrap_toolchain owns execution compatibility")
    platform = host_capability_platform()
    go = require_capability(capabilities, generation, platform, "go")["executableStorePath"]
    _require_nix_store_binary(go, "go", "Go")
    go_os, go_arch = go_platform_pair()
    _nix_go_bootstrap_toolchain(
        name = name,
        env_go_arch = go_arch,
        env_go_os = go_os,
        go = go,
        exec_compatible_with = host_execution_constraints(),
        **kwargs
    )


def _goroot_from_executable(executable):
    """Derives GOROOT from the realized `go` executable.

    A Go distribution always keeps `bin/go` inside GOROOT, and the capability
    resolver realpath's the executable, so this is the store path's own statement
    about its GOROOT rather than an out-of-band pin.
    """
    suffix = "/bin/go"
    if not executable.endswith(suffix):
        fail("Go executable must live in <goroot>/bin/go: {}".format(executable))
    return executable[:-len(suffix)]


def _nix_go_toolchain_impl(ctx):
    go_os, go_arch = ctx.attrs.env_go_os, ctx.attrs.env_go_arch
    goroot = ctx.actions.declare_output("goroot", dir = True)
    ctx.actions.run(
        cmd_args([
            ctx.attrs.copy_goroot[RunInfo],
            ctx.attrs.goroot_store_path,
            goroot.as_output(),
        ]),
        category = "go_copy_goroot",
        local_only = True,
    )
    tool_prefix = "pkg/tool/{}_{}".format(go_os, go_arch)
    go = RunInfo(args = [ctx.attrs.go])
    return [
        DefaultInfo(sub_targets = {"go": [go]}),
        GoToolchainInfo(
            assembler = RunInfo(args = [ctx.attrs.goroot_store_path + "/" + tool_prefix + "/asm"]),
            assembler_flags = [],
            cgo = RunInfo(args = [ctx.attrs.goroot_store_path + "/" + tool_prefix + "/cgo"]),
            compiler = RunInfo(args = [ctx.attrs.goroot_store_path + "/" + tool_prefix + "/compile"]),
            compiler_flags = [],
            cover = RunInfo(args = [ctx.attrs.goroot_store_path + "/" + tool_prefix + "/cover"]),
            cxx_compiler_flags = [],
            env_go_arch = go_arch,
            env_go_os = go_os,
            env_go_root = goroot,
            external_linker_flags = [],
            gen_embedcfg = ctx.attrs.gen_embedcfg[RunInfo],
            go = go,
            go_wrapper = ctx.attrs.go_wrapper[RunInfo],
            linker = RunInfo(args = [ctx.attrs.goroot_store_path + "/" + tool_prefix + "/link"]),
            linker_flags = [],
            # Modern Go distributions ship no `pkg/tool/*/pack` binary (`go tool pack`
            # is a subcommand of `go` itself), so prelude compiles `cmd/pack` from the
            # distribution's own sources with the bootstrap toolchain.
            packer = ctx.attrs.tool_pack[RunInfo],
            pkg_analyzer = ctx.attrs.pkg_analyzer[RunInfo],
            build_tags = ctx.attrs.build_tags,
            version = parse_go_version(ctx.attrs.version),
        ),
    ]


_nix_go_toolchain = rule(
    impl = _nix_go_toolchain_impl,
    attrs = {
        "build_tags": attrs.list(attrs.string(), default = []),
        "copy_goroot": attrs.exec_dep(providers = [RunInfo]),
        "env_go_arch": attrs.string(),
        "env_go_os": attrs.string(),
        "gen_embedcfg": attrs.exec_dep(providers = [RunInfo], default = "prelude//go/tools:gen_embedcfg"),
        "go": attrs.string(),
        "go_wrapper": attrs.exec_dep(providers = [RunInfo], default = "prelude//go/tools:go_wrapper"),
        "goroot_store_path": attrs.string(),
        "pkg_analyzer": attrs.exec_dep(providers = [RunInfo], default = "prelude//go/tools:pkg_analyzer"),
        "tool_pack": attrs.exec_dep(providers = [RunInfo], default = "prelude//go/tools:tool_pack"),
        "version": attrs.string(),
    },
    is_toolchain_rule = True,
)


def nix_go_toolchain(name, capabilities, generation, copy_goroot, version, **kwargs):
    """Declares the full prelude Go graph's toolchain (`go_library`/`go_binary`).

    Costly, and honest about why: `prelude//go:go_stdlib.bzl` needs GOROOT as a
    Buck `Artifact` so it can project stdlib sources, so this toolchain copies the
    Nix Go distribution into `buck-out` once. Members that only need a product
    binary should use `buck2/go/defs.bzl:go_vendored_binary`, which drives
    `go build` and needs no GOROOT artifact at all.
    """
    if "exec_compatible_with" in kwargs:
        fail("nix_go_toolchain owns execution compatibility")
    platform = host_capability_platform()
    go = require_capability(capabilities, generation, platform, "go")["executableStorePath"]
    _require_nix_store_binary(go, "go", "Go")
    go_os, go_arch = go_platform_pair()
    _nix_go_toolchain(
        name = name,
        copy_goroot = copy_goroot,
        env_go_arch = go_arch,
        env_go_os = go_os,
        go = go,
        goroot_store_path = _goroot_from_executable(go),
        version = version,
        exec_compatible_with = host_execution_constraints(),
        **kwargs
    )
