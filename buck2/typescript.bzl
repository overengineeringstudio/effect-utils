"""Buck-owned TypeScript CLI compilation with Nix-authored local tool inputs.

The action graph owns the source boundary and output. Nix/devenv supplies
content-addressed native tools and dependencies through root configuration.
Those absolute store paths intentionally keep this first execution lane local.
"""

def _configured_path(section, key):
    value = read_root_config(section, key, "")
    parts = value.split("/")
    if (
        not value.startswith("/nix/store/") or
        "\n" in value or
        "\r" in value or
        len(parts) < 4 or
        parts[0] != "" or
        parts[1] != "nix" or
        parts[2] != "store" or
        any([part == "" or part == "." or part == ".." for part in parts[3:]])
    ):
        fail("{}.{} must be an immutable absolute /nix/store path".format(section, key))
    return value

def _configured_text(section, key):
    value = read_root_config(section, key, "")
    if not value or "\n" in value or "\r" in value or "\x00" in value:
        fail("{}.{} must be a non-empty single-line value".format(section, key))
    return value

def _local_nix_platform():
    host = host_info()
    if host.arch.is_x86_64:
        architecture = "x86_64"
    elif host.arch.is_aarch64:
        architecture = "aarch64"
    else:
        fail("typescript rules have no Nix platform mapping for this host architecture")
    if host.os.is_linux:
        operating_system = "linux"
    elif host.os.is_macos:
        operating_system = "darwin"
    else:
        fail("typescript rules have no Nix platform mapping for this host operating system")
    return architecture + "-" + operating_system

def _add_sources(args, package_path, sources, workspace_sources, workspace_source_prefixes):
    for source in sources:
        args.add("--source-label", package_path + "/" + source.short_path)
        args.add("--source", source)
    for dep in workspace_sources:
        label = str(dep.label.raw_target())
        if label.startswith("root//"):
            label = label.removeprefix("root")
        if label not in workspace_source_prefixes:
            fail("workspace source dependency has no staging prefix: {}".format(label))
        outputs = dep[DefaultInfo].default_outputs
        if len(outputs) != 1:
            fail("workspace source dependency must expose one tree: {}".format(label))
        args.add("--source-tree-prefix", workspace_source_prefixes[label])
        args.add("--source-tree", outputs[0])

def _typescript_project_check_impl(ctx):
    if ctx.attrs.platform != _local_nix_platform():
        fail("typescript_project_check platform mismatch: target requires {}, local-only execution host is {}".format(ctx.attrs.platform, _local_nix_platform()))
    output = ctx.actions.declare_output("typecheck.json")
    args = cmd_args([
        ctx.attrs._python,
        ctx.attrs._builder,
        "check",
        "--tsgo",
        ctx.attrs._tsgo,
        "--dependency-root",
        ctx.attrs._dependency_root,
        "--native-package",
        "@opentui/core-linux-x64=" + ctx.attrs._opentui_glibc,
        "--native-package",
        "@opentui/core-linux-x64-musl=" + ctx.attrs._opentui_musl,
        "--tsconfig",
        ctx.attrs.tsconfig,
        "--output",
        output.as_output(),
    ])
    _add_sources(args, ctx.attrs.package_path, ctx.attrs.srcs, ctx.attrs.workspace_sources, ctx.attrs.workspace_source_prefixes)
    ctx.actions.run(
        args,
        env = {"PATH": "/nonexistent"},
        category = "typescript_project_check",
        identifier = ctx.attrs.name,
        local_only = True,
    )
    return [DefaultInfo(default_output = output)]

_typescript_project_check = rule(
    impl = _typescript_project_check_impl,
    attrs = {
        "package_path": attrs.string(),
        "platform": attrs.string(),
        "srcs": attrs.list(attrs.source()),
        "tsconfig": attrs.string(),
        "workspace_sources": attrs.list(attrs.dep()),
        "workspace_source_prefixes": attrs.dict(attrs.string(), attrs.string()),
        "_tsgo": attrs.default_only(attrs.string(default = _configured_path("buck2_nix", "tsgo"))),
        "_python": attrs.default_only(attrs.string(default = _configured_path("buck2_nix", "python"))),
        "_dependency_root": attrs.default_only(attrs.string(default = _configured_path("buck2_nix", "megarepo_deps"))),
        "_opentui_glibc": attrs.default_only(attrs.string(default = _configured_path("buck2_nix", "opentui_glibc"))),
        "_opentui_musl": attrs.default_only(attrs.string(default = _configured_path("buck2_nix", "opentui_musl"))),
        "_builder": attrs.default_only(attrs.source(default = "//buck2/tools:typescript_cli_builder_source")),
    },
)

