"""Minimal Darwin Swift app-bundle build product."""

load("//buck2/platforms:defs.bzl", "ProductPlatformInfo", "native_execution_constraints", "product_platform_constraints", "root_allow_cache_uploads", "root_remote_cache_enabled")
load("//buck2/products:defs.bzl", "BuildProductInfo")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("//buck2/toolchains:defs.bzl", "BunToolchainInfo")


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

def _swift_target_triple(platform):
    arch = "arm64" if platform.architecture == "aarch64" else "x86_64"
    return "{}-apple-macosx".format(arch)

def _swift_app_bundle_impl(ctx):
    platform = ctx.attrs.target_platform[ProductPlatformInfo]
    if platform.os != "darwin" or platform.abi != "darwin" or platform.runtime_contract != "mach-o-dynamic/v1":
        fail("swift_app_bundle admits only the Darwin Mach-O product platform")
    if platform.architecture != "aarch64":
        fail("swift_app_bundle currently admits only aarch64 Darwin hosts")
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
        if not ctx.attrs.sources.get(name):
            fail("swift_app_bundle binary {} declares no sources".format(name))
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

    # Concatenate each binary's sources into one file: only a single-file
    # compile may hold top-level code, and consumer bundles compose their
    # daemon sources exactly this way.
    binaries = {}
    for name in ctx.attrs.binaries:
        combined = ctx.actions.declare_output("swift-{}.swift".format(name))
        sources = ctx.attrs.sources[name]
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
            allow_cache_upload = root_remote_cache_enabled() and root_allow_cache_uploads(),
        )
        executable = ctx.actions.declare_output(name)
        compile_args = cmd_args([
            bun.executable,
            ctx.attrs._compiler_runner,
            swiftc.store_path,
            "-O",
            "-target", triple,
            "-o", executable.as_output(),
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
            allow_cache_upload = root_remote_cache_enabled() and root_allow_cache_uploads(),
        )
        binaries[name] = executable

    icon_keys = []
    if ctx.attrs.icon_basename != "":
        icon_keys = ["  <key>CFBundleIconFile</key>", "  <string>{}</string>".format(ctx.attrs.icon_basename)]
    plist = ctx.actions.declare_output("Info.plist")
    ctx.actions.write(
        plist,
        "\n".join([
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
            '<plist version="1.0">',
            "<dict>",
            "  <key>CFBundleExecutable</key>",
            "  <string>{}</string>".format(ctx.attrs.main_executable),
            "  <key>CFBundleIdentifier</key>",
            "  <string>{}</string>".format(ctx.attrs.bundle_id),
            "  <key>CFBundleName</key>",
            "  <string>{}</string>".format(ctx.attrs.bundle_name),
            "  <key>CFBundlePackageType</key>",
            "  <string>APPL</string>",
            "  <key>CFBundleShortVersionString</key>",
            "  <string>{}</string>".format(ctx.attrs.version),
            "  <key>CFBundleVersion</key>",
            "  <string>{}</string>".format(ctx.attrs.version),
        ] + icon_keys + [
            "  <key>LSUIElement</key>",
            "  <true/>",
            "</dict>",
            "</plist>",
            "",
        ]),
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
            "toolchain": "swift={}:{}".format(swiftc.closure_identity, swiftc.content_digest),
        },
        pretty = True,
    )

    payload = ctx.actions.declare_output("artifact.tar")
    descriptor = ctx.actions.declare_output("descriptor.json")
    args = cmd_args([
        ctx.attrs._descriptor_tool[RunInfo],
        "package-app-bundle",
        "--bundle-root", bundle_root,
        "--main-executable", bundle_root_prefix + "Contents/MacOS/" + ctx.attrs.main_executable,
        "--artifact", payload.as_output(),
        "--name", ctx.attrs.product_name,
        "--target", str(ctx.label.raw_target()),
        "--platform-os", platform.os,
        "--platform-architecture", platform.architecture,
        "--platform-abi", platform.abi,
        "--provenance", provenance,
        "--descriptor", descriptor.as_output(),
        "--bundle-plist", plist,
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
        allow_cache_upload = root_remote_cache_enabled() and root_allow_cache_uploads(),
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

_swift_app_bundle = rule(
    impl = _swift_app_bundle_impl,
    attrs = {
        "binaries": attrs.list(attrs.string()),
        "bundle_id": attrs.string(),
        "bundle_name": attrs.string(),
        "frameworks": attrs.dict(key = attrs.string(), value = attrs.list(attrs.string()), default = {}),
        "icon_basename": attrs.string(default = ""),
        "libraries": attrs.dict(key = attrs.string(), value = attrs.list(attrs.string()), default = {}),
        "main_executable": attrs.string(),
        "minimum_os": attrs.string(default = "14.0"),
        "product_name": attrs.string(),
        "resources": attrs.dict(key = attrs.string(), value = attrs.source(), default = {}),
        "sources": attrs.dict(key = attrs.string(), value = attrs.list(attrs.source())),
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
        sources,
        product_name,
        frameworks = {},
        libraries = {},
        resources = {},
        icon_basename = "",
        minimum_os = "14.0",
        **kwargs):
    """Builds one unsigned Darwin app bundle as a build_product artifact.

    Each binary compiles from its concatenated Swift sources with the declared
    Nix swiftc capability; the product tool assembles the bundle, archives it,
    and emits the buck-build-product/v1 descriptor. The bundle lands under
    Applications/<bundle_name>.app with the declared main executable.
    """
    if "target_compatible_with" in kwargs:
        fail("swift_app_bundle owns target compatibility")
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
        product_name = product_name,
        frameworks = frameworks,
        libraries = libraries,
        resources = resources,
        icon_basename = icon_basename,
        minimum_os = minimum_os,
        default_target_platform = target_platform,
        target_compatible_with = product_platform_constraints(target_platform),
        exec_compatible_with = native_execution_constraints(target_platform),
        **kwargs
    )
