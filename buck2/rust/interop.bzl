"""Rust interop products: one wasm compilation per group, native-only Node-API."""

load("@prelude//:prelude.bzl", "native")
load("@prelude//rust:rust_toolchain.bzl", "PanicRuntime", "RustToolchainInfo")
load("//buck2/platforms:defs.bzl", "cache_guarded_rule", "host_execution_constraints", "root_allow_cache_uploads", "root_remote_cache_enabled")
load("//buck2/products:defs.bzl", "BuildProductInfo")
load("//buck2/rust:toolchains.bzl", "WASM_OPT_FLAGS")
load("//buck2/dependencies:defs.bzl", "PnpmDeclaredClosureInfo")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("//buck2/toolchains:defs.bzl", "BunToolchainInfo")

RustInteropProductInfo = provider(fields = {"package": Artifact, "kind": str})

def _wasm_transition_impl(platform, refs, attrs):
    constraints = dict(platform.configuration.constraints)
    for ref in [refs.wasm32, getattr(refs, "opt_" + attrs.opt_level), getattr(refs, "lto_" + attrs.lto), getattr(refs, "strip_" + attrs.strip)]:
        value = ref[ConstraintValueInfo]
        constraints[value.setting.label] = value
    return PlatformInfo(
        label = platform.label.split("-wasm32-")[0] + "-wasm32-" + attrs.opt_level + "-" + attrs.lto + "-" + attrs.strip,
        configuration = ConfigurationInfo(constraints = constraints, values = platform.configuration.values),
    )

_wasm_transition = transition(
    impl = _wasm_transition_impl,
    refs = dict({"wasm32": "//buck2/rust:wasm32"}, **{
        key: "//buck2/rust:" + key
        for key in ["opt_0", "opt_1", "opt_2", "opt_3", "opt_s", "opt_z", "lto_fat", "lto_thin", "lto_off", "strip_symbols", "strip_debuginfo", "strip_none"]
    }),
    attrs = ["opt_level", "lto", "strip"],
)

def _product_impl(ctx):
    if ctx.attrs.kind == "napi":
        toolchain = ctx.attrs._rust[RustToolchainInfo]
        if toolchain.rustc_target_triple == "wasm32-unknown-unknown" or toolchain.panic_runtime != PanicRuntime("unwind"):
            fail("Node-API products require a native Rust toolchain with panic=unwind")
    outputs = ctx.attrs.crate[DefaultInfo].default_outputs
    if len(outputs) != 1:
        fail("interop product requires exactly one cdylib output")
    package = ctx.actions.declare_output("package", dir = True)
    command = cmd_args([
        ctx.attrs._bun[BunToolchainInfo].executable,
        ctx.attrs._packager,
        ctx.attrs.kind,
        "--input",
        outputs[0],
        "--output",
        package.as_output(),
        "--name",
        ctx.attrs.out_name,
    ])
    if ctx.attrs.kind == "wasm":
        bindgen = ctx.attrs._bindgen[BuckSupportToolInfo]
        wasm_opt = ctx.attrs._wasm_opt[BuckSupportToolInfo]
        command.add("--bindgen", bindgen.store_path, "--wasm-opt", wasm_opt.store_path)
        command.add(cmd_args(hidden = [bindgen.executable, bindgen.manifest, wasm_opt.executable, wasm_opt.manifest]))
        command.add("--opt-level", ctx.attrs.opt_level, "--lto", ctx.attrs.lto, "--strip", ctx.attrs.strip)
        command.add("--optimizer-flags", json.encode(WASM_OPT_FLAGS))
    ctx.actions.run(command, category = "rust_interop_" + ctx.attrs.kind)
    return [
        DefaultInfo(default_output = package),
        RustInteropProductInfo(package = package, kind = ctx.attrs.kind),
    ]

