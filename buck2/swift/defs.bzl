"""Darwin Swift modules, executables, XCTest verdicts and app-bundle build products."""

load("//buck2/platforms:defs.bzl", "ProductPlatformInfo", "cache_guarded_rule", "native_execution_constraints", "product_platform_constraints", "root_allow_cache_uploads", "root_remote_cache_enabled")
load("//buck2/products:defs.bzl", "BuildProductInfo")
load("//buck2/provenance:defs.bzl", "ProductExecutableInfo", "product_artifact_info", "product_executable_info")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("//buck2/toolchains:defs.bzl", "BunToolchainInfo")

# One compiled Swift module and everything a dependent compile or link needs.
# Each module compiles twice, lazily: the release variant for products, and the
# testable variant (-Onone -enable-testing) that `@testable import` requires.
SwiftModuleInfo = provider(fields = {
    "module_name": str,
    # Transitive, dependencies before dependents' callers; deduplicated.
    "swiftmodules": list[Artifact],
    "objects": list[Artifact],
    "testable_swiftmodules": list[Artifact],
    "testable_objects": list[Artifact],
    "frameworks": list[str],
    "libraries": list[str],
})

_PLACEHOLDER = "__CLI_BUILD_STAMP__"

def _validate_bundle_component(value, subject):
    if not value or value != value.strip():
        fail("{} must not be empty or padded".format(subject))
    for character in value.elems():
        if character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-":
            fail("{} contains an unsupported character: {}".format(subject, character))

def _validate_relative_path(value, subject):
    if not value or value.startswith("/"):
        fail("{} must be a normalized relative path".format(subject))
    for component in value.split("/"):
        if component == "" or component == "." or component == "..":
            fail("{} must be a normalized relative path".format(subject))

def _darwin_platform(ctx, rule_name):
    platform = ctx.attrs.target_platform[ProductPlatformInfo]
    if platform.os != "darwin" or platform.abi != "darwin" or platform.runtime_contract != "mach-o-dynamic/v1":
        fail("{} admits only the Darwin Mach-O product platform".format(rule_name))
    if platform.architecture != "aarch64":
        fail("{} currently admits only aarch64 Darwin hosts".format(rule_name))
    return platform

def _swift_target_triple(platform):
    arch = "arm64" if platform.architecture == "aarch64" else "x86_64"
    return "{}-apple-macosx".format(arch)

def _cache_upload():
    return root_remote_cache_enabled() and root_allow_cache_uploads()

def _toolchain_identity(swiftc):
    return "swift={}:{}".format(swiftc.closure_identity, swiftc.content_digest)

def _module_name(ctx):
    name = ctx.attrs.module_name or ctx.label.name.replace("-", "_")
    if not name or name[0] in "0123456789":
        fail("Swift module name must be an identifier: {}".format(name))
    for character in name.elems():
        if character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_":
            fail("Swift module name must be an identifier: {}".format(name))
    return name

def _append_unique(target, values):
    for value in values:
        if value not in target:
            target.append(value)

def _transitive(deps, own_frameworks = [], own_libraries = []):
    merged = {
        "frameworks": [],
        "libraries": [],
        "objects": [],
        "swiftmodules": [],
        "testable_objects": [],
        "testable_swiftmodules": [],
    }
    for dep in deps:
        info = dep[SwiftModuleInfo]
        for field in merged:
            _append_unique(merged[field], getattr(info, field))
    _append_unique(merged["frameworks"], own_frameworks)
    _append_unique(merged["libraries"], own_libraries)
    return merged

