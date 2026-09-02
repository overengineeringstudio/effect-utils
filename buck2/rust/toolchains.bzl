"""Exact Nix-capability-backed Prelude Rust and C/C++ toolchains."""

load(
    "//buck2/platforms:defs.bzl",
    "ProductPlatformInfo",
    "admitted_rust_target_triple",
    "native_execution_constraints",
    "product_platform_constraints",
)
load(
    "//buck2/toolchains:defs.bzl",
    "ConfiguredRustToolchainInfo",
    "host_capability_platform",
    "host_rust_target_triple",
    "require_capability",
)
load(
    "@prelude//cxx:cxx_toolchain_types.bzl",
    "BinaryUtilitiesInfo",
    "CCompilerInfo",
    "CxxCompilerInfo",
    "CxxInternalTools",
    "DepTrackingMode",
    "LinkerInfo",
    "LinkerType",
    "PicBehavior",
    "ShlibInterfacesMode",
    "cxx_toolchain_infos",
)
load("@prelude//cxx:headers.bzl", "HeaderMode")
load("@prelude//linking:link_info.bzl", "LinkStyle")
load("@prelude//linking:lto.bzl", "LtoMode")
load("@prelude//rust:rust_toolchain.bzl", "PanicRuntime", "RustToolchainInfo")

_TOOL_IDS = [
    "rust-archiver",
    "rust-c-compiler",
    "rust-dwp",
    "rust-clippy-driver",
    "rust-compiler",
    "rust-cxx-compiler",
    "rust-linker",
    "rust-rustdoc",
    "rust-nm",
    "rust-objcopy",
    "rust-objdump",
    "rust-ranlib",
    "rust-strip",
    "rust-shell",
]


def _toolchain_identity(platform, target_platform, target_triple, metadata):
    fields = [
        "contract=effect-utils/buck2-rust-toolchain/v1",
        "execution_platform=" + platform,
        "target_platform=" + target_platform,
        "target_triple=" + target_triple,
    ]
    for tool_id in _TOOL_IDS:
        tool = metadata[tool_id]
        fields.append("{}={}:{}".format(tool_id, tool["closureIdentity"], tool["contentDigest"]))
    return ";".join(fields)


def _checked_platform(ctx):
    platform = ctx.attrs.target_platform[ProductPlatformInfo]
    admitted_triple = admitted_rust_target_triple(
        platform.os,
        platform.architecture,
        platform.abi,
        platform.runtime_contract,
    )
    if ctx.attrs.target_triple != admitted_triple:
        fail("native Rust toolchain target triple does not match its admitted native pair")
    if ctx.attrs.target_triple != platform.rust_target_triple:
        fail("native Rust toolchain target triple does not match ProductPlatformInfo")
    return platform


def _native_rust_toolchain_impl(ctx):
    platform = _checked_platform(ctx)
    if not ctx.attrs.identity:
        fail("native Rust toolchain identity must not be empty")
    return [
        DefaultInfo(),
        ConfiguredRustToolchainInfo(
            archiver = RunInfo(args = [ctx.attrs.archiver]),
            compile_env = ctx.attrs.compile_env,
            compiler = RunInfo(args = [ctx.attrs.compiler]),
            identity = ctx.attrs.identity,
            linker = RunInfo(args = [ctx.attrs.linker]),
            target_platform_abi = platform.abi,
            target_platform_architecture = platform.architecture,
            target_platform_label = str(ctx.attrs.target_platform.label.raw_target()),
            target_platform_os = platform.os,
            target_platform_runtime_contract = platform.runtime_contract,
            target_triple = ctx.attrs.target_triple,
        ),
        RustToolchainInfo(
            clippy_driver = RunInfo(args = [ctx.attrs.clippy_driver]),
            compiler = RunInfo(args = [ctx.attrs.compiler]),
            default_edition = "2021",
            doctests = False,
            nightly_features = False,
            panic_runtime = PanicRuntime("unwind"),
            rustc_env = ctx.attrs.compile_env,
            rustc_target_triple = ctx.attrs.target_triple,
            rustdoc = RunInfo(args = [ctx.attrs.rustdoc]),
            rustdoc_env = ctx.attrs.compile_env,
        ),
    ]