_COMMON_ATTRS = {
    "kind": attrs.enum(["wasm", "napi"]),
    "out_name": attrs.string(),
    "_bun": attrs.default_only(attrs.exec_dep(default = "//buck2/toolchains:bun", providers = [BunToolchainInfo])),
    "_packager": attrs.default_only(attrs.source(default = "//buck2/rust:interop-package.ts")),
}
_WASM_ATTRS = dict(_COMMON_ATTRS)
_WASM_ATTRS.update({
    "crate": attrs.transition_dep(cfg = _wasm_transition, providers = [DefaultInfo]),
    "opt_level": attrs.enum(["0", "1", "2", "3", "s", "z"], default = "s"),
    "lto": attrs.enum(["fat", "thin", "off"], default = "fat"),
    "strip": attrs.enum(["symbols", "debuginfo", "none"], default = "symbols"),
    "_bindgen": attrs.default_only(attrs.exec_dep(default = "//buck2/toolchains:tool_wasm_bindgen", providers = [BuckSupportToolInfo])),
    "_wasm_opt": attrs.default_only(attrs.exec_dep(default = "//buck2/toolchains:tool_wasm_opt", providers = [BuckSupportToolInfo])),
})
_rust_wasm_bindgen_library = cache_guarded_rule(impl = _product_impl, attrs = _WASM_ATTRS)
_NAPI_ATTRS = dict(_COMMON_ATTRS)
_NAPI_ATTRS["crate"] = attrs.dep(providers = [DefaultInfo])
_NAPI_ATTRS["_rust"] = attrs.default_only(attrs.toolchain_dep(default = "//buck2/toolchains:rust", providers = [RustToolchainInfo]))
_rust_napi_library = cache_guarded_rule(impl = _product_impl, attrs = _NAPI_ATTRS)

def rust_wasm_bindgen_library(name, crate, out_name = None, profile = {}, **kwargs):
    """Node CJS, inline web, URL, and Workers precompiled-Module package entries."""
    for key in profile:
        if key not in ["opt_level", "lto", "strip"]:
            fail("unsupported wasm profile override: " + key)
    _rust_wasm_bindgen_library(
        name = name,
        crate = crate + "[cdylib]",
        kind = "wasm",
        out_name = out_name or name.replace("-", "_"),
        **dict(kwargs, **profile)
    )

def rust_napi_library(name, crate, out_name = None, **kwargs):
    """Native builder only; panic=abort is never admitted for Node-API products."""
    if read_config("rust_profile", "panic", "unwind") != "unwind":
        fail("rust_napi_library requires panic=unwind")
    _rust_napi_library(
        name = name,
        crate = crate + "[cdylib]",
        kind = "napi",
        out_name = out_name or name.replace("-", "_"),
        exec_compatible_with = host_execution_constraints(),
        **kwargs
    )

def _wasm_guest_impl(ctx):
    outputs = ctx.attrs.crate[DefaultInfo].default_outputs
    if len(outputs) != 1:
        fail("wasm guest requires exactly one cdylib output")
    payload = ctx.actions.declare_output("artifact.tar")
    descriptor = ctx.actions.declare_output("descriptor.json")
    provenance = ctx.actions.write_json("provenance.json", {
        "recipe": ctx.attrs.recipe,
        "schema": "buck-build-provenance/v1",
        "toolchain": ctx.attrs.toolchain,
    })
    command = cmd_args([
        ctx.attrs._bun[BunToolchainInfo].executable,
        ctx.attrs._packager,
        "--input",
        outputs[0],
        "--payload",
        payload.as_output(),
        "--descriptor",
        descriptor.as_output(),
        "--name",
        ctx.attrs.product_name,
        "--entrypoint",
        ctx.attrs.entrypoint,
        "--target",
        str(ctx.label.raw_target()),
        "--harness",
        ctx.attrs.harness,
        "--provenance",
        provenance,
    ])
    ctx.actions.run(command, category = "rust_wasm_guest")
    return [
        DefaultInfo(
            default_output = payload,
            other_outputs = [descriptor],
            sub_targets = {"descriptor": [DefaultInfo(default_output = descriptor)]},
        ),
        BuildProductInfo(descriptor = descriptor, payload = payload),
    ]