def _sources(ctx, bun):
    """The module's sources with the canonical build stamp embedded, when one is configured."""
    sources = list(ctx.attrs.srcs)
    if not sources:
        fail("Swift module {} declares no sources".format(ctx.label.name))
    if ctx.attrs.stamp_source == "":
        return sources
    matches = [index for index, source in enumerate(sources) if source.short_path == ctx.attrs.stamp_source]
    if len(matches) != 1:
        fail("stamp_source {} must name exactly one of the module's sources".format(ctx.attrs.stamp_source))
    stamp = read_config("build_identity", "cli_build_stamp", "")
    if stamp == "":
        # Source builds keep the placeholder: the reader falls back to CLI_BUILD_STAMP.
        return sources
    original = sources[matches[0]]
    stamped = ctx.actions.declare_output("stamped", original.basename)
    ctx.actions.run(
        cmd_args([bun.executable, ctx.attrs._stamp_tool, original, stamped.as_output(), _PLACEHOLDER, stamp]),
        category = "swift_build_stamp",
        identifier = original.short_path,
        local_only = True,
        allow_cache_upload = _cache_upload(),
    )
    sources[matches[0]] = stamped
    return sources

def _compile(ctx, bun, swiftc, triple, module_name, sources, swiftmodules, testable, emit_module, parse_as_library, extra = []):
    variant = "testable" if testable else "release"
    swiftmodule = ctx.actions.declare_output("{}/modules/{}.swiftmodule".format(variant, module_name)) if emit_module else None
    obj = ctx.actions.declare_output(variant, module_name + ".o")
    args = cmd_args([
        bun.executable,
        ctx.attrs._compiler_runner,
        swiftc.store_path,
        "-target",
        triple,
        "-swift-version",
        ctx.attrs.swift_version,
        "-module-name",
        module_name,
        "-wmo",
        # Search paths and the working directory never enter module bytes: the
        # same sources produce the same module in every worktree.
        "-Xfrontend",
        "-no-serialize-debugging-options",
    ])
    args.add(["-Onone", "-enable-testing"] if testable else ["-O"])
    if parse_as_library:
        args.add("-parse-as-library")
    for feature in ctx.attrs.upcoming_features:
        args.add(["-enable-upcoming-feature", feature])
    for define in ctx.attrs.defines:
        args.add("-D" + define)
    for module in swiftmodules:
        args.add(cmd_args(module, parent = 1, format = "-I{}"))
    if emit_module:
        args.add(["-emit-module-path", swiftmodule.as_output()])
    args.add(extra)
    args.add(["-emit-object", "-o", obj.as_output()])
    args.add(sources)
    args.add(cmd_args(hidden = [swiftc.executable, swiftc.manifest]))

    # The declared Nix capability carries the SDK; hostile host values make
    # any ambient Xcode discovery fail closed instead of falling back.
    ctx.actions.run(
        args,
        category = "swift_compile",
        identifier = "{}/{}".format(variant, module_name),
        env = {
            "DEVELOPER_DIR": "/var/empty",
            "SDKROOT": "/var/empty",
        },
        local_only = True,
        allow_cache_upload = _cache_upload(),
    )
    return swiftmodule, obj

def _link(ctx, bun, swiftc, triple, output_name, objects, frameworks, libraries, identifier):
    executable = ctx.actions.declare_output(output_name)
    args = cmd_args([
        bun.executable,
        ctx.attrs._compiler_runner,
        swiftc.store_path,
        "-target",
        triple,
        "-emit-executable",
        "-o",
        executable.as_output(),
    ])
    args.add(objects)
    for framework in frameworks:
        args.add(["-framework", framework])
    for library in libraries:
        args.add("-l{}".format(library))
    args.add(cmd_args(hidden = [swiftc.executable, swiftc.manifest]))
    ctx.actions.run(
        args,
        category = "swift_link",
        identifier = identifier,
        env = {
            "DEVELOPER_DIR": "/var/empty",
            "SDKROOT": "/var/empty",
        },
        local_only = True,
        allow_cache_upload = _cache_upload(),
    )
    return executable

def _is_script_module(sources):
    # SwiftPM's rule: a `main.swift` holds top-level code; otherwise `@main`.
    return any([source.basename == "main.swift" for source in sources])

