"""Audited native Linux x86_64 Rust compilation; all other lanes deny cache.

Selectors are checked universally before admission and resolved inputs are checked
again at analysis. Cargo platform expansion and lint policy stay in pinned Prelude.
The private clone attributes are implementation details, never caller controls.

Admission additionally requires cache_audited=True from the caller's automated
all-source audit: no CARGO_MANIFEST_DIR token in any target source, no build
script, and a semantic fingerprint covering that audit. Unknown source defaults
to native. Prelude intentionally absolutizes declared-relative manifest env for
include!/proc-macro semantics; we preserve that behavior, not pretend those
absolute strings are portable when compile-time code embeds them. Stable
file!/debug paths use pinned rustc_action --remap-cwd-prefix=. (cwd and realpath).
"""

load("@prelude//:prelude.bzl", "native")
load("@prelude//cxx:cxx_toolchain_types.bzl", "BinaryUtilitiesInfo", "CxxInternalTools", "CxxPlatformInfo", "CxxToolchainInfo", "LinkerInfo")
load("@prelude//rust:cargo_package.bzl", "apply_platform_attrs", "apply_platform_attrs_for_buildscript_build")
load("@prelude//rust:outputs.bzl", "RustcExtraOutputsInfo")
load("@prelude//rust:link_info.bzl", "normalize_crate")
load("@prelude//rust:rust_binary.bzl", "rust_binary_impl")
load("@prelude//rust:rust_library.bzl", "rust_library_impl")
load("@prelude//utils:selects.bzl", "selects")
load("@prelude//rust:rust_toolchain.bzl", "RustToolchainInfo")
load("@prelude//rust/tools:attrs.bzl", "RustInternalToolsInfo")
load("@rules//buck2:hermetic.bzl", "hermetic_attrs", "hermetic_execution_constraints")
load("@rules//buck2/platforms:defs.bzl", "cache_guarded_prelude_rule")
load("@rules//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("@rules//buck2/toolchains:defs.bzl", "ConfiguredRustToolchainInfo")

_NATIVE = ["prelude//os/constraints:linux", "prelude//cpu/constraints:x86_64"]
_CARGO_ENV = [
    "CARGO_BIN_NAME", "CARGO_CRATE_NAME", "CARGO_MANIFEST_DIR",
    "CARGO_PKG_AUTHORS", "CARGO_PKG_DESCRIPTION", "CARGO_PKG_HOMEPAGE",
    "CARGO_PKG_LICENSE", "CARGO_PKG_LICENSE_FILE", "CARGO_PKG_NAME",
    "CARGO_PKG_README", "CARGO_PKG_REPOSITORY", "CARGO_PKG_RUST_VERSION",
    "CARGO_PKG_VERSION", "CARGO_PKG_VERSION_MAJOR", "CARGO_PKG_VERSION_MINOR",
    "CARGO_PKG_VERSION_PATCH", "CARGO_PKG_VERSION_PRE",
]


def _literal(value):
    if type(value) == "string":
        return value
    # attrs.arg is always ResolvedStringWithMacros in this pinned Buck. Equality
    # with a string succeeds only for a single literal part, never a macro.
    if type(value) == "ResolvedStringWithMacros":
        text = str(value)[1:-1]
        if value == text:
            return text
    return None


def _stable_text(value):
    text = _literal(value)
    if text == None or any([marker in text for marker in ["$", "\x00", "\r", "\n", "OUT_DIR", "buck-out/", "../", "\\"]]):
        return False
    # Reject embedded as well as leading absolute paths, except immutable Nix.
    for word in text.replace("=", " ").replace(",", " ").split():
        if "://" in word:
            continue
        for part in word.split(":"):
            path = part[2:] if part.startswith("-L/") or part.startswith("-I/") else part
            if path.startswith("/") and not path.startswith("/nix/store/"):
                return False
    return True


def _pure_flags(flags):
    if type(flags) != "list" and type(flags) != "tuple":
        return False
    for flag in flags:
        text = _literal(flag)
        if not _stable_text(flag) or "@" in text or "incremental" in text or text in ["-C", "-Z", "--sysroot", "--target", "--out-dir", "-o", "-L"]:
            return False
        if any([text.startswith(prefix) for prefix in ["-Clinker", "-Clink-arg", "-Cprofile", "-Cllvm-args", "--sysroot", "--target", "--out-dir", "-Z", "--extern"]]) or "target-cpu=native" in text:
            return False
    return True


_NIX_STORE_ROOT = regex("^/nix/store/[0-9abcdfghijklmnpqrsvwxyz]{32}-[^/]+$")


def _nix_path(path, closure = False):
    if not path.startswith("/nix/store/") or "//" in path or any([part in [".", "..", ""] for part in path.split("/")[1:]]):
        return False
    root = "/".join(path.split("/")[:4])
    return _NIX_STORE_ROOT.match(root) and (not closure or path == root)


def _relative_manifest(value):
    text = _literal(value)
    return text != None and bool(text) and not text.startswith("/") and ":" not in text


def _identity_fields(value):
    text = _literal(value)
    if text == None or not text:
        return None
    fields = {}
    for field in text.split(";"):
        pair = field.split("=", 1)
        if len(pair) != 2 or not pair[0] or pair[0] in fields:
            return None
        key, entry = pair
        if key == "target_platform":
            # A repository-local Buck label starts with //, not a filesystem
            # root. Validate that typed field separately from executable paths.
            if not entry.startswith("//") or entry.count(":") != 1 or not _stable_text(entry[2:]):
                return None
        elif not _stable_text(entry):
            return None
        fields[key] = entry
    return fields


def _pure_env(env, toolchain = False):
    if type(env) != "dict":
        return False
    for name, value in env.items():
        if toolchain and name == "NIX_LDFLAGS_x86_64_unknown_linux_gnu":
            if value != "-dynamic-linker /lib64/ld-linux-x86-64.so.2":
                return False
            continue
        if toolchain and name == "EFFECT_UTILS_RUST_TOOLCHAIN_IDENTITY":
            if _identity_fields(value) == None:
                return False
            continue
        if name not in _CARGO_ENV and not (toolchain and name in ["AR", "CC", "CXX", "LD", "PATH", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "NIX_DONT_SET_RPATH_x86_64_unknown_linux_gnu", "EFFECT_UTILS_RUST_TOOLCHAIN_IDENTITY", "EFFECT_UTILS_RUST_COMPILER_CLOSURE"]):
            return False
        if not native.select_test(value, _stable_text):
            return False
        if name == "CARGO_MANIFEST_DIR" and not native.select_test(value, _relative_manifest):
            return False
        if toolchain and name in ["AR", "CC", "CXX", "LD", "PATH", "EFFECT_UTILS_RUST_COMPILER_CLOSURE"]:
            text = _literal(value)
            if text == None or not text or any([not _nix_path(path, closure = name == "EFFECT_UTILS_RUST_COMPILER_CLOSURE") for path in text.split(":")]):
                return False
            if name == "EFFECT_UTILS_RUST_COMPILER_CLOSURE" and text.split(":") != sorted({path: None for path in text.split(":")}):
                return False
        if toolchain and name in ["RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"] and value != "":
            return False
        if toolchain and name == "NIX_DONT_SET_RPATH_x86_64_unknown_linux_gnu" and value != "1":
            return False
    return True


def _empty(value):
    return value == [] or value == {} or value == None


def _false(value):
    return value == False


def _pure_rule(kwargs):
    if not native.select_test(kwargs.get("env", {}), _pure_env):
        return False
    if not native.select_test(kwargs.get("rustc_flags", []), _pure_flags):
        return False
    for name in ["linker_flags", "exported_linker_flags", "rustdoc_flags", "flagged_deps", "bolt_flags", "elf_sections", "extra_dwp_flags", "crate_dynamic"]:
        if not native.select_test(kwargs.get(name, []), _empty):
            return False
    for name in ["incremental_enabled", "coverage", "separate_debug_info", "enable_distributed_thinlto"]:
        if not native.select_test(kwargs.get(name, False), _false):
            return False
    return native.select_test(kwargs.get("crate", ""), lambda crate: crate == None or (crate != "build_script_build" and _stable_text(crate)))


def _native_select(admitted, default):
    # WASM platforms retain the native CPU/OS constraints. Test WASM first rather
    # than let those constraints accidentally admit its native-executed actions.
    return select({
        "@rules//buck2/rust:wasm32_config": default,
        "DEFAULT": select({"@rules//buck2/rust:cache_linux_x86_64": admitted, "DEFAULT": default}),
    })


def _resolved_eligible(ctx):
    if not ctx.attrs._cache_source_audited:
        return False
    toolchain = ctx.attrs._rust_toolchain[RustToolchainInfo]
    configured = ctx.attrs._rust_toolchain.get(ConfiguredRustToolchainInfo)
    if configured == None or configured.target_platform_os != "linux" or configured.target_platform_architecture != "x86_64":
        return False
    if toolchain.rustc_target_triple != "x86_64-unknown-linux-gnu" or toolchain.advanced_unstable_linking or toolchain.nightly_features:
        return False
    if not _pure_rule({name: getattr(ctx.attrs, name) for name in ["env", "rustc_flags", "incremental_enabled", "coverage", "separate_debug_info", "crate", "linker_flags", "exported_linker_flags", "rustdoc_flags", "flagged_deps", "bolt_flags", "elf_sections", "extra_dwp_flags", "enable_distributed_thinlto", "crate_dynamic"] if hasattr(ctx.attrs, name)}):
        return False
    if not _pure_env(toolchain.rustc_env, toolchain = True):
        return False
    if not toolchain.rustc_env.get("EFFECT_UTILS_RUST_TOOLCHAIN_IDENTITY") or not toolchain.rustc_env.get("EFFECT_UTILS_RUST_COMPILER_CLOSURE"):
        return False
    identity = _literal(toolchain.rustc_env["EFFECT_UTILS_RUST_TOOLCHAIN_IDENTITY"])
    if identity == None or not configured.identity.startswith(identity + ";rustc_flags="):
        return False
    identity_fields = _identity_fields(identity)
    if identity_fields == None:
        return False
    expected_platform = "//" + configured.target_platform_label.split("//", 1)[1]
    if identity_fields.get("target_platform") != expected_platform:
        return False
    if identity_fields.get("contract") != "effect-utils/buck2-rust-toolchain/v1" or identity_fields.get("target_triple") != "x86_64-unknown-linux-gnu":
        return False
    for name in ["rust-compiler", "rust-linker"]:
        attestation = identity_fields.get(name, "").split(":")
        if len(attestation) != 2 or not _nix_path(attestation[0], closure = True) or len(attestation[1]) != 64:
            return False
        if name == "rust-compiler" and attestation[0] not in toolchain.rustc_env["EFFECT_UTILS_RUST_COMPILER_CLOSURE"].split(":"):
            return False
    if ctx.attrs._cache_native_diagnostics == None:
        return False
    for name in ["rustc_flags", "extra_rustc_flags", "rustc_check_flags", "rustc_binary_flags", "rustdoc_flags", "linker_flags"]:
        if not _pure_flags(getattr(toolchain, name)):
            return False
    return toolchain.rust_target_path == None and toolchain.llvm_lines_tool == None and toolchain.measureme_crox == None


def _isolated_command(ctx, arguments, env = {}):
    # Same audited GNU env launcher as buck2/hermetic.bzl: no shell executes
    # before isolation, and only executor-owned scratch/temp survive inheritance.
    tool = ctx.attrs._action_env[BuckSupportToolInfo]
    command = cmd_args([
        tool.store_path, "--coreutils-prog=env", "-S",
        "-i BUCK_SCRATCH_PATH=${BUCK_SCRATCH_PATH} TMPDIR=${TMPDIR}",
        "LC_ALL=C", "TZ=UTC",
    ], hidden = [tool.executable, tool.manifest])
    for name in sorted(env.keys()):
        command.add(cmd_args(env[name], format = name + "={}"))
    command.add(arguments)
    return command


def _wrap_tools(ctx, info, provider_type, env = {}):
    values = {name: getattr(info, name) for name in dir(info)}
    for name in list(values.keys()):
        value = values[name]
        if type(value) == "RunInfo":
            values[name] = RunInfo(args = _isolated_command(ctx, value, env))
    return provider_type(**values)


def _internal_tools_impl(ctx):
    original = ctx.attrs._original[RustInternalToolsInfo]
    return [DefaultInfo(), _wrap_tools(ctx, original, RustInternalToolsInfo)]


rust_cache_internal_tools = rule(
    impl = _internal_tools_impl,
    attrs = hermetic_attrs() | {"_original": attrs.default_only(attrs.toolchain_dep(default = "prelude//rust/tools:internal_tools_toolchain"))},
    is_toolchain_rule = True,
)


def _cxx_toolchain_impl(ctx):
    dep = ctx.attrs._original
    original = dep[CxxToolchainInfo]
    values = {name: getattr(original, name) for name in dir(original)}
    env = ctx.attrs._rust[RustToolchainInfo].rustc_env
    if not _pure_env(env, toolchain = True):
        fail("Rust cache CXX helpers require a static declared compile environment")
    for name, provider_type in [("linker_info", LinkerInfo), ("binary_utilities_info", BinaryUtilitiesInfo), ("internal_tools", CxxInternalTools)]:
        values[name] = _wrap_tools(ctx, values[name], provider_type, env)
    return [DefaultInfo(), CxxToolchainInfo(**values), dep[CxxPlatformInfo]]


rust_cache_cxx_toolchain = rule(
    impl = _cxx_toolchain_impl,
    attrs = hermetic_attrs() | {
        "_original": attrs.default_only(attrs.toolchain_dep(default = "toolchains//:cxx", providers = [CxxToolchainInfo])),
        "_rust": attrs.default_only(attrs.toolchain_dep(default = "toolchains//:rust", providers = [RustToolchainInfo])),
    },
    is_toolchain_rule = True,
)


def _admitted_impl(impl, ctx):
    providers = impl(ctx)
    twin = ctx.attrs._cache_native_diagnostics
    if twin == None:
        return providers
    native_outputs = twin[RustcExtraOutputsInfo]
    result = []
    for info in providers:
        if isinstance(info, RustcExtraOutputsInfo):
            result.append(RustcExtraOutputsInfo(
                metadata = info.metadata,
                metadata_incr = native_outputs.metadata_incr,
                clippy = native_outputs.clippy,
                clippy_incr = native_outputs.clippy_incr,
                remarks = info.remarks,
            ))
        elif isinstance(info, DefaultInfo):
            # The local Prelude result is not frozen yet. Preserve collections
            # in place, including providers unrelated to DefaultInfo. Only
            # compilation/check subtargets are admitted; docs, diagnostics,
            # profiling and unknown future Prelude subtargets fail closed.
            compile_subtargets = [
                "check", "static", "static_pic", "staticlib", "dylib", "cdylib", "shared",
            ]
            for name in list(info.sub_targets.keys()):
                if name not in compile_subtargets:
                    info.sub_targets[name] = twin[DefaultInfo].sub_targets[name]
            result.append(info)
        else:
            result.append(info)
    # Prelude still registers its diagnostic actions, but only native-twin
    # outputs escape for diagnostic and noncompilation subtargets. Remote reads
    # and uploads remain denied for those lanes.
    return result


def _compile_rule(name, impl):
    return cache_guarded_prelude_rule(name, partial(_admitted_impl, impl), cache_eligible = _resolved_eligible, extra_attrs = {
        "_rust_internal_tools_toolchain": attrs.default_only(attrs.toolchain_dep(default = _native_select("@rules//buck2/rust:cache_internal_tools", "prelude//rust/tools:internal_tools_toolchain"))),
        "_cxx_toolchain": attrs.default_only(attrs.toolchain_dep(default = _native_select("@rules//buck2/rust:cache_cxx_toolchain", "toolchains//:cxx"), providers = [CxxToolchainInfo])),
        "_cache_native_diagnostics": attrs.option(attrs.dep(providers = [RustcExtraOutputsInfo]), default = None),
        "_cache_source_audited": attrs.bool(default = False),
    })


_admitted_library = _compile_rule("rust_library", rust_library_impl)
_admitted_binary = _compile_rule("rust_binary", rust_binary_impl)
_native_library = cache_guarded_prelude_rule("rust_library", rust_library_impl)
_native_binary = cache_guarded_prelude_rule("rust_binary", rust_binary_impl)


def _rust_rule(name, admitted, unadmitted, cache_audited, kwargs):
    for attr in kwargs:
        if attr.startswith("_") or attr in ["exec_compatible_with", "compatible_with", "allow_cache_upload", "default_target_platform"]:
            fail("Rust cache macros own cache/exec compatibility; caller override `{}` is forbidden".format(attr))
    if type(cache_audited) == "bool" and cache_audited and _pure_rule(kwargs):
        twin_name = "__cache_native_diagnostics_" + name
        twin_kwargs = dict(kwargs)
        twin_kwargs["crate"] = selects.apply(kwargs.get("crate"), lambda crate: crate or normalize_crate(name))
        unadmitted(name = twin_name, **twin_kwargs)
        admitted(
            name = name,
            exec_compatible_with = _native_select(hermetic_execution_constraints(_NATIVE), []),
            _cache_native_diagnostics = _native_select(":" + twin_name, None),
            _cache_source_audited = True,
            **kwargs
        )
    else:
        unadmitted(name = name, **kwargs)


def rust_library(name, cache_audited = False, **kwargs):
    _rust_rule(name, _admitted_library, _native_library, cache_audited, kwargs)


def rust_binary(name, cache_audited = False, **kwargs):
    _rust_rule(name, _admitted_binary, _native_binary, cache_audited, kwargs)


def _cargo_rust_library(name, platform = {}, cache_audited = False, **kwargs):
    kwargs = apply_platform_attrs(platform, kwargs)
    kwargs["rustc_flags"] = ["--cap-lints=allow"] + kwargs.get("rustc_flags", [])
    kwargs.setdefault("doctests", False)
    kwargs.pop("dlopen_enable", None)
    kwargs.pop("linkable_alias", None)
    rust_library(name = name, cache_audited = cache_audited, **kwargs)


def _cargo_rust_binary(name, crate = None, platform = {}, cache_audited = False, **kwargs):
    kwargs = apply_platform_attrs_for_buildscript_build(platform, kwargs) if crate == "build_script_build" else apply_platform_attrs(platform, kwargs)
    kwargs["rustc_flags"] = ["--cap-lints=allow"] + kwargs.get("rustc_flags", [])
    rust_binary(name = name, crate = crate, cache_audited = cache_audited, **kwargs)


cargo = struct(rust_library = _cargo_rust_library, rust_binary = _cargo_rust_binary)