_wasm_guest = cache_guarded_rule(impl = _wasm_guest_impl, attrs = {
    "crate": attrs.transition_dep(cfg = _wasm_transition, providers = [DefaultInfo]),
    "product_name": attrs.string(),
    "entrypoint": attrs.string(),
    "harness": attrs.string(),
    "recipe": attrs.string(),
    "toolchain": attrs.string(),
    "opt_level": attrs.enum(["0", "1", "2", "3", "s", "z"], default = "s"),
    "lto": attrs.enum(["fat", "thin", "off"], default = "fat"),
    "strip": attrs.enum(["symbols", "debuginfo", "none"], default = "symbols"),
    "_bun": attrs.default_only(attrs.exec_dep(default = "//buck2/toolchains:bun", providers = [BunToolchainInfo])),
    "_packager": attrs.default_only(attrs.source(default = "//buck2/rust:wasm-guest-package.ts")),
})

def rust_wasm_guest(name, crate, product_name, entrypoint, harness, recipe, toolchain, profile = {}, **kwargs):
    """Raw wasm32-unknown-unknown guest for one declared host harness."""
    for key in profile:
        if key not in ["opt_level", "lto", "strip"]:
            fail("unsupported wasm guest profile override: " + key)
    _wasm_guest(
        name = name,
        crate = crate + "[cdylib]",
        product_name = product_name,
        entrypoint = entrypoint,
        harness = harness,
        recipe = recipe,
        toolchain = toolchain,
        **dict(kwargs, **profile)
    )

def _service_impl(ctx):
    if ctx.attrs.wasm == None and ctx.attrs.napi == None:
        fail("rust_interop_service needs a wasm or napi product")
    package = ctx.actions.declare_output("service", dir = True)
    compiler = ctx.attrs.compiler[DefaultInfo]
    if len(compiler.default_outputs) != 1:
        fail("compiler must expose exactly one package tree")
    command = cmd_args([
        ctx.attrs._bun[BunToolchainInfo].executable,
        ctx.attrs._generator,
        "--output", package.as_output(),
        "--service", ctx.attrs.service,
        "--package", ctx.attrs.package_name,
        "--compiler", compiler.default_outputs[0],
    ], hidden = compiler.other_outputs)
    for kind, product in [("wasm", ctx.attrs.wasm), ("napi", ctx.attrs.napi)]:
        if product != None:
            info = product[RustInteropProductInfo]
            if info.kind != kind:
                fail("rust_interop_service " + kind + " expects a " + kind + " product, got " + info.kind)
            command.add("--" + kind, info.package)
    # Schema records are read by instantiating the product (wasm preferred; the addon needs the host).
    ctx.actions.run(command, category = "rust_interop_service", local_only = True)
    return [DefaultInfo(default_output = package)]

_rust_interop_service = rule(impl = _service_impl, attrs = {
    "service": attrs.string(),
    "package_name": attrs.string(),
    "wasm": attrs.option(attrs.dep(providers = [RustInteropProductInfo]), default = None),
    "napi": attrs.option(attrs.dep(providers = [RustInteropProductInfo]), default = None),
    "compiler": attrs.dep(providers = [DefaultInfo]),
    "_bun": attrs.default_only(attrs.exec_dep(default = "//buck2/toolchains:bun", providers = [BunToolchainInfo])),
    "_generator": attrs.default_only(attrs.source(default = "//buck2/rust:interop-service.ts")),
})


def rust_interop_service(name, service, wasm = None, napi = None, package_name = None, compiler = "//packages/@overeng/effect-rust:package_tree", **kwargs):
    """One Effect `Context.Service` class per adapter crate, fed by whichever products are built.

    `layerWasm` exists only with a wasm product, `layerNative` only with a napi product.
    Serde domain arguments/results are imported through the effect-rust contract compiler.
    """
    _rust_interop_service(
        name = name,
        service = service,
        package_name = package_name or name,
        wasm = wasm,
        napi = napi,
        compiler = compiler,
        exec_compatible_with = host_execution_constraints(),
        **kwargs
    )


def _aggregator_source_impl(ctx):
    return [DefaultInfo(default_output = ctx.actions.write("src/lib.rs", ctx.attrs.source))]