def _swift_library_impl(ctx):
    platform = _darwin_platform(ctx, "swift_library")
    bun = ctx.attrs._bun[BunToolchainInfo]
    swiftc = ctx.attrs.swiftc[BuckSupportToolInfo]
    triple = _swift_target_triple(platform) + ctx.attrs.minimum_os
    module_name = _module_name(ctx)
    sources = _sources(ctx, bun)
    merged = _transitive(ctx.attrs.deps, ctx.attrs.frameworks, ctx.attrs.libraries)
    swiftmodule, obj = _compile(ctx, bun, swiftc, triple, module_name, sources, merged["swiftmodules"], False, True, True)
    testable_module, testable_obj = _compile(ctx, bun, swiftc, triple, module_name, sources, merged["testable_swiftmodules"], True, True, True)
    return [
        DefaultInfo(default_outputs = [swiftmodule, obj]),
        SwiftModuleInfo(
            module_name = module_name,
            swiftmodules = merged["swiftmodules"] + [swiftmodule],
            objects = merged["objects"] + [obj],
            testable_swiftmodules = merged["testable_swiftmodules"] + [testable_module],
            testable_objects = merged["testable_objects"] + [testable_obj],
            frameworks = merged["frameworks"],
            libraries = merged["libraries"],
        ),
    ]

def _swift_binary_impl(ctx):
    platform = _darwin_platform(ctx, "swift_binary")
    bun = ctx.attrs._bun[BunToolchainInfo]
    swiftc = ctx.attrs.swiftc[BuckSupportToolInfo]
    triple = _swift_target_triple(platform) + ctx.attrs.minimum_os
    module_name = _module_name(ctx)
    sources = _sources(ctx, bun)
    merged = _transitive(ctx.attrs.deps, ctx.attrs.frameworks, ctx.attrs.libraries)
    _, obj = _compile(ctx, bun, swiftc, triple, module_name, sources, merged["swiftmodules"], False, False, not _is_script_module(sources))
    executable = _link(ctx, bun, swiftc, triple, ctx.attrs.executable_name or ctx.label.name, [obj] + merged["objects"], merged["frameworks"], merged["libraries"], ctx.label.name)
    product_executable = product_executable_info(
        ctx,
        executable = executable,
        recipe = "swift-binary:{}".format(ctx.label.raw_target()),
        toolchain = _toolchain_identity(swiftc),
        target_platform = platform,
    )
    return [
        DefaultInfo(default_output = executable),
        RunInfo(args = cmd_args(executable)),
        product_executable,
        product_artifact_info("executable", product_executable, platform, product_executable.provenance),
    ]

def _swift_test_impl(ctx):
    platform = _darwin_platform(ctx, "swift_test")
    bun = ctx.attrs._bun[BunToolchainInfo]
    swiftc = ctx.attrs.swiftc[BuckSupportToolInfo]
    triple = _swift_target_triple(platform) + ctx.attrs.minimum_os
    module_name = _module_name(ctx)
    sources = _sources(ctx, bun)
    merged = _transitive(ctx.attrs.deps, ctx.attrs.frameworks, ctx.attrs.libraries)

    # XCTest discovery on Darwin goes through the Objective-C runtime; the
    # toolchain capability's open-source XCTest needs an explicit test list,
    # derived from the compiler's symbol graph rather than source text.
    symbol_graph = ctx.actions.declare_output("symbol-graph", dir = True)
    test_module, test_obj = _compile(
        ctx,
        bun,
        swiftc,
        triple,
        module_name,
        sources,
        merged["testable_swiftmodules"],
        True,
        True,
        True,
        extra = [
            "-emit-symbol-graph",
            "-emit-symbol-graph-dir",
            symbol_graph.as_output(),
            "-symbol-graph-minimum-access-level",
            "internal",
        ],
    )
    main = ctx.actions.declare_output("entry", "main.swift")
    ctx.actions.run(
        cmd_args([bun.executable, ctx.attrs._test_main_tool, module_name, symbol_graph, main.as_output()]),
        category = "swift_test_main",
        local_only = True,
        allow_cache_upload = _cache_upload(),
    )
    _, main_obj = _compile(
        ctx,
        bun,
        swiftc,
        triple,
        module_name + "Main",
        [main],
        merged["testable_swiftmodules"] + [test_module],
        True,
        False,
        False,
    )
    executable = _link(
        ctx,
        bun,
        swiftc,
        triple,
        module_name,
        [main_obj, test_obj] + merged["testable_objects"],
        merged["frameworks"],
        merged["libraries"] + ["XCTest"],
        module_name,
    )

    # The suite runs as a build action whose successful result is the reusable
    # verdict; a failing suite fails the action and is never uploaded.
    verdict = ctx.actions.declare_output("verdict", dir = True)
    ctx.actions.run(
        cmd_args([bun.executable, ctx.attrs._test_verdict_tool, executable, verdict.as_output(), str(ctx.label.raw_target())]),
        category = "swift_test_verdict",
        local_only = True,
        allow_cache_upload = _cache_upload(),
    )
    return [
        DefaultInfo(
            default_output = verdict,
            sub_targets = {"executable": [DefaultInfo(default_output = executable)]},
        ),
    ]

