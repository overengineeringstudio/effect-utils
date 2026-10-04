"""Package-local JavaScript check, build, and launch rules."""

load("//buck2:hermetic.bzl", "hermetic_action", "hermetic_attrs", "hermetic_bun_command", "hermetic_execution_constraints")
load("//buck2/dependencies:defs.bzl", "PnpmDeclaredClosureInfo", "PnpmPlatformGatedPackagesInfo")
load("//buck2/materialization.bzl", "PackageTreeInfo")
load("//buck2/platforms:defs.bzl", "cache_guarded_rule", "root_allow_cache_uploads", "root_remote_cache_enabled")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("//buck2/toolchains:defs.bzl", "BunToolchainInfo")

JavaScriptModuleInfo = provider(fields = {
    "module": Artifact,
    "descriptor": Artifact,
    "dependency_closure_identity": str,
})

PackageCommandRuntimeInfo = provider(fields = {
    "runtime": Artifact,
    "read_roots": provider_field(list[Artifact]),
})

PackageCheckInfo = provider(fields = {
    "descriptor": Artifact,
    "verdict": Artifact,
})

JavaScriptLaunchInfo = provider(fields = {
    "args": list[str],
    "descriptor": Artifact,
    "entrypoint": str,
    "env": dict[str, str],
    "executable": provider_field(RunInfo),
    "port": int,
    "process_kind": str,
    "runtime_kind": str,
})

def _relative(value, field):
    if not value or value.startswith("/") or "\\" in value:
        fail("{} must be a normalized relative path: {}".format(field, value))
    for part in value.split("/"):
        if part in ["", ".", ".."]:
            fail("{} must be a normalized relative path: {}".format(field, value))

def _package_command_runtime_impl(ctx):
    view = ctx.attrs.dependency_view
    vendored_files = ctx.attrs.vendored_files
    if (view == None and vendored_files == None) or (view != None and vendored_files != None):
        fail("package_command_runtime requires exactly one declared or vendored dependency closure")
    runtime = ctx.attrs.files[DefaultInfo].default_outputs[0]
    read_roots = view[PnpmDeclaredClosureInfo].read_roots if view != None else vendored_files[DefaultInfo].default_outputs
    return [
        DefaultInfo(default_output = runtime),
        PackageCommandRuntimeInfo(runtime = runtime, read_roots = read_roots),
    ]

package_command_runtime = cache_guarded_rule(
    impl = _package_command_runtime_impl,
    attrs = {
        "files": attrs.dep(providers = [DefaultInfo]),
        "dependency_view": attrs.option(attrs.dep(providers = [PnpmDeclaredClosureInfo]), default = None),
        "vendored_files": attrs.option(attrs.dep(providers = [DefaultInfo]), default = None),
    },
)

def package_command_runtime_inputs(ctx):
    """Stages a runner and the read roots of its declared parser closure."""
    runner = ctx.attrs._runner[PackageCommandRuntimeInfo]
    return cmd_args(
        cmd_args(runner.runtime, format = "{}/package-command-runner.ts"),
        hidden = runner.read_roots,
    )

def _runner_args(ctx, mode, output = None):
    package_tree = ctx.attrs.package_tree[PackageTreeInfo]
    toolchain = ctx.attrs._bun[BunToolchainInfo]
    args = cmd_args([
        hermetic_bun_command(ctx, toolchain.executable) if mode != "exec" else toolchain.executable,
        package_command_runtime_inputs(ctx),
        mode,
        toolchain.executable,
        package_tree.tree,
        ctx.attrs.entrypoint,
        output.as_output() if output else "-",
    ])
    fingerprint = ctx.attrs._fingerprint_tool[BuckSupportToolInfo]
    args.add("--fingerprint-tool", fingerprint.store_path)
    args.add(cmd_args(hidden = [fingerprint.executable, fingerprint.manifest]))
    for read_root in package_tree.read_roots:
        args.add("--read-root", read_root)
    for value in ctx.attrs.args:
        args.add("--arg", value)
    for key, value in sorted(ctx.attrs.env.items()):
        args.add("--env", "{}={}".format(key, value))

    # Arguments appended by `buck2 run <target> -- ...` belong to the launched
    # entrypoint, never to this runner's encoded configuration.
    if mode == "exec":
        args.add("--")
    return args

def _package_check_impl(ctx):
    _relative(ctx.attrs.entrypoint, "entrypoint")
    verdict = ctx.actions.declare_output("check.ok")
    descriptor = ctx.actions.declare_output("check.json")
    args = _runner_args(ctx, "check", verdict)
    hermetic_action(
        ctx,
        args,
        category = "package_bin_check",
        local_only = True,
        cacheable = False,
    )
    ctx.actions.write_json(descriptor, {
        "schema": "effect-utils/package-check/v1",
        "entrypoint": ctx.attrs.entrypoint,
    })
    return [
        DefaultInfo(
            default_output = verdict,
            other_outputs = [descriptor],
            sub_targets = {"descriptor": [DefaultInfo(default_output = descriptor)]},
        ),
        PackageCheckInfo(descriptor = descriptor, verdict = verdict),
    ]