_aggregator_source = cache_guarded_rule(impl = _aggregator_source_impl, attrs = {
    "source": attrs.string(),
})

def _aggregator_impl(ctx):
    entries = {group: dep[RustInteropProductInfo].package for group, dep in ctx.attrs.groups.items()}
    entries["index.ts"] = ctx.actions.write("index.ts", ctx.attrs.entry)
    entries["manifest.json"] = ctx.actions.write_json("manifest.json", ctx.attrs.manifest)

    # Copied, not symlinked: runtimes and bundlers resolve `./<group>/…` from the entry's real path.
    app = ctx.actions.copied_dir("app", entries)
    return [DefaultInfo(default_output = app), RustInteropProductInfo(package = app, kind = "aggregator")]

_aggregator = cache_guarded_rule(impl = _aggregator_impl, attrs = {
    "groups": attrs.dict(attrs.string(), attrs.dep(providers = [RustInteropProductInfo])),
    "entry": attrs.string(),
    "manifest": attrs.dict(attrs.string(), attrs.list(attrs.string())),
})

def _identifier(value):
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_"
    return value and value[0] in alphabet and all([c in alphabet + "0123456789" for c in value.elems()])


def rust_wasm_aggregator(name, manifest, crates, profile = {}, **kwargs):
    """Link adapter re-exports; macro manifests own the generated TS contract."""
    if not manifest or "eager" not in manifest:
        fail("aggregator manifest must declare its eager group")
    assigned = {}
    groups = {}
    entry = []
    for group, names in manifest.items():
        if not group or group[0] not in "abcdefghijklmnopqrstuvwxyz" or any([c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in group.elems()]):
            fail("invalid aggregator group: " + group)
        if not names:
            fail("aggregator groups must contain at least one core")
        alias = group.replace("-", "_")
        source = []
        dependencies = {}
        for core in names:
            if core not in crates:
                fail("unknown aggregator crate: " + core)
            if core in assigned:
                fail("core assigned more than once: " + core)
            if not _identifier(core):
                fail("core keys must be Rust crate identifiers: " + core)
            assigned[core] = group
            dependencies[core] = crates[core]
            source.append("pub use " + core + "::*;")
        source_name = name + "-" + group + "-source"
        crate_name = name + "-" + group + "-crate"
        product_name = name + "-" + group
        _aggregator_source(name = source_name, source = "\n".join(source) + "\n")

        # wasm-bindgen's macros read Cargo's package environment; the generated crate
        # root is its manifest directory inside the Buck source tree.
        package_env = {
            "CARGO_CRATE_NAME": alias,
            "CARGO_MANIFEST_DIR": ".",
            "CARGO_PKG_NAME": product_name,
            "CARGO_PKG_VERSION": "0.0.0",
        }
        native.rust_library(name = crate_name, srcs = [":" + source_name], crate_root = "src/lib.rs", crate = alias, edition = "2021", env = package_env, named_deps = dependencies)
        rust_wasm_bindgen_library(name = product_name, crate = ":" + crate_name, profile = profile, **kwargs)
        groups[group] = ":" + product_name
        if group == "eager":
            entry.append('export * as eager from "./eager/web/inline.js"')
        else:
            entry.append('export const ' + alias + ' = () => import("./' + group + '/web/inline.js")')
    unused = [core for core in crates if core not in assigned]
    if unused:
        fail("unassigned aggregator crates: " + ", ".join(unused))
    _aggregator(name = name, groups = groups, manifest = manifest, entry = "\n".join(entry) + "\n", **kwargs)

def _smoke_impl(ctx):
    if ctx.attrs.runtime == "bun":
        executable = ctx.attrs._bun[BunToolchainInfo].executable
    else:
        node = ctx.attrs._node[BuckSupportToolInfo]
        executable = cmd_args(node.store_path, hidden = [node.executable, node.manifest])
    command = cmd_args([executable, ctx.attrs.script, ctx.attrs.product[RustInteropProductInfo].package])
    verdict = ctx.actions.declare_output("smoke.json")
    ctx.actions.run(command, env = {"RUST_INTEROP_SMOKE_OUTPUT": verdict.as_output()}, category = "rust_interop_smoke")
    return [DefaultInfo(default_output = verdict), RunInfo(args = command), ExternalRunnerTestInfo(
        type = "rust_interop",
        command = [command],
        default_executor = CommandExecutorConfig(local_enabled = True, remote_enabled = False, remote_cache_enabled = root_remote_cache_enabled(), allow_cache_uploads = root_allow_cache_uploads(), use_windows_path_separators = False),
    )]