_native_rust_toolchain = rule(
    impl = _native_rust_toolchain_impl,
    attrs = {
        "archiver": attrs.string(),
        "clippy_driver": attrs.string(),
        "compile_env": attrs.dict(key = attrs.string(), value = attrs.string()),
        "compiler": attrs.string(),
        "identity": attrs.string(),
        "linker": attrs.string(),
        "rustdoc": attrs.string(),
        "target_platform": attrs.dep(providers = [ProductPlatformInfo]),
        "target_triple": attrs.string(),
    },
    is_toolchain_rule = True,
)


def _compiler_info(provider, compiler, compiler_type):
    return provider(
        compiler = RunInfo(args = [compiler]),
        compiler_flags = [],
        compiler_type = compiler_type,
        preprocessor_flags = [],
        supports_content_based_paths = False,
        supports_two_phase_compilation = False,
    )


def _native_cxx_toolchain_impl(ctx):
    platform = _checked_platform(ctx)
    is_darwin = platform.os == "darwin"
    compiler_type = "clang" if is_darwin else "gcc"
    linker = LinkerInfo(
        archiver = RunInfo(args = [ctx.attrs.archiver]),
        archiver_supports_argfiles = not is_darwin,
        archiver_type = "gnu",
        archive_objects_locally = True,
        binary_extension = "",
        generate_linker_maps = False,
        link_binaries_locally = True,
        link_libraries_locally = True,
        link_style = LinkStyle("shared"),
        linker = RunInfo(args = [ctx.attrs.linker]),
        linker_flags = [],
        lto_mode = LtoMode("none"),
        object_file_extension = "o",
        shared_dep_runtime_ld_flags = [],
        shared_library_name_default_prefix = "lib",
        shared_library_name_format = "{}.dylib" if is_darwin else "{}.so",
        shared_library_versioned_name_format = "{}.{}.dylib" if is_darwin else "{}.so.{}",
        shlib_interfaces = ShlibInterfacesMode("disabled"),
        static_dep_runtime_ld_flags = [],
        static_library_extension = "a",
        static_pic_dep_runtime_ld_flags = [],
        type = LinkerType("darwin" if is_darwin else "gnu"),
        use_archiver_flags = True,
    )
    return [DefaultInfo()] + cxx_toolchain_infos(
        platform_name = ctx.attrs.target_triple,
        c_compiler_info = _compiler_info(CCompilerInfo, ctx.attrs.c_compiler, compiler_type),
        cxx_compiler_info = _compiler_info(CxxCompilerInfo, ctx.attrs.cxx_compiler, compiler_type),
        linker_info = linker,
        binary_utilities_info = BinaryUtilitiesInfo(
            dwp = RunInfo(args = [ctx.attrs.dwp]),
            nm = RunInfo(args = [ctx.attrs.nm]),
            objcopy = RunInfo(args = [ctx.attrs.objcopy]),
            objdump = RunInfo(args = [ctx.attrs.objdump]),
            ranlib = RunInfo(args = [ctx.attrs.ranlib]),
            strip = RunInfo(args = [ctx.attrs.strip]),
        ),
        header_mode = HeaderMode("symlink_tree_only"),
        internal_tools = ctx.attrs.internal_tools[CxxInternalTools],
        cpp_dep_tracking_mode = DepTrackingMode("show_headers" if is_darwin else "makefile"),
        pic_behavior = PicBehavior("always_enabled" if is_darwin else "supported"),
        use_dep_files = True,
    )


