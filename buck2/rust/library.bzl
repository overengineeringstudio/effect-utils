"""Rust compilation-input products: provider closure, not executable packaging."""

load("@prelude//linking:link_info.bzl", "LinkStrategy")
load("@prelude//rust:build_params.bzl", "MetadataKind")
load("@prelude//rust:link_info.bzl", "RustLinkInfo", "RustProcMacroPlugin", "get_available_proc_macros", "strategy_info")
load("@prelude//rust:rust_toolchain.bzl", "RustToolchainInfo")
load("//buck2:hermetic.bzl", "hermetic_action", "hermetic_attrs", "hermetic_bun_command")
load("//buck2/platforms:defs.bzl", "ProductPlatformInfo", "cache_guarded_rule", "product_platform_constraints")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("//buck2/toolchains:defs.bzl", "ConfiguredRustToolchainInfo")
load("//buck2/toolchains:defs.bzl", "host_rust_target_triple")
load("//buck2/provenance:defs.bzl", "RustLibraryPayload", "build_provenance_info", "product_artifact_info")

def _check_native_inputs(info, host = False):
    # Empty tset nodes are normal; only actual link records need a decision.
    if not host:
        for entries in info.native_link_deps.traverse():
            if entries:
                fail("rust_product_library: unsupported native link dependencies {}".format([label for label, _ in entries]))
    if info.shared_libs.set != None:
        for group in info.shared_libs.set.traverse():
            if group.libraries:
                fail("rust_product_library: unsupported unbundled shared libraries {}".format([lib.label for lib in group.libraries]))

def _impl(ctx):
    toolchain = ctx.attrs._rust_toolchain[RustToolchainInfo]
    platform = ctx.attrs.target_platform[ProductPlatformInfo]
    if toolchain.rustc_target_triple != platform.rust_target_triple:
        fail("rust_product_library: library toolchain and product target triples differ")
    strategy = LinkStrategy("static_pic")
    info = ctx.attrs.library[RustLinkInfo]
    _check_native_inputs(info)
    selected = strategy_info(toolchain, info, strategy)
    primary = selected.outputs[MetadataKind("link")]
    if not primary.basename.endswith(".rlib"):
        fail("rust_product_library: expected static_pic rlib, got {}".format(primary))
    rows = []
    inputs = []

    def collect(tset, role):
        for entry in tset.traverse():
            rows.append([entry.artifact, entry.crate.simple, entry.crate.dynamic, role])
            inputs.append(entry.artifact)
            if entry.crate.dynamic != None:
                inputs.append(entry.crate.dynamic)

    for kind in [MetadataKind("link"), MetadataKind("full")]:
        if kind in selected.outputs:
            collect(selected.singleton_tset[kind], kind.value)
            collect(selected.transitive_deps[kind], kind.value)
    macros = get_available_proc_macros(ctx)
    for marker in selected.transitive_proc_macro_deps:
        macro_info = macros[marker.label][RustLinkInfo]
        _check_native_inputs(macro_info, host = True)
        host = strategy_info(toolchain, macro_info, strategy)
        collect(host.singleton_tset[MetadataKind("link")], "proc-macro")
    manifest = ctx.actions.write_json("closure.json", {
        "primary": primary, "artifacts": rows,
        "targetTriple": toolchain.rustc_target_triple,
        "hostTriple": host_rust_target_triple(),
        "panicStrategy": toolchain.panic_runtime.value,
    })
    metadata = ctx.actions.declare_output("compiler-metadata.json")
    output = ctx.actions.declare_output("lib", dir = True)
    bun = ctx.attrs._bun[BuckSupportToolInfo]
    hermetic_action(
        ctx,
        cmd_args(hermetic_bun_command(ctx, bun.executable), ctx.attrs._pack, manifest, output.as_output(), metadata.as_output(), toolchain.compiler.args, hidden = inputs + [bun.manifest]),
        category = "rust_library_closure",
        cacheable = False,
    )
    rustc, rustc_macros = ctx.actions.write("rustc.txt", toolchain.compiler.args, allow_args = True)
    archiver, archiver_macros = ctx.actions.write("ar.txt", ctx.attrs._rust_toolchain[ConfiguredRustToolchainInfo].archiver.args, allow_args = True)
    provenance = build_provenance_info(ctx, ctx.attrs.recipe, ctx.attrs._rust_toolchain[ConfiguredRustToolchainInfo].identity)
    payload = RustLibraryPayload(
        primary = primary, crate_name = info.crate, directory = output, manifest = manifest,
        compiler_metadata = metadata, panic_strategy = toolchain.panic_runtime.value,
        target_triple = toolchain.rustc_target_triple, host_triple = host_rust_target_triple(),
    )
    return [product_artifact_info("library", payload, platform, provenance), DefaultInfo(default_output = output, other_outputs = [manifest], sub_targets = {
        "rustc": [DefaultInfo(default_output = rustc, other_outputs = rustc_macros)],
        "ar": [DefaultInfo(default_output = archiver, other_outputs = archiver_macros)],
        "metadata": [DefaultInfo(default_output = metadata)],
    })]

_rust_product_library = cache_guarded_rule(
    impl = _impl,
    attrs = dict(hermetic_attrs(), **{
        "library": attrs.dep(providers = [RustLinkInfo], pulls_plugins = [RustProcMacroPlugin]),
        "recipe": attrs.string(),
        "target_platform": attrs.dep(providers = [ProductPlatformInfo]),
        "_rust_toolchain": attrs.toolchain_dep(default = "//buck2/toolchains:rust", providers = [RustToolchainInfo, ConfiguredRustToolchainInfo]),
        "_bun": attrs.exec_dep(default = "//buck2/toolchains:tool_bun", providers = [BuckSupportToolInfo]),
        "_pack": attrs.source(default = "//buck2/rust:library-closure.mjs"),
    }),
    uses_plugins = [RustProcMacroPlugin],
)

def rust_product_library(name, library, recipe, target_platform, **kwargs):
    """Exports the compiler-bound flat closure for a native Prelude rust_library."""
    _rust_product_library(
        name = name, library = library, recipe = recipe, target_platform = target_platform,
        target_compatible_with = product_platform_constraints(target_platform), **kwargs
    )
