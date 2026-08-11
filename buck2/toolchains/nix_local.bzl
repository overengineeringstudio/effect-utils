"""Nix-authored, local-only Rust/C++ toolchain providers for Buck2.

The configured values are immutable Nix store *roots*, not executable paths.
Keeping the roots explicit makes the action key include the complete toolchain
identity while preventing a mutable PATH lookup from changing the compiler.

Raw host store paths are intentionally a local execution boundary. A future
remote-execution lane must replace these providers with portable artifacts and
an execution-platform constraint; a provider cannot itself force every Prelude
consumer action to be local-only.
"""

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
    "@prelude//toolchains:python.bzl",
    "system_python_bootstrap_toolchain",
    "system_python_toolchain",
)

_NIX_BASE32 = "0123456789abcdfghijklmnpqrsvwxyz"
_NIX_NAME = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-._?="

def _configured_store_root(key):
    value = read_root_config("buck2_rust", key, "")
    parts = value.split("/")
    if (
        len(parts) != 4 or
        parts[0] != "" or
        parts[1] != "nix" or
        parts[2] != "store" or
        len(parts[3]) < 34 or
        parts[3][32] != "-" or
        "\n" in value or
        "\r" in value
    ):
        fail("buck2_rust.{} must be a canonical /nix/store/<hash>-<name> root".format(key))
    for character in parts[3][:32].elems():
        if character not in _NIX_BASE32:
            fail("buck2_rust.{} must contain a canonical Nix base32 store hash".format(key))
    for character in parts[3][33:].elems():
        if character not in _NIX_NAME:
            fail("buck2_rust.{} must contain a canonical Nix store name".format(key))
    for component in parts[3].split("-"):
        if not component or component == "." or component == "..":
            fail("buck2_rust.{} must be a canonical Nix store root".format(key))
    return value

def _host_target_triple():
    host = host_info()
    if not host.os.is_linux:
        fail("Nix-local Rust/C++ toolchains currently support Linux only")
    if host.arch.is_x86_64:
        return "x86_64-unknown-linux-gnu"
    if host.arch.is_aarch64:
        return "aarch64-unknown-linux-gnu"
    fail("Nix-local Rust/C++ toolchains do not support this host architecture")

def _nix_rust_toolchain_impl(ctx):
    return [
        DefaultInfo(),
        RustToolchainInfo(
            compiler = RunInfo(args = [ctx.attrs.rustc]),
            rustdoc = RunInfo(args = [ctx.attrs.rustdoc]),
            clippy_driver = RunInfo(args = [ctx.attrs.clippy_driver]),
            default_edition = "2021",
            panic_runtime = PanicRuntime("unwind"),
            rustc_target_triple = ctx.attrs.target_triple,
            # Cargo build scripts consult these when compiling native probes.
            # The values are immutable executables, not PATH-relative names.
            rustc_env = {
                "AR": ctx.attrs.ar,
                "CC": ctx.attrs.cc,
                "CXX": ctx.attrs.cxx,
                "LD": ctx.attrs.linker,
                # Prelude emits small `/usr/bin/env bash` wrappers. Constrain
                # their lookup and helper utilities to reviewed store roots.
                "PATH": ctx.attrs.tool_path,
            },
        ),
    ]

_nix_rust_toolchain = rule(
    impl = _nix_rust_toolchain_impl,
    attrs = {
        "ar": attrs.string(),
        "cc": attrs.string(),
        "clippy_driver": attrs.string(),
        "cxx": attrs.string(),
        "linker": attrs.string(),
        "rustc": attrs.string(),
        "rustdoc": attrs.string(),
        "target_triple": attrs.string(),
        "tool_path": attrs.string(),
    },
    is_toolchain_rule = True,
)

def _compiler_info(provider, compiler):
    return provider(
        compiler = RunInfo(args = [compiler]),
        compiler_flags = [],
        compiler_type = "clang",
        preprocessor_flags = [],
        supports_content_based_paths = False,
    )

