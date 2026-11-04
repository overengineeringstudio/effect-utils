"""Internal/test-only pinned-Prelude closure experiment; NOT a product API."""

load("@prelude//linking:link_info.bzl", "LinkStrategy")
load("@prelude//rust:build_params.bzl", "MetadataKind")
load("@prelude//rust:link_info.bzl", "RustLinkInfo", "RustProcMacroPlugin", "get_available_proc_macros", "strategy_info")
load("@prelude//rust:rust_toolchain.bzl", "RustToolchainInfo")
load("//buck2:hermetic.bzl", "hermetic_action", "hermetic_attrs", "hermetic_bun_command")
load("//buck2/platforms:defs.bzl", "cache_guarded_rule")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("//buck2/toolchains:defs.bzl", "ConfiguredRustToolchainInfo")

def _impl(ctx):
    toolchain = ctx.attrs._rust_toolchain[RustToolchainInfo]
    strategy = LinkStrategy("static_pic")
    info = ctx.attrs.library[RustLinkInfo]
    selected = strategy_info(toolchain, info, strategy)
    primary = selected.outputs[MetadataKind("link")]
    if not primary.basename.endswith(".rlib"):
        fail("library_closure_probe: expected static_pic rlib, got {}".format(primary))
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
        host = strategy_info(toolchain, macros[marker.label][RustLinkInfo], strategy)
        collect(host.singleton_tset[MetadataKind("link")], "proc-macro")
    manifest = ctx.actions.write_json("closure.json", {"primary": primary, "artifacts": rows})
    output = ctx.actions.declare_output("lib", dir = True)
    bun = ctx.attrs._bun[BuckSupportToolInfo]
    hermetic_action(
        ctx,
        cmd_args(hermetic_bun_command(ctx, bun.executable), ctx.attrs._pack, manifest, output.as_output(), hidden = inputs + [bun.manifest]),
        category = "rust_library_closure_probe",
        cacheable = False,
    )
    rustc = ctx.actions.write("rustc.txt", toolchain.compiler.args, allow_args = True)
    archiver = ctx.actions.write("ar.txt", ctx.attrs._rust_toolchain[ConfiguredRustToolchainInfo].archiver.args, allow_args = True)
    return [DefaultInfo(default_output = output, other_outputs = [manifest], sub_targets = {
        "rustc": [DefaultInfo(default_output = rustc)],
        "ar": [DefaultInfo(default_output = archiver)],
    })]

library_closure_probe = cache_guarded_rule(
    impl = _impl,
    attrs = dict(hermetic_attrs(), **{
        "library": attrs.dep(providers = [RustLinkInfo], pulls_plugins = [RustProcMacroPlugin]),
        "_rust_toolchain": attrs.toolchain_dep(default = "//buck2/toolchains:rust", providers = [RustToolchainInfo]),
        "_bun": attrs.exec_dep(default = "//buck2/toolchains:tool_bun", providers = [BuckSupportToolInfo]),
        "_pack": attrs.source(default = "//buck2/tests/library_closure:pack.mjs"),
    }),
    uses_plugins = [RustProcMacroPlugin],
)
