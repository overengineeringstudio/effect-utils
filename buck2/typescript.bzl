"""Python-free TypeScript product rules with explicit source and tool edges."""

def _configured_path(section, key):
    value = read_root_config(section, key, "")
    parts = value.split("/")
    if (not value.startswith("/nix/store/") or "\n" in value or "\r" in value or len(parts) < 4 or parts[0] != "" or parts[1] != "nix" or parts[2] != "store" or any([part == "" or part == "." or part == ".." for part in parts[3:]])):
        fail("{}.{} must be an immutable absolute /nix/store path".format(section, key))
    return value

def _local_nix_platform():
    # Match the execution-platform vocabulary used by the capability
    # projection and //buck2/platforms (e.g. aarch64-macos), not the Nix
    # system tuple.
    host = host_info()
    architecture = "x86_64" if host.arch.is_x86_64 else "aarch64" if host.arch.is_aarch64 else fail("unsupported host architecture")
    operating_system = "linux" if host.os.is_linux else "macos" if host.os.is_macos else fail("unsupported host operating system")
    return architecture + "-" + operating_system

def _add_sources(args, package_path, sources, workspace_sources, workspace_source_prefixes):
    for source in sources:
        args.add("--source-label", package_path + "/" + source.short_path, "--source", source)
    for dep in workspace_sources:
        label = str(dep.label.raw_target())
        if label.startswith("root//"):
            label = label.removeprefix("root")
        if label not in workspace_source_prefixes:
            fail("workspace source dependency has no staging prefix: {}".format(label))
        outputs = dep[DefaultInfo].default_outputs
        if len(outputs) == 0:
            fail("workspace source dependency must expose at least one artifact: {}".format(label))
        for output in outputs:
            args.add("--source-tree-prefix", workspace_source_prefixes[label], "--source-tree", output)

def _check_impl(ctx):
    local_platform = _local_nix_platform()
    if ctx.attrs.platform != local_platform:
        fail("typescript_project_check platform mismatch: target requires {}, local-only execution host is {}".format(ctx.attrs.platform, local_platform))
    output = ctx.actions.declare_output("typecheck.json")
    args = cmd_args([ctx.attrs._tool[RunInfo], "check", "--tsgo", ctx.attrs._tsgo, "--dependency-root", ctx.attrs._dependency_root, "--tsconfig", ctx.attrs.tsconfig, "--output", output.as_output()])
    for native in ctx.attrs._native_packages:
        args.add("--native-package", native)
    _add_sources(args, ctx.attrs.package_path, ctx.attrs.srcs, ctx.attrs.workspace_sources, ctx.attrs.workspace_source_prefixes)
    ctx.actions.run(args, env = {"PATH": "/nonexistent"}, category = "typescript_project_check", identifier = ctx.attrs.name, local_only = True)
    return [DefaultInfo(default_output = output)]

_typescript_project_check = rule(
    impl = _check_impl,
    attrs = {
        "package_path": attrs.string(), "platform": attrs.string(), "srcs": attrs.list(attrs.source()), "tsconfig": attrs.string(),
        "workspace_sources": attrs.list(attrs.dep()), "workspace_source_prefixes": attrs.dict(attrs.string(), attrs.string()),
        "_tsgo": attrs.default_only(attrs.string(default = _configured_path("buck2_nix", "tsgo"))),
        "_dependency_root": attrs.default_only(attrs.string(default = _configured_path("buck2_nix", "megarepo_deps"))),
        "_native_packages": attrs.default_only(attrs.list(attrs.string(), default = ["@opentui/core-linux-x64=" + _configured_path("buck2_nix", "opentui_glibc"), "@opentui/core-linux-x64-musl=" + _configured_path("buck2_nix", "opentui_musl") ])),
        "_tool": attrs.default_only(attrs.exec_dep(default = "toolchains//:typescript_product_tool", providers = [RunInfo])),
    },
)

def _cli_impl(ctx):
    local_platform = _local_nix_platform()
    if ctx.attrs.platform != local_platform:
        fail("typescript_cli platform mismatch: target requires {}, local-only execution host is {}".format(ctx.attrs.platform, local_platform))
    binary = ctx.actions.declare_output(ctx.attrs.binary_name)
    archive = ctx.actions.declare_output("artifact.tar")
    descriptor = ctx.actions.declare_output("descriptor.json")
    args = cmd_args([ctx.attrs._tool[RunInfo], "bundle", "--bun", ctx.attrs._bun, "--patchelf", ctx.attrs._patchelf, "--dependency-root", ctx.attrs._dependency_root, "--entry", ctx.attrs.entry, "--binary-name", ctx.attrs.binary_name, "--output", binary.as_output(), "--archive", archive.as_output(), "--descriptor", descriptor.as_output(), "--target", str(ctx.label.raw_target()), "--platform", ctx.attrs.platform])
    for native in ctx.attrs._native_packages:
        args.add("--native-package", native)
    _add_sources(args, ctx.attrs.package_path, ctx.attrs.srcs, ctx.attrs.workspace_sources, ctx.attrs.workspace_source_prefixes)
    ctx.actions.run(args, env = {"PATH": "/nonexistent"}, category = "typescript_cli_compile", identifier = ctx.attrs.binary_name, local_only = True)
    return [DefaultInfo(default_output = archive, other_outputs = [binary, descriptor], sub_targets = {"artifact": [DefaultInfo(default_output = archive)], "binary": [DefaultInfo(default_output = binary)], "descriptor": [DefaultInfo(default_output = descriptor)]}), RunInfo(args = cmd_args(binary))]

_typescript_cli = rule(
    impl = _cli_impl,
    attrs = {
        "entry": attrs.string(), "package_path": attrs.string(), "binary_name": attrs.string(), "platform": attrs.string(), "srcs": attrs.list(attrs.source()),
        "workspace_sources": attrs.list(attrs.dep()), "workspace_source_prefixes": attrs.dict(attrs.string(), attrs.string()),
        "_bun": attrs.default_only(attrs.string(default = _configured_path("buck2_nix", "bun"))), "_patchelf": attrs.default_only(attrs.string(default = _configured_path("buck2_nix", "patchelf"))), "_dependency_root": attrs.default_only(attrs.string(default = _configured_path("buck2_nix", "megarepo_deps"))),
        "_native_packages": attrs.default_only(attrs.list(attrs.string(), default = ["@opentui/core-linux-x64=" + _configured_path("buck2_nix", "opentui_glibc"), "@opentui/core-linux-x64-musl=" + _configured_path("buck2_nix", "opentui_musl") ])),
        "_tool": attrs.default_only(attrs.exec_dep(default = "toolchains//:typescript_product_tool", providers = [RunInfo])),
    },
)

def typescript_project_check(name, package_path, platform, tsconfig, srcs, workspace_sources, workspace_source_prefixes):
    _typescript_project_check(name = name, package_path = package_path, platform = platform, tsconfig = tsconfig, srcs = srcs, workspace_sources = workspace_sources, workspace_source_prefixes = workspace_source_prefixes)

def typescript_cli(name, package_path, entry, binary_name, platform, srcs, workspace_sources, workspace_source_prefixes):
    _typescript_cli(name = name, package_path = package_path, entry = entry, binary_name = binary_name, platform = platform, srcs = srcs, workspace_sources = workspace_sources, workspace_source_prefixes = workspace_source_prefixes)