def _typescript_cli_impl(ctx):
    if ctx.attrs.platform != _local_nix_platform():
        fail("typescript_cli platform mismatch: target requires {}, local-only execution host is {}".format(ctx.attrs.platform, _local_nix_platform()))
    binary = ctx.actions.declare_output(ctx.attrs.binary_name)
    archive = ctx.actions.declare_output("artifact.tar")
    descriptor = ctx.actions.declare_output("descriptor.json")
    sources = ctx.attrs.srcs
    args = cmd_args([
        ctx.attrs._python,
        ctx.attrs._builder,
        "bundle",
        "--bun",
        ctx.attrs._bun,
        "--patchelf",
        ctx.attrs._patchelf,
        "--dependency-root",
        ctx.attrs._dependency_root,
        "--validation",
        ctx.attrs.validation,
        "--validation-project",
        ctx.attrs.validation_project,
        "--native-package",
        "@opentui/core-linux-x64=" + ctx.attrs._opentui_glibc,
        "--native-package",
        "@opentui/core-linux-x64-musl=" + ctx.attrs._opentui_musl,
        "--entry",
        ctx.attrs.entry,
        "--binary-name",
        ctx.attrs.binary_name,
        "--revision",
        ctx.attrs._revision,
        "--commit-timestamp",
        ctx.attrs._commit_timestamp,
        "--dirty",
        ctx.attrs._dirty,
        "--output",
        binary.as_output(),
        "--archive",
        archive.as_output(),
        "--descriptor",
        descriptor.as_output(),
        "--target",
        str(ctx.label.raw_target()),
        "--platform",
        ctx.attrs.platform,
    ])
    _add_sources(args, ctx.attrs.package_path, sources, ctx.attrs.workspace_sources, ctx.attrs.workspace_source_prefixes)

    ctx.actions.run(
        args,
        env = {"PATH": "/nonexistent"},
        category = "typescript_cli_compile",
        identifier = ctx.attrs.binary_name,
        local_only = True,
    )
    return [
        DefaultInfo(
            default_output = archive,
            other_outputs = [binary, descriptor],
            sub_targets = {
                "artifact": [DefaultInfo(default_output = archive)],
                "binary": [DefaultInfo(default_output = binary)],
                "descriptor": [DefaultInfo(default_output = descriptor)],
            },
        ),
        RunInfo(args = cmd_args([binary])),
    ]

_typescript_cli = rule(
    impl = _typescript_cli_impl,
    attrs = {
        "entry": attrs.string(),
        "package_path": attrs.string(),
        "binary_name": attrs.string(),
        "platform": attrs.string(),
        "srcs": attrs.list(attrs.source()),
        "validation": attrs.source(),
        "validation_project": attrs.string(),
        "workspace_sources": attrs.list(attrs.dep()),
        "workspace_source_prefixes": attrs.dict(attrs.string(), attrs.string()),
        "_bun": attrs.default_only(attrs.string(default = _configured_path("buck2_nix", "bun"))),
        "_python": attrs.default_only(attrs.string(default = _configured_path("buck2_nix", "python"))),
        "_patchelf": attrs.default_only(attrs.string(default = _configured_path("buck2_nix", "patchelf"))),
        "_dependency_root": attrs.default_only(attrs.string(default = _configured_path("buck2_nix", "megarepo_deps"))),
        "_opentui_glibc": attrs.default_only(attrs.string(default = _configured_path("buck2_nix", "opentui_glibc"))),
        "_opentui_musl": attrs.default_only(attrs.string(default = _configured_path("buck2_nix", "opentui_musl"))),
        "_revision": attrs.default_only(attrs.string(default = _configured_text("buck2_build", "revision"))),
        "_commit_timestamp": attrs.default_only(attrs.string(default = _configured_text("buck2_build", "commit_timestamp"))),
        "_dirty": attrs.default_only(attrs.string(default = _configured_text("buck2_build", "dirty"))),
        "_builder": attrs.default_only(attrs.source(default = "//buck2/tools:typescript_cli_builder_source")),
    },
)

def typescript_project_check(name, package_path, platform, tsconfig, srcs, workspace_sources, workspace_source_prefixes):
    """Typecheck one generated TypeScript project-reference closure."""
    _typescript_project_check(
        name = name,
        package_path = package_path,
        platform = platform,
        tsconfig = tsconfig,
        srcs = srcs,
        workspace_sources = workspace_sources,
        workspace_source_prefixes = workspace_source_prefixes,
    )

def typescript_cli(name, package_path, entry, binary_name, platform, srcs, validation, workspace_sources, workspace_source_prefixes):
    """Compile a Bun standalone CLI from an explicit first-party source graph."""
    _typescript_cli(
        name = name,
        package_path = package_path,
        entry = entry,
        binary_name = binary_name,
        platform = platform,
        srcs = srcs,
        validation = validation,
        validation_project = package_path + "/tsconfig.json",
        workspace_sources = workspace_sources,
        workspace_source_prefixes = workspace_source_prefixes,
    )