def _nix_cxx_toolchain_impl(ctx):
    c_compiler = _compiler_info(CCompilerInfo, ctx.attrs.cc)
    cxx_compiler = _compiler_info(CxxCompilerInfo, ctx.attrs.cxx)
    linker = LinkerInfo(
        archiver = RunInfo(args = [ctx.attrs.ar]),
        archiver_supports_argfiles = True,
        archiver_type = "gnu",
        archive_objects_locally = True,
        binary_extension = "",
        generate_linker_maps = False,
        link_binaries_locally = True,
        link_libraries_locally = True,
        link_style = LinkStyle("static"),
        linker = RunInfo(args = [ctx.attrs.linker]),
        linker_flags = [],
        lto_mode = LtoMode("none"),
        object_file_extension = "o",
        shlib_interfaces = ShlibInterfacesMode("disabled"),
        shared_dep_runtime_ld_flags = [],
        shared_library_name_default_prefix = "lib",
        shared_library_name_format = "{}.so",
        shared_library_versioned_name_format = "{}.so.{}",
        static_dep_runtime_ld_flags = [],
        static_library_extension = "a",
        static_pic_dep_runtime_ld_flags = [],
        type = LinkerType("gnu"),
        use_archiver_flags = True,
    )
    binary_utilities = BinaryUtilitiesInfo(
        dwp = RunInfo(args = [ctx.attrs.dwp]),
        nm = RunInfo(args = [ctx.attrs.nm]),
        objcopy = RunInfo(args = [ctx.attrs.objcopy]),
        objdump = RunInfo(args = [ctx.attrs.objdump]),
        ranlib = RunInfo(args = [ctx.attrs.ranlib]),
        strip = RunInfo(args = [ctx.attrs.strip]),
    )
    return [DefaultInfo()] + cxx_toolchain_infos(
        platform_name = ctx.attrs.platform_name,
        c_compiler_info = c_compiler,
        cxx_compiler_info = cxx_compiler,
        linker_info = linker,
        binary_utilities_info = binary_utilities,
        header_mode = HeaderMode("symlink_tree_only"),
        internal_tools = ctx.attrs.internal_tools[CxxInternalTools],
        cpp_dep_tracking_mode = DepTrackingMode("show_headers"),
        pic_behavior = PicBehavior("supported"),
        use_dep_files = True,
    )

_nix_cxx_toolchain = rule(
    impl = _nix_cxx_toolchain_impl,
    attrs = {
        "ar": attrs.string(),
        "cc": attrs.string(),
        "cxx": attrs.string(),
        "dwp": attrs.string(),
        "internal_tools": attrs.default_only(attrs.exec_dep(
            default = "prelude//cxx/tools:internal_tools",
            providers = [CxxInternalTools],
        )),
        "linker": attrs.string(),
        "nm": attrs.string(),
        "objcopy": attrs.string(),
        "objdump": attrs.string(),
        "platform_name": attrs.string(),
        "ranlib": attrs.string(),
        "strip": attrs.string(),
    },
    is_toolchain_rule = True,
)

def nix_local_rust_cxx_python_toolchains():
    rustc_root = _configured_store_root("rustc_root")
    clang_root = _configured_store_root("clang_root")
    binutils_root = _configured_store_root("binutils_root")
    bash_root = _configured_store_root("bash_root")
    clippy_root = _configured_store_root("clippy_root")
    coreutils_root = _configured_store_root("coreutils_root")
    python_root = _configured_store_root("python_root")

    rustc = rustc_root + "/bin/rustc"
    rustdoc = rustc_root + "/bin/rustdoc"
    cc = clang_root + "/bin/clang"
    cxx = clang_root + "/bin/clang++"
    # Link through the compiler driver so the Nix wrapper supplies its exact
    # runtime and libc closure. Direct `ld` is not a complete C++ linker.
    linker = cxx
    ar = binutils_root + "/bin/ar"
    python = python_root + "/bin/python3"

    # Prelude's Python helpers are part of the build graph. Pin both the normal
    # and bootstrap providers to the same immutable Nix interpreter instead of
    # downloading and extracting a second CPython distribution at action time.
    system_python_toolchain(
        name = "python",
        interpreter = python,
        visibility = ["PUBLIC"],
    )
    system_python_bootstrap_toolchain(
        name = "python_bootstrap",
        interpreter = python,
        visibility = ["PUBLIC"],
    )

    _nix_cxx_toolchain(
        name = "cxx",
        ar = ar,
        cc = cc,
        cxx = cxx,
        dwp = binutils_root + "/bin/dwp",
        linker = linker,
        nm = binutils_root + "/bin/nm",
        objcopy = binutils_root + "/bin/objcopy",
        objdump = binutils_root + "/bin/objdump",
        platform_name = _host_target_triple(),
        ranlib = binutils_root + "/bin/ranlib",
        strip = binutils_root + "/bin/strip",
        visibility = ["PUBLIC"],
    )

    _nix_rust_toolchain(
        name = "rust",
        ar = ar,
        cc = cc,
        clippy_driver = clippy_root + "/bin/clippy-driver",
        cxx = cxx,
        linker = linker,
        rustc = rustc,
        rustdoc = rustdoc,
        target_triple = _host_target_triple(),
        tool_path = bash_root + "/bin:" + coreutils_root + "/bin",
        visibility = ["PUBLIC"],
    )