package_bin_check = cache_guarded_rule(
    impl = _package_check_impl,
    attrs = dict(hermetic_attrs(), **{
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "entrypoint": attrs.string(),
        "args": attrs.list(attrs.string(), default = []),
        "env": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:bun",
            providers = [BunToolchainInfo],
        )),
        "_runner": attrs.default_only(attrs.dep(
            default = "//packages/@overeng/buck2-tools:package_command_runtime",
            providers = [PackageCommandRuntimeInfo],
        )),
        "_fingerprint_tool": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:fingerprint_tool",
            providers = [BuckSupportToolInfo],
        )),
    }),
)

def _package_build_impl(ctx):
    _relative(ctx.attrs.entrypoint, "entrypoint")
    output = ctx.actions.declare_output(ctx.attrs.output, dir = True)
    args = _runner_args(ctx, "build-dir", output)
    hermetic_action(
        ctx,
        args,
        category = "package_bin_build",
        local_only = True,
        cacheable = False,
    )
    return [DefaultInfo(default_output = output)]

package_bin_build = cache_guarded_rule(
    impl = _package_build_impl,
    attrs = dict(hermetic_attrs(), **{
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "entrypoint": attrs.string(),
        "args": attrs.list(attrs.string()),
        "env": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "output": attrs.string(),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:bun",
            providers = [BunToolchainInfo],
        )),
        "_runner": attrs.default_only(attrs.dep(
            default = "//packages/@overeng/buck2-tools:package_command_runtime",
            providers = [PackageCommandRuntimeInfo],
        )),
        "_fingerprint_tool": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:fingerprint_tool",
            providers = [BuckSupportToolInfo],
        )),
    }),
)

def _package_launch_impl(ctx):
    _relative(ctx.attrs.entrypoint, "entrypoint")
    toolchain = ctx.attrs._bun[BunToolchainInfo]
    executable = RunInfo(args = _runner_args(ctx, "exec"))
    descriptor = ctx.actions.declare_output("launch.json")
    ctx.actions.write_json(descriptor, {
        "schema": "effect-utils/javascript-launch/v1",
        "runtimeKind": "bun",
        "entrypoint": ctx.attrs.entrypoint,
        "args": ctx.attrs.args,
        "env": ctx.attrs.env,
        "inheritsEnvironment": True,
        "processKind": ctx.attrs.process_kind,
        "port": ctx.attrs.port if ctx.attrs.port > 0 else None,
        "dependencyClosureIdentity": "{};{}".format(toolchain.identity, ctx.attrs.package_tree.label),
    })
    info = JavaScriptLaunchInfo(
        args = ctx.attrs.args,
        descriptor = descriptor,
        entrypoint = ctx.attrs.entrypoint,
        env = ctx.attrs.env,
        executable = executable,
        port = ctx.attrs.port,
        process_kind = ctx.attrs.process_kind,
        runtime_kind = "bun",
    )
    return [
        DefaultInfo(
            default_output = descriptor,
            sub_targets = {"descriptor": [DefaultInfo(default_output = descriptor)]},
        ),
        executable,
        info,
    ]

package_bin = cache_guarded_rule(
    impl = _package_launch_impl,
    attrs = {
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "entrypoint": attrs.string(),
        "args": attrs.list(attrs.string(), default = []),
        "env": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "process_kind": attrs.enum(["one-shot", "long-lived"], default = "one-shot"),
        "port": attrs.int(default = 0),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:bun",
            providers = [BunToolchainInfo],
        )),
        "_runner": attrs.default_only(attrs.dep(
            default = "//packages/@overeng/buck2-tools:package_command_runtime",
            providers = [PackageCommandRuntimeInfo],
        )),
        "_fingerprint_tool": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:fingerprint_tool",
            providers = [BuckSupportToolInfo],
        )),
    },
)

def _closure_root_name(artifact):
    """Return a configuration-free name for one declared package-tree root."""
    owner = artifact.owner
    if owner == None:
        fail("closure root {} has no owning target".format(artifact))
    return "{}/{}/{}/{}".format(owner.cell, owner.package, owner.name, artifact.short_path)