_COMPILE_ATTRS = {
    "defines": attrs.list(attrs.string(), default = []),
    "deps": attrs.list(attrs.dep(providers = [SwiftModuleInfo]), default = []),
    "frameworks": attrs.list(attrs.string(), default = []),
    "libraries": attrs.list(attrs.string(), default = []),
    "minimum_os": attrs.string(default = "14.0"),
    "module_name": attrs.string(default = ""),
    "srcs": attrs.list(attrs.source()),
    "stamp_source": attrs.string(default = ""),
    "swift_version": attrs.enum(["5", "6"], default = "6"),
    "swiftc": attrs.exec_dep(providers = [BuckSupportToolInfo]),
    "target_platform": attrs.dep(providers = [ProductPlatformInfo]),
    "upcoming_features": attrs.list(attrs.string(), default = []),
    "_bun": attrs.default_only(attrs.exec_dep(
        default = "//buck2/toolchains:bun",
        providers = [BunToolchainInfo],
    )),
    "_compiler_runner": attrs.default_only(attrs.source(
        default = "//buck2/swift:compile",
    )),
    "_stamp_tool": attrs.default_only(attrs.source(
        default = "//buck2/swift:stamp",
    )),
}

_swift_library = cache_guarded_rule(
    impl = _swift_library_impl,
    attrs = _COMPILE_ATTRS,
)

_swift_binary = cache_guarded_rule(
    impl = _swift_binary_impl,
    attrs = _COMPILE_ATTRS | {
        "executable_name": attrs.string(default = ""),
    },
)

_swift_test = cache_guarded_rule(
    impl = _swift_test_impl,
    attrs = _COMPILE_ATTRS | {
        "_test_main_tool": attrs.default_only(attrs.source(
            default = "//buck2/swift:test-main",
        )),
        "_test_verdict_tool": attrs.default_only(attrs.source(
            default = "//buck2/swift:test-verdict",
        )),
    },
)

def _platform_kwargs(target_platform, kwargs):
    if "target_compatible_with" in kwargs:
        fail("Swift rules own target compatibility")
    return dict(
        kwargs,
        default_target_platform = target_platform,
        target_compatible_with = product_platform_constraints(target_platform),
        exec_compatible_with = native_execution_constraints(target_platform),
    )

def swift_library(name, swiftc, target_platform, srcs, **kwargs):
    """One Swift module compiled whole-module from `srcs` against `deps`' modules.

    Mirrors a SwiftPM library target: `module_name` defaults to `name` with
    dashes as underscores. `stamp_source` names the one source whose
    `"__CLI_BUILD_STAMP__"` literal receives `build_identity.cli_build_stamp`.
    """
    _swift_library(name = name, swiftc = swiftc, target_platform = target_platform, srcs = srcs, **_platform_kwargs(target_platform, kwargs))

