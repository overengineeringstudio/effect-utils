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

def _configured_target_triple():
    value = read_root_config("rust_toolchain", "target_triple", "")
    if value != "x86_64-unknown-linux-musl":
        fail("Nix-local Rust/C++ toolchains admit only x86_64-unknown-linux-musl")
    return value

def _configured_exec(key):
    value = read_root_config("rust_toolchain", key, "")
    if not value.startswith("/nix/store/") or "/bin/" not in value:
        fail("rust_toolchain.{} must be an immutable Nix store executable".format(key))
    return value

def _require_identity(value, name):
    if len(value) != 71 or not value.startswith("sha256:"):
        fail("{} must be a Nix-authored sha256 identity".format(name))

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

def _nix_rust_toolchain_impl(ctx):
    _require_identity(ctx.attrs.compile_identity, "compile_identity")
    if ctx.attrs.compile_identity_material != _compile_identity_material(ctx):
        fail("Rust compile-identity material does not match the conventional toolchain fields")
    return [
        DefaultInfo(),
        RustToolchainInfo(
            compiler = RunInfo(args = [
                ctx.attrs.identity_verifier,
                ctx.attrs.compile_identity_material,
                ctx.attrs.compile_identity,
                ctx.attrs.rustc,
            ]),
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
        "compile_identity": attrs.string(),
        "compile_identity_material": attrs.string(),
        "contract": attrs.string(),
        "cxx": attrs.string(),
        "execution_platform": attrs.string(),
        "identity_verifier": attrs.string(),
        "linker": attrs.string(),
        "rustc": attrs.string(),
        "rustdoc": attrs.string(),
        "target_platform": attrs.string(),
        "target_triple": attrs.string(),
        "tool_path": attrs.string(),
    },
    is_toolchain_rule = True,
)

def _compiler_info(provider, compiler):
    return provider(
        compiler = RunInfo(args = [compiler]),
        compiler_flags = [],
        compiler_type = "gcc",
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
        cpp_dep_tracking_mode = DepTrackingMode("makefile"),
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
    # The shared toolchains package also owns language-neutral stage-0 tools.
    # Only Rust product invocations supply this separately rooted config.
    if not read_root_config("rust_toolchain", "rustc", ""):
        return

    rustc = _configured_exec("rustc")
    rustdoc = _configured_exec("rustdoc")
    cc = _configured_exec("cc")
    cxx = _configured_exec("cxx")
    linker = _configured_exec("linker")
    ar = _configured_exec("ar")
    python = _configured_exec("python")

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
        dwp = _configured_exec("dwp"),
        linker = linker,
        nm = _configured_exec("nm"),
        objcopy = _configured_exec("objcopy"),
        objdump = _configured_exec("objdump"),
        platform_name = _configured_target_triple(),
        ranlib = _configured_exec("ranlib"),
        strip = _configured_exec("strip"),
        visibility = ["PUBLIC"],
    )

    _nix_rust_toolchain(
        name = "rust",
        ar = ar,
        cc = cc,
        clippy_driver = _configured_exec("clippy_driver"),
        compile_identity = read_root_config("rust_toolchain", "compile_identity", ""),
        compile_identity_material = read_root_config("rust_toolchain", "compile_identity_material", ""),
        contract = read_root_config("rust_toolchain", "contract", ""),
        cxx = cxx,
        execution_platform = read_root_config("rust_toolchain", "execution_platform", ""),
        identity_verifier = _configured_exec("identity_verifier"),
        linker = linker,
        rustc = rustc,
        rustdoc = rustdoc,
        target_platform = read_root_config("rust_toolchain", "target_platform", ""),
        target_triple = _configured_target_triple(),
        tool_path = read_root_config("rust_toolchain", "tool_path", ""),
        visibility = ["PUBLIC"],
    )