def _package_bundle_impl(ctx):
    _relative(ctx.attrs.entrypoint, "entrypoint")
    _relative(ctx.attrs.output, "output")
    package_tree = ctx.attrs.package_tree[PackageTreeInfo]
    toolchain = ctx.attrs._bun[BunToolchainInfo]
    gated = ctx.attrs._platform_gated_packages[PnpmPlatformGatedPackagesInfo]
    module = ctx.actions.declare_output(ctx.attrs.output)
    descriptor = ctx.actions.declare_output("module.json")
    target_identity = "{}//{}:{}".format(ctx.label.cell, ctx.label.package, ctx.label.name)
    dependency_closure_identity = "runtime={};package_tree={}".format(
        ctx.attrs.target,
        ctx.attrs.package_tree.label,
    )
    args = cmd_args([
        hermetic_bun_command(ctx, toolchain.executable),
        package_command_runtime_inputs(ctx),
        "bundle",
        toolchain.executable,
        package_tree.tree,
        ctx.attrs.entrypoint,
        module.as_output(),
        "--target",
        ctx.attrs.target,
        "--kind",
        ctx.attrs.kind,
        "--descriptor",
        descriptor.as_output(),
        "--target-identity",
        target_identity,
        "--runtime-contract",
        "javascript-esm",
        "--runtime-contract-version",
        "v1",
        "--platform-gated-manifest",
        gated.manifest,
    ])
    fingerprint = ctx.attrs._fingerprint_tool[BuckSupportToolInfo]
    args.add("--fingerprint-tool", fingerprint.store_path)
    args.add(cmd_args(hidden = [fingerprint.executable, fingerprint.manifest]))
    args.add("--tree-shaking")
    args.add("true" if ctx.attrs.tree_shaking else "false")
    for external in ctx.attrs.external:
        args.add("--external", external)
    for capability in ctx.attrs.external_capabilities:
        args.add("--external-capability", capability)
    for read_root in package_tree.read_roots:
        args.add("--read-root", read_root)
    for read_root in package_tree.read_roots[1:]:
        args.add("--closure-root", cmd_args(
            read_root,
            format = _closure_root_name(read_root) + "\t{}",
        ))
    args.add(cmd_args(hidden = package_tree.read_roots))
    hermetic_action(
        ctx,
        args,
        category = "package_bin_artifact",
        local_only = True,
    )
    return [
        DefaultInfo(
            default_output = module,
            other_outputs = [descriptor],
            sub_targets = {"descriptor": [DefaultInfo(default_output = descriptor)]},
        ),
        JavaScriptModuleInfo(
            module = module,
            descriptor = descriptor,
            dependency_closure_identity = dependency_closure_identity,
        ),
    ]

_package_bin_artifact = cache_guarded_rule(
    cache_eligible = lambda ctx: True,
    impl = _package_bundle_impl,
    attrs = dict(hermetic_attrs(), **{
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "entrypoint": attrs.string(),
        "output": attrs.string(),
        "target": attrs.enum(["bun", "node"], default = "node"),
        "kind": attrs.enum(["cli", "module"], default = "module"),
        "external": attrs.list(attrs.string(), default = []),
        "external_capabilities": attrs.list(attrs.string(), default = []),
        "tree_shaking": attrs.bool(default = True),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:bun",
            providers = [BunToolchainInfo],
        )),
        "_platform_gated_packages": attrs.dep(
            default = "//buck2/dependencies:platform_gated_packages",
            providers = [PnpmPlatformGatedPackagesInfo],
        ),
        "_runner": attrs.default_only(attrs.dep(
            default = "//packages/@overeng/buck2-tools:package_command_runtime",
            providers = [PackageCommandRuntimeInfo],
        )),
        "_fingerprint_tool": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:fingerprint_tool",
            providers = [BuckSupportToolInfo],
        )),
    }),
)

def package_bin_artifact(
        name,
        _platform_gated_packages = "//buck2/dependencies:platform_gated_packages",
        **kwargs):
    _package_bin_artifact(
        name = name,
        default_target_platform = "@rules//buck2/platforms:javascript_portable",
        _platform_gated_packages = _platform_gated_packages,
        exec_compatible_with = hermetic_execution_constraints(kwargs.pop("exec_compatible_with", [])),
        **kwargs
    )

def _npm_package_archive_impl(ctx):
    package_tree = ctx.attrs.package_tree[PackageTreeInfo]
    dist = ctx.attrs.dist[DefaultInfo].default_outputs[0]
    typecheck = ctx.attrs.typecheck[DefaultInfo].default_outputs[0]
    output = ctx.actions.declare_output(ctx.attrs.output)
    args = cmd_args(
        ctx.attrs.product_tool[RunInfo],
        "npm-package",
        "--package-tree",
        package_tree.tree,
        "--dist",
        dist,
        "--artifact",
        output.as_output(),
    )
    for manifest in ctx.attrs.workspace_manifests:
        args.add("--workspace-manifest", manifest)
    ctx.actions.run(
        cmd_args(args, hidden = [typecheck]),
        category = "npm_package_archive",
        local_only = True,
        allow_cache_upload = False,
    )
    return [DefaultInfo(default_output = output)]

_npm_package_archive = cache_guarded_rule(
    impl = _npm_package_archive_impl,
    attrs = {
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "dist": attrs.dep(providers = [DefaultInfo]),
        "workspace_manifests": attrs.list(attrs.source(), default = []),
        "typecheck": attrs.dep(providers = [DefaultInfo]),
        "output": attrs.string(),
        "product_tool": attrs.exec_dep(providers = [BuckSupportToolInfo]),
    },
)

def npm_package_archive(name, package_tree, dist, typecheck, output, **kwargs):
    """Archives one typechecked package tree plus its emitted dist as a deterministic npm tgz."""
    _npm_package_archive(
        name = name,
        package_tree = package_tree,
        dist = dist,
        typecheck = typecheck,
        output = output,
        product_tool = "//buck2/toolchains:product_tool",
        **kwargs
    )