def swift_binary(name, swiftc, target_platform, srcs, **kwargs):
    """A Swift executable module linked with its transitive module objects.

    A source named `main.swift` holds top-level code, as in SwiftPM; otherwise
    the module's `@main` type is the entry point. The binary is a product
    executable payload for `build_product` and `swift_app_bundle`.
    """
    _swift_binary(name = name, swiftc = swiftc, target_platform = target_platform, srcs = srcs, **_platform_kwargs(target_platform, kwargs))

def swift_test(name, swiftc, target_platform, srcs, **kwargs):
    """An XCTest module run as a cacheable verdict action.

    The suite links the testable variants of `deps`, so `@testable import`
    works as under `swift test`. Its default output is the verdict directory
    (`result.json`, `report.json`); `[executable]` is the linked runner.
    """
    _swift_test(name = name, swiftc = swiftc, target_platform = target_platform, srcs = srcs, **_platform_kwargs(target_platform, kwargs))

def _swift_app_bundle_impl(ctx):
    platform = _darwin_platform(ctx, "swift_app_bundle")
    _validate_bundle_component(ctx.attrs.bundle_name, "swift_app_bundle bundle_name")
    _validate_bundle_component(ctx.attrs.bundle_id, "swift_app_bundle bundle_id")
    if ctx.attrs.icon_basename != "":
        _validate_bundle_component(ctx.attrs.icon_basename, "swift_app_bundle icon_basename")
    _validate_bundle_component(ctx.attrs.main_executable, "swift_app_bundle main_executable")
    _validate_bundle_component(ctx.attrs.version, "swift_app_bundle version")
    if not ctx.attrs.binaries:
        fail("swift_app_bundle must declare at least one binary")
    for name in ctx.attrs.binaries:
        _validate_bundle_component(name, "swift_app_bundle binary name")
        if (name in ctx.attrs.sources) == (name in ctx.attrs.executables):
            fail("swift_app_bundle binary {} needs exactly one of sources or executables".format(name))
        if name in ctx.attrs.sources and not ctx.attrs.sources[name]:
            fail("swift_app_bundle binary {} declares no sources".format(name))
    for name in list(ctx.attrs.sources) + list(ctx.attrs.executables):
        if name not in ctx.attrs.binaries:
            fail("swift_app_bundle declares an undeclared binary: {}".format(name))
    if ctx.attrs.main_executable not in ctx.attrs.binaries:
        fail("swift_app_bundle main_executable must name one of the binaries")
    bundle_root = "Applications/{}.app".format(ctx.attrs.bundle_name)
    bundle_root_prefix = bundle_root + "/"
    _validate_relative_path(bundle_root, "swift_app_bundle bundle root")
    for destination in ctx.attrs.resources:
        _validate_relative_path(destination, "swift_app_bundle resource destination")
        if not destination.startswith(bundle_root_prefix):
            fail("swift_app_bundle resource destination is outside the bundle root: {}".format(destination))

    bun = ctx.attrs._bun[BunToolchainInfo]
    swiftc = ctx.attrs.swiftc[BuckSupportToolInfo]
    triple = _swift_target_triple(platform) + ctx.attrs.minimum_os

    binaries = {}
    for name, dep in ctx.attrs.executables.items():
        executable = dep[ProductExecutableInfo]
        actual = (executable.target_platform_os, executable.target_platform_architecture, executable.target_platform_abi, executable.target_platform_runtime_contract)
        if actual != (platform.os, platform.architecture, platform.abi, platform.runtime_contract):
            fail("swift_app_bundle executable {} targets {}, not the bundle platform".format(name, actual))
        binaries[name] = executable.executable

    # Concatenate each source binary's sources into one file: only a single-file
    # compile may hold top-level code, and consumer bundles compose their
    # daemon sources exactly this way.
    for name, sources in ctx.attrs.sources.items():
        combined = ctx.actions.declare_output("swift-{}.swift".format(name))
        concat_args = cmd_args([
            bun.executable,
            "-e",
            "const [output, ...paths] = process.argv.slice(1); const texts = await Promise.all(paths.map((path) => Bun.file(path).text())); await Bun.write(output, texts.join('\\n\\n'))",
            combined.as_output(),
            sources,
        ])
        ctx.actions.run(
            concat_args,
            category = "swift_app_bundle_sources",
            identifier = name,
            local_only = True,
            allow_cache_upload = _cache_upload(),
        )
        executable = ctx.actions.declare_output(name)
        compile_args = cmd_args([
            bun.executable,
            ctx.attrs._compiler_runner,
            swiftc.store_path,
            "-O",
            "-target",
            triple,
            "-o",
            executable.as_output(),
            combined,
        ])
        compile_args.add(cmd_args(hidden = [swiftc.executable, swiftc.manifest]))
        for framework in ctx.attrs.frameworks.get(name, []):
            compile_args.add(["-framework", framework])
        for library in ctx.attrs.libraries.get(name, []):
            compile_args.add(["-l{}".format(library)])

        # The declared Nix capability carries the SDK; hostile host values make
        # any ambient Xcode discovery fail closed instead of falling back.
        ctx.actions.run(
            compile_args,
            category = "swift_app_bundle_compile",
            identifier = name,
            env = {
                "DEVELOPER_DIR": "/var/empty",
                "SDKROOT": "/var/empty",
            },
            local_only = True,
            allow_cache_upload = _cache_upload(),
        )
        binaries[name] = executable

    plist_entries = {
        "CFBundleExecutable": ctx.attrs.main_executable,
        "CFBundleIdentifier": ctx.attrs.bundle_id,
        "CFBundleName": ctx.attrs.bundle_name,
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": ctx.attrs.version,
        "CFBundleVersion": ctx.attrs.version,
    }
    if ctx.attrs.icon_basename != "":
        plist_entries["CFBundleIconFile"] = ctx.attrs.icon_basename
    plist_entries["LSUIElement"] = True
    plist_input = ctx.actions.write_json("info-plist.json", {
        # Ordered pairs: the rule's keys keep their declared order.
        "entries": [[key, value] for key, value in plist_entries.items()],
        "extra": json.decode(ctx.attrs.info_plist_extra) if ctx.attrs.info_plist_extra else {},
    })
    plist = ctx.actions.declare_output("Info.plist")
    ctx.actions.run(
        cmd_args([bun.executable, ctx.attrs._info_plist_tool, plist_input, plist.as_output()]),
        category = "swift_app_bundle_info_plist",
        local_only = True,
        allow_cache_upload = _cache_upload(),
    )

    stamp = read_config("build_identity", "cli_build_stamp", "")
    stamp_input = None
    if stamp != "":
        stamp_input = ctx.actions.declare_output("nix-build-stamp.json")
        ctx.actions.write(stamp_input, stamp + "\n")

    provenance = ctx.actions.declare_output("build-provenance.json")
    ctx.actions.write_json(
        provenance,
        {
            "recipe": "swift-app-bundle:{}".format(bundle_root),
            "schema": "buck-build-provenance/v1",
            "toolchain": _toolchain_identity(swiftc),
        },
        pretty = True,
    )

    payload = ctx.actions.declare_output("artifact.tar")
    descriptor = ctx.actions.declare_output("descriptor.json")
    args = cmd_args([
        ctx.attrs._descriptor_tool[RunInfo],
        "package-app-bundle",
        "--bundle-root",
        bundle_root,
        "--main-executable",
        bundle_root_prefix + "Contents/MacOS/" + ctx.attrs.main_executable,
        "--artifact",
        payload.as_output(),
        "--name",
        ctx.attrs.product_name,
        "--target",
        str(ctx.label.raw_target()),
        "--platform-os",
        platform.os,
        "--platform-architecture",
        platform.architecture,
        "--platform-abi",
        platform.abi,
        "--provenance",
        provenance,
        "--descriptor",
        descriptor.as_output(),
        "--bundle-plist",
        plist,
    ])
    if stamp_input != None:
        args.add(["--bundle-stamp", stamp_input])
    for name in ctx.attrs.binaries:
        args.add(["--bundle-executable", cmd_args([
            bundle_root_prefix + "Contents/MacOS/" + name,
            "=",
            binaries[name],
        ], delimiter = "")])
    for destination in sorted(ctx.attrs.resources):
        args.add(["--bundle-resource", cmd_args([
            destination,
            "=",
            ctx.attrs.resources[destination],
        ], delimiter = "")])
    ctx.actions.run(
        args,
        category = "swift_app_bundle_package",
        local_only = True,
        allow_cache_upload = _cache_upload(),
    )
    return [
        DefaultInfo(
            default_output = payload,
            other_outputs = [descriptor],
            sub_targets = {
                "descriptor": [DefaultInfo(default_output = descriptor)],
            },
        ),
        BuildProductInfo(descriptor = descriptor, payload = payload),
    ]