rust_interop_smoke = cache_guarded_rule(impl = _smoke_impl, attrs = {
    "product": attrs.dep(providers = [RustInteropProductInfo]),
    "runtime": attrs.enum(["node", "bun"], default = "node"),
    "script": attrs.source(),
    "_bun": attrs.default_only(attrs.exec_dep(default = "//buck2/toolchains:bun", providers = [BunToolchainInfo])),
    "_node": attrs.default_only(attrs.exec_dep(default = "//buck2/toolchains:tool_node", providers = [BuckSupportToolInfo])),
})

def _service_smoke_impl(ctx):
    dependencies = ctx.attrs.compiler[PnpmDeclaredClosureInfo]
    service = ctx.attrs.service[DefaultInfo].default_outputs[0]
    # Node does not strip TypeScript inside node_modules: exercise the emitted package.
    runtime_dist = ctx.attrs.runtime_dist[DefaultInfo].default_outputs[0]
    runtime_manifest = ctx.actions.write_json("runtime-package.json", {
        "name": "@overeng/effect-rust",
        "type": "module",
        "exports": {".": "./dist/src/mod.js", "./runtime": "./dist/src/runtime/interop.js", "./schema": "./dist/src/schema/mod.js", "./compiler": "./dist/src/compiler/mod.js"},
    })
    tree = ctx.actions.copied_dir("fixture", {
        "service": service,
        "service-smoke.ts": ctx.attrs.script,
        "vectors.json": ctx.attrs.vectors,
        "node_modules/effect": dependencies.node_modules.project("effect"),
        "node_modules/@overeng/effect-rust/package.json": runtime_manifest,
        "node_modules/@overeng/effect-rust/dist": runtime_dist,
    })
    if ctx.attrs.runtime == "bun":
        executable = ctx.attrs._bun[BunToolchainInfo].executable
    else:
        node = ctx.attrs._node[BuckSupportToolInfo]
        executable = cmd_args(node.store_path, hidden = [node.executable, node.manifest])
    command = cmd_args([executable, tree.project("service-smoke.ts"), tree.project("service"), tree.project("vectors.json")], hidden = [tree] + dependencies.read_roots)
    verdict = ctx.actions.declare_output("service-smoke.json")
    ctx.actions.run(command, env = {"RUST_INTEROP_SMOKE_OUTPUT": verdict.as_output()}, category = "rust_interop_service_smoke", local_only = True)
    return [DefaultInfo(default_output = verdict), RunInfo(args = command), ExternalRunnerTestInfo(
        type = "rust_interop",
        command = [command],
        default_executor = CommandExecutorConfig(local_enabled = True, remote_enabled = False, remote_cache_enabled = root_remote_cache_enabled(), allow_cache_uploads = root_allow_cache_uploads(), use_windows_path_separators = False),
    )]

rust_interop_service_smoke = rule(impl = _service_smoke_impl, attrs = {
    "service": attrs.dep(),
    "compiler": attrs.dep(default = "//packages/@overeng/effect-rust:package_tree"),
    "runtime_dist": attrs.dep(default = "//packages/@overeng/effect-rust:dist"),
    "runtime": attrs.enum(["node", "bun"], default = "node"),
    "script": attrs.source(),
    "vectors": attrs.source(),
    "_bun": attrs.default_only(attrs.exec_dep(default = "//buck2/toolchains:bun", providers = [BunToolchainInfo])),
    "_node": attrs.default_only(attrs.exec_dep(default = "//buck2/toolchains:tool_node", providers = [BuckSupportToolInfo])),
})