_native_cxx_toolchain = rule(
    impl = _native_cxx_toolchain_impl,
    attrs = {
        "archiver": attrs.string(),
        "c_compiler": attrs.string(),
        "cxx_compiler": attrs.string(),
        "internal_tools": attrs.default_only(attrs.exec_dep(
            default = "prelude//cxx/tools:internal_tools",
            providers = [CxxInternalTools],
        )),
        "dwp": attrs.string(),
        "nm": attrs.string(),
        "objcopy": attrs.string(),
        "objdump": attrs.string(),
        "ranlib": attrs.string(),
        "strip": attrs.string(),
        "linker": attrs.string(),
        "target_platform": attrs.dep(providers = [ProductPlatformInfo]),
        "target_triple": attrs.string(),
    },
    is_toolchain_rule = True,
)


def _portable_link_env(target_triple):
    if target_triple == "x86_64-unknown-linux-gnu":
        return {
            "NIX_DONT_SET_RPATH_x86_64_unknown_linux_gnu": "1",
            "NIX_LDFLAGS_x86_64_unknown_linux_gnu": "-dynamic-linker /lib64/ld-linux-x86-64.so.2",
        }
    if target_triple == "aarch64-unknown-linux-gnu":
        return {
            "NIX_DONT_SET_RPATH_aarch64_unknown_linux_gnu": "1",
            "NIX_LDFLAGS_aarch64_unknown_linux_gnu": "-dynamic-linker /lib/ld-linux-aarch64.so.1",
        }
    if target_triple == "aarch64-apple-darwin":
        return {}
    fail("native Rust toolchain has no portable link environment for {}".format(target_triple))

def _compile_env(metadata, target_triple):
    result = {
        "AR": metadata["rust-archiver"]["executableStorePath"],
        "CC": metadata["rust-c-compiler"]["executableStorePath"],
        "CXX": metadata["rust-cxx-compiler"]["executableStorePath"],
        "LD": metadata["rust-linker"]["executableStorePath"],
        "PATH": metadata["rust-shell"]["executableStorePath"].removesuffix("/bash"),
    }
    result.update(_portable_link_env(target_triple))
    return result



def native_rust_toolchains(capabilities, generation, target_platform):
    """Declares conventional `//buck2/toolchains:rust` and `:cxx` for the native pair."""
    capability_platform = host_capability_platform()
    metadata = {}
    for tool_id in _TOOL_IDS:
        metadata[tool_id] = require_capability(
            capabilities,
            generation,
            capability_platform,
            tool_id,
        )
    target_triple = host_rust_target_triple()
    identity = _toolchain_identity(
        capability_platform,
        target_platform,
        target_triple,
        metadata,
    )
    compatibility = {
        "exec_compatible_with": native_execution_constraints(target_platform),
        "target_compatible_with": product_platform_constraints(target_platform),
        "visibility": ["PUBLIC"],
    }
    _native_cxx_toolchain(
        name = "cxx",
        archiver = metadata["rust-archiver"]["executableStorePath"],
        c_compiler = metadata["rust-c-compiler"]["executableStorePath"],
        cxx_compiler = metadata["rust-cxx-compiler"]["executableStorePath"],
        dwp = metadata["rust-dwp"]["executableStorePath"],
        nm = metadata["rust-nm"]["executableStorePath"],
        objcopy = metadata["rust-objcopy"]["executableStorePath"],
        objdump = metadata["rust-objdump"]["executableStorePath"],
        ranlib = metadata["rust-ranlib"]["executableStorePath"],
        strip = metadata["rust-strip"]["executableStorePath"],
        linker = metadata["rust-linker"]["executableStorePath"],
        target_platform = target_platform,
        target_triple = target_triple,
        **compatibility
    )
    _native_rust_toolchain(
        name = "rust",
        archiver = metadata["rust-archiver"]["executableStorePath"],
        clippy_driver = metadata["rust-clippy-driver"]["executableStorePath"],
        compile_env = _compile_env(metadata, target_triple),
        compiler = metadata["rust-compiler"]["executableStorePath"],
        identity = identity,
        linker = metadata["rust-linker"]["executableStorePath"],
        rustdoc = metadata["rust-rustdoc"]["executableStorePath"],
        target_platform = target_platform,
        target_triple = target_triple,
        **compatibility
    )
