"""Exact Nix-capability-backed Prelude native and wasm Rust toolchains."""

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
load(
    "//buck2/platforms:defs.bzl",
    "ProductPlatformInfo",
    "admitted_rust_target_triple",
    "cache_guarded_rule",
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

_WASM_TOOL_IDS = ["rust-wasm-compiler", "rust-wasm-rustdoc", "rust-wasm-linker"]

WASM_BINDGEN_VERSION = "0.2.127"
WASM_OPT_FLAGS = [
    "-Oz",
    "--enable-bulk-memory",
    "--enable-nontrapping-float-to-int",
    "--enable-sign-ext",
    "--enable-multivalue",
    "--enable-reference-types",
    "--enable-mutable-globals",
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
    if ctx.attrs.target_triple == "wasm32-unknown-unknown":
        return platform
    admitted_triple = admitted_rust_target_triple(
        platform.os,
        platform.architecture,
        platform.abi,
        platform.runtime_contract,
    )
    if ctx.attrs.target_triple != admitted_triple:
        fail("Rust toolchain target triple does not match its admitted native pair")
    if ctx.attrs.target_triple != platform.rust_target_triple:
        fail("Rust toolchain target triple does not match ProductPlatformInfo")
    return platform

def _release_flags():
    settings = {
        "opt_level": read_config("rust_profile", "opt_level", "3"),
        "debug": read_config("rust_profile", "debug", "0"),
        "lto": read_config("rust_profile", "lto", "local"),
        "codegen_units": read_config("rust_profile", "codegen_units", "16"),
        "panic": read_config("rust_profile", "panic", "unwind"),
        "strip": read_config("rust_profile", "strip", "none"),
        "debug_assertions": read_config("rust_profile", "debug_assertions", "no"),
        "overflow_checks": read_config("rust_profile", "overflow_checks", "no"),
    }
    allowed = {
        "opt_level": ["0", "1", "2", "3", "s", "z"],
        "debug": ["0", "1", "2", "line-directives-only", "line-tables-only", "limited", "full", "none"],
        "lto": ["local", "off", "thin", "fat"],
        "panic": ["unwind", "abort"],
        "strip": ["none", "debuginfo", "symbols"],
        "debug_assertions": ["yes", "no"],
        "overflow_checks": ["yes", "no"],
    }
    for name, choices in allowed.items():
        if settings[name] not in choices:
            fail("invalid rust_profile.{}: {}".format(name, settings[name]))
    if not settings["codegen_units"].isdigit() or int(settings["codegen_units"]) < 1:
        fail("rust_profile.codegen_units must be a positive integer")
    return [
        "-Copt-level=" + settings["opt_level"],
        "-Cdebuginfo=" + settings["debug"],
        "-Ccodegen-units=" + settings["codegen_units"],
        "-Cpanic=" + settings["panic"],
        "-Cstrip=" + settings["strip"],
        "-Cdebug-assertions=" + settings["debug_assertions"],
        "-Coverflow-checks=" + settings["overflow_checks"],
    ]

def _rust_toolchain_impl(ctx):
    platform = _checked_platform(ctx)
    if not ctx.attrs.identity:
        fail("Rust toolchain identity must not be empty")
    wasm = ctx.attrs.target_triple == "wasm32-unknown-unknown"
    providers = [DefaultInfo()]
    if not wasm:
        providers.append(ConfiguredRustToolchainInfo(
            archiver = RunInfo(args = [ctx.attrs.archiver]),
            compile_env = ctx.attrs.compile_env,
            compiler = RunInfo(args = [ctx.attrs.compiler]),
            identity = ctx.attrs.identity + ";rustc_flags=" + ",".join(ctx.attrs.rustc_flags) + ";rustc_binary_flags=" + ",".join(ctx.attrs.rustc_binary_flags),
            linker = RunInfo(args = [ctx.attrs.linker]),
            target_platform_abi = platform.abi,
            target_platform_architecture = platform.architecture,
            target_platform_label = str(ctx.attrs.target_platform.label.raw_target()),
            target_platform_os = platform.os,
            target_platform_runtime_contract = platform.runtime_contract,
            target_triple = ctx.attrs.target_triple,
        ))
    providers.append(RustToolchainInfo(
        clippy_driver = RunInfo(args = [ctx.attrs.clippy_driver]),
        compiler = RunInfo(args = [ctx.attrs.compiler]),
        default_edition = "2021",
        doctests = False,
        nightly_features = False,
        panic_runtime = PanicRuntime("abort" if wasm else ctx.attrs.panic_runtime),
        rustc_env = ctx.attrs.compile_env,
        rustc_flags = ctx.attrs.wasm_rustc_flags if wasm else ctx.attrs.rustc_flags,
        rustc_binary_flags = ctx.attrs.wasm_rustc_binary_flags if wasm else ctx.attrs.rustc_binary_flags,
        rustc_target_triple = ctx.attrs.target_triple,
        rustdoc = RunInfo(args = [ctx.attrs.rustdoc]),
        rustdoc_env = ctx.attrs.compile_env,
    ))
    return providers

_rust_toolchain = cache_guarded_rule(
    impl = _rust_toolchain_impl,
    attrs = {
        "archiver": attrs.string(),
        "clippy_driver": attrs.string(),
        "compile_env": attrs.dict(key = attrs.string(), value = attrs.string()),
        "compiler": attrs.string(),
        "identity": attrs.string(),
        "linker": attrs.string(),
        "panic_runtime": attrs.enum(["unwind", "abort"], default = "unwind"),
        "rustc_flags": attrs.list(attrs.string()),
        "rustc_binary_flags": attrs.list(attrs.string()),
        "rustdoc": attrs.string(),
        "target_platform": attrs.dep(providers = [ProductPlatformInfo]),
        "target_triple": attrs.string(),
        "wasm_rustc_flags": attrs.list(attrs.string()),
        "wasm_rustc_binary_flags": attrs.list(attrs.string()),
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

    # A wasm32 product keeps the native executor; only the final cdylib link
    # switches to the attested wasm-ld with Prelude's wasm linker semantics.
    is_wasm = ctx.attrs.wasm_target
    compiler_type = "clang" if is_darwin else "gcc"
    linker = LinkerInfo(
        archiver = RunInfo(args = [ctx.attrs.archiver]),
        archiver_supports_argfiles = not is_darwin,
        archiver_type = "gnu",
        archive_objects_locally = True,
        binary_extension = ".wasm" if is_wasm else "",
        generate_linker_maps = False,
        link_binaries_locally = True,
        link_libraries_locally = True,
        link_style = LinkStyle("shared"),
        linker = RunInfo(args = [ctx.attrs.wasm_linker if is_wasm else ctx.attrs.linker]),
        linker_flags = [],
        lto_mode = LtoMode("none"),
        object_file_extension = "o",
        shared_dep_runtime_ld_flags = [],
        shared_library_name_default_prefix = "" if is_wasm else "lib",
        shared_library_name_format = "{}.wasm" if is_wasm else ("{}.dylib" if is_darwin else "{}.so"),
        shared_library_versioned_name_format = "{}.{}.wasm" if is_wasm else ("{}.{}.dylib" if is_darwin else "{}.so.{}"),
        shlib_interfaces = ShlibInterfacesMode("disabled"),
        static_dep_runtime_ld_flags = [],
        static_library_extension = "a",
        static_pic_dep_runtime_ld_flags = [],
        type = LinkerType("wasm" if is_wasm else ("darwin" if is_darwin else "gnu")),
        use_archiver_flags = True,
    )
    return [DefaultInfo()] + cxx_toolchain_infos(
        platform_name = "wasm32-unknown-unknown" if is_wasm else ctx.attrs.target_triple,
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

_native_cxx_toolchain = cache_guarded_rule(
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
        "wasm_linker": attrs.string(),
        "wasm_target": attrs.bool(),
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
    """Declares host-native C/C++ and a product-selectable native/wasm Rust pair."""
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
    wasm_metadata = {}
    for tool_id in _WASM_TOOL_IDS:
        wasm_metadata[tool_id] = require_capability(
            capabilities,
            generation,
            capability_platform,
            tool_id,
        )
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
        wasm_linker = wasm_metadata["rust-wasm-linker"]["executableStorePath"],
        wasm_target = select({
            "@rules//buck2/rust:wasm32_config": True,
            "DEFAULT": False,
        }),
        target_platform = target_platform,
        target_triple = target_triple,
        **compatibility
    )
    profile = read_config("rust_profile", "mode", "dev")
    if profile not in ("dev", "release"):
        fail("rust_profile.mode must be dev or release, got {}".format(profile))
    release_flags = _release_flags()
    lto = read_config("rust_profile", "lto", "local")
    wasm_identity = ";".join(
        ["contract=effect-utils/buck2-rust-wasm-toolchain/v1", "execution_platform=" + capability_platform, "target_triple=wasm32-unknown-unknown"] +
        ["{}={}:{}".format(tool_id, wasm_metadata[tool_id]["closureIdentity"], wasm_metadata[tool_id]["contentDigest"]) for tool_id in _WASM_TOOL_IDS],
    )
    opt_choices = {"DEFAULT": ["-Copt-level=s"]}
    for value in ["0", "1", "2", "3", "s", "z"]:
        opt_choices["@rules//buck2/rust:wasm_opt_" + value] = ["-Copt-level=" + value]
    strip_choices = {"DEFAULT": ["-Cstrip=symbols"]}
    for value in ["symbols", "debuginfo", "none"]:
        strip_choices["@rules//buck2/rust:wasm_strip_" + value] = ["-Cstrip=" + value]
    lto_choices = {"DEFAULT": ["-Clto=fat"]}
    for value in ["fat", "thin", "off"]:
        lto_choices["@rules//buck2/rust:wasm_lto_" + value] = ["-Clto=" + value]
    wasm_flags = [
        "-Clinker=" + wasm_metadata["rust-wasm-linker"]["executableStorePath"],
        "-Cpanic=abort",
        "-Cdebuginfo=0",
        "-Cdebug-assertions=no",
        "-Coverflow-checks=no",
    ] + select(opt_choices) + select(strip_choices)
    wasm_binary_flags = select(lto_choices)
    common = {
        "archiver": metadata["rust-archiver"]["executableStorePath"],
        "clippy_driver": metadata["rust-clippy-driver"]["executableStorePath"],
        # Build scripts remain executor-native; wasm rustc ignores the native
        # C/C++ linker settings and uses its explicitly attested wasm-ld.
        "compile_env": _compile_env(metadata, target_triple),
        "target_platform": target_platform,
        "rustc_flags": select({
            "@rules//buck2/rust:release": release_flags,
            "DEFAULT": ["-Copt-level=0"],
        }),
        "rustc_binary_flags": select({
            "@rules//buck2/rust:release": [] if lto == "local" else ["-Clto=" + lto],
            "DEFAULT": [],
        }),
        "wasm_rustc_flags": wasm_flags,
        "wasm_rustc_binary_flags": wasm_binary_flags,
    }
    common.update(compatibility)
    _rust_toolchain(
        name = "rust_wasm",
        compiler = wasm_metadata["rust-wasm-compiler"]["executableStorePath"],
        identity = wasm_identity,
        linker = wasm_metadata["rust-wasm-linker"]["executableStorePath"],
        panic_runtime = "abort",
        rustdoc = wasm_metadata["rust-wasm-rustdoc"]["executableStorePath"],
        target_triple = "wasm32-unknown-unknown",
        **common
    )
    _rust_toolchain(
        name = "rust",
        compiler = select({
            "@rules//buck2/rust:wasm32_config": wasm_metadata["rust-wasm-compiler"]["executableStorePath"],
            "DEFAULT": metadata["rust-compiler"]["executableStorePath"],
        }),
        identity = select({
            "@rules//buck2/rust:wasm32_config": wasm_identity,
            "DEFAULT": identity,
        }),
        linker = select({
            "@rules//buck2/rust:wasm32_config": wasm_metadata["rust-wasm-linker"]["executableStorePath"],
            "DEFAULT": metadata["rust-linker"]["executableStorePath"],
        }),
        panic_runtime = select({
            "@rules//buck2/rust:release": read_config("rust_profile", "panic", "unwind"),
            "DEFAULT": "unwind",
        }),
        rustdoc = select({
            "@rules//buck2/rust:wasm32_config": wasm_metadata["rust-wasm-rustdoc"]["executableStorePath"],
            "DEFAULT": metadata["rust-rustdoc"]["executableStorePath"],
        }),
        target_triple = select({
            "@rules//buck2/rust:wasm32_config": "wasm32-unknown-unknown",
            "DEFAULT": target_triple,
        }),
        **common
    )