_swift_app_bundle = cache_guarded_rule(
    impl = _swift_app_bundle_impl,
    attrs = {
        "binaries": attrs.list(attrs.string()),
        "bundle_id": attrs.string(),
        "bundle_name": attrs.string(),
        "executables": attrs.dict(key = attrs.string(), value = attrs.dep(providers = [ProductExecutableInfo]), default = {}),
        "frameworks": attrs.dict(key = attrs.string(), value = attrs.list(attrs.string()), default = {}),
        "icon_basename": attrs.string(default = ""),
        "info_plist_extra": attrs.string(default = ""),
        "libraries": attrs.dict(key = attrs.string(), value = attrs.list(attrs.string()), default = {}),
        "main_executable": attrs.string(),
        "minimum_os": attrs.string(default = "14.0"),
        "product_name": attrs.string(),
        "resources": attrs.dict(key = attrs.string(), value = attrs.source(), default = {}),
        "sources": attrs.dict(key = attrs.string(), value = attrs.list(attrs.source()), default = {}),
        "swiftc": attrs.exec_dep(providers = [BuckSupportToolInfo]),
        "target_platform": attrs.dep(providers = [ProductPlatformInfo]),
        "version": attrs.string(),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:bun",
            providers = [BunToolchainInfo],
        )),
        "_compiler_runner": attrs.default_only(attrs.source(
            default = "//buck2/swift:compile",
        )),
        "_descriptor_tool": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:product_tool",
            providers = [RunInfo],
        )),
        "_info_plist_tool": attrs.default_only(attrs.source(
            default = "//buck2/swift:info-plist",
        )),
    },
)

