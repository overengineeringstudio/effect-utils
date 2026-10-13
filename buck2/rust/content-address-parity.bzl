"""Execute pilot parity against an admitted consumer and generated service product."""

load("//buck2:materialization.bzl", "GeneratedPackageInfo", "PackageTreeInfo")
load("//buck2/platforms:defs.bzl", "cache_guarded_rule", "root_allow_cache_uploads", "root_remote_cache_enabled")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("//buck2/toolchains:defs.bzl", "BunToolchainInfo")


def _parity_impl(ctx):
    package_tree = ctx.attrs.package_tree[PackageTreeInfo]
    dist = ctx.attrs.dist[DefaultInfo].default_outputs[0]
    service = ctx.attrs.service[GeneratedPackageInfo]
    # This is the admitted package tree's dependency boundary, not a separately
    # installed or hand-populated node_modules directory.
    consumer = ctx.actions.copied_dir("consumer", {
        "package.json": package_tree.tree.project("package.json"),
        "dist": dist,
        "engine-parity.ts": ctx.attrs.script,
        "node_modules": package_tree.tree.project("node_modules"),
        "service": service.package,
    })
    if ctx.attrs.runtime == "bun":
        executable = ctx.attrs._bun[BunToolchainInfo].executable
    else:
        node = ctx.attrs._node[BuckSupportToolInfo]
        executable = cmd_args(node.store_path, hidden = [node.executable, node.manifest])
    verdict = ctx.actions.declare_output("engine-parity.json")
    command = cmd_args([
        executable,
        cmd_args("--experimental-transform-types") if ctx.attrs.runtime == "node" else cmd_args(),
        consumer.project("engine-parity.ts"),
        service.package,
        verdict.as_output(),
    ], hidden = [consumer] + package_tree.read_roots + service.read_roots)
    ctx.actions.run(command, category = "content_address_parity", local_only = True)
    return [
        DefaultInfo(default_output = verdict),
        RunInfo(args = cmd_args([
            executable,
            cmd_args("--experimental-transform-types") if ctx.attrs.runtime == "node" else cmd_args(),
            consumer.project("engine-parity.ts"),
            service.package,
        ], hidden = [consumer] + package_tree.read_roots + service.read_roots)),
        ExternalRunnerTestInfo(
            type = "content_address_parity",
            command = [command],
            default_executor = CommandExecutorConfig(local_enabled = True, remote_enabled = False, remote_cache_enabled = root_remote_cache_enabled(), allow_cache_uploads = root_allow_cache_uploads(), use_windows_path_separators = False),
        ),
    ]

content_address_parity = cache_guarded_rule(impl = _parity_impl, attrs = {
    "package_tree": attrs.dep(providers = [PackageTreeInfo]),
    "dist": attrs.dep(),
    "service": attrs.dep(providers = [GeneratedPackageInfo]),
    "script": attrs.source(),
    "runtime": attrs.enum(["node", "bun"]),
    "_bun": attrs.default_only(attrs.exec_dep(default = "//buck2/toolchains:bun", providers = [BunToolchainInfo])),
    "_node": attrs.default_only(attrs.exec_dep(default = "//buck2/toolchains:tool_node", providers = [BuckSupportToolInfo])),
})