def swift_app_bundle(
        name,
        swiftc,
        target_platform,
        bundle_name,
        bundle_id,
        version,
        main_executable,
        binaries,
        product_name,
        sources = {},
        executables = {},
        frameworks = {},
        libraries = {},
        resources = {},
        icon_basename = "",
        info_plist_extra = "",
        minimum_os = "14.0",
        **kwargs):
    """Builds one unsigned Darwin app bundle as a build_product artifact.

    Each binary either compiles from its concatenated Swift `sources` with the
    declared Nix swiftc capability, or is a `swift_binary` named in
    `executables`. `info_plist_extra` is a JSON object of further Info.plist
    keys; it cannot override the rule's own keys. The product tool assembles
    the bundle, archives it, and emits the buck-build-product/v1 descriptor.
    The bundle lands under Applications/<bundle_name>.app with the declared
    main executable.
    """
    _swift_app_bundle(
        name = name,
        swiftc = swiftc,
        target_platform = target_platform,
        bundle_name = bundle_name,
        bundle_id = bundle_id,
        version = version,
        main_executable = main_executable,
        binaries = binaries,
        sources = sources,
        executables = executables,
        product_name = product_name,
        frameworks = frameworks,
        libraries = libraries,
        resources = resources,
        icon_basename = icon_basename,
        info_plist_extra = info_plist_extra,
        minimum_os = minimum_os,
        **_platform_kwargs(target_platform, kwargs)
    )
