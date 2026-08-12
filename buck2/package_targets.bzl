"""Package-local evidence targets backed only by declared Buck inputs.

This is deliberately an evidence rule, not a TypeScript compiler rule.  It
turns the exact input boundary emitted by Genie into a deterministic portable
artifact which can cross the Buck2 -> Nix verification boundary.
"""

PackageEvidenceInfo = provider(fields = [
    "archive",
    "descriptor",
])

def _require_text(value, field):
    if not value:
        fail("{} must not be empty".format(field))
    if "\n" in value or "\r" in value or "\x00" in value:
        fail("{} contains a forbidden control character".format(field))

def _require_package_path(value):
    _require_text(value, "package_path")
    if value.startswith("/"):
        fail("package_path must be repo-relative")
    for component in value.split("/"):
        if component == "" or component == "." or component == "..":
            fail("package_path must be normalized and repo-relative")

def _single_default_output(dep):
    outputs = dep[DefaultInfo].default_outputs
    if len(outputs) != 1:
        fail("package_task dependencies must expose exactly one default output: {}".format(dep.label))
    return outputs[0]

def _local_nix_platform():
    host = host_info()
    if host.arch.is_x86_64:
        architecture = "x86_64"
    elif host.arch.is_aarch64:
        architecture = "aarch64"
    else:
        fail("package_task has no Nix platform mapping for this host architecture")
    if host.os.is_linux:
        operating_system = "linux"
    elif host.os.is_macos:
        operating_system = "darwin"
    else:
        fail("package_task has no Nix platform mapping for this host operating system")
    return architecture + "-" + operating_system

def _package_task_impl(ctx):
    _require_package_path(ctx.attrs.package_path)
    _require_text(ctx.attrs.kind, "kind")
    _require_text(ctx.attrs.platform, "platform")
    local_platform = _local_nix_platform()
    if ctx.attrs.platform != local_platform:
        fail("package_task platform mismatch: target requires {}, local-only execution host is {}".format(ctx.attrs.platform, local_platform))

    archive = ctx.actions.declare_output("artifact.tar")
    descriptor = ctx.actions.declare_output("descriptor.json")
    args = cmd_args([
        ctx.attrs._tool[RunInfo],
        "package",
        "--name",
        ctx.attrs.name,
        "--package-path",
        ctx.attrs.package_path,
        "--kind",
        ctx.attrs.kind,
        "--target",
        str(ctx.label.raw_target()),
        "--platform",
        ctx.attrs.platform,
        "--closure-label",
        ctx.attrs.closure_descriptor.short_path,
        "--closure-descriptor",
        ctx.attrs.closure_descriptor,
        "--archive",
        archive.as_output(),
        "--descriptor",
        descriptor.as_output(),
    ])

    for source in ctx.attrs.sources:
        args.add("--source-label", source.short_path)
        args.add("--source", source)
    for config in ctx.attrs.configs:
        args.add("--config-label", config.short_path)
        args.add("--config", config)
    for dep in ctx.attrs.deps:
        args.add("--dep-label", str(dep.label.raw_target()))
        args.add("--dep-artifact", _single_default_output(dep))

    ctx.actions.run(
        args,
        env = {"PATH": "/nonexistent"},
        category = "buck2_package_evidence",
        identifier = ctx.attrs.name,
        local_only = True,
    )
    return [
        DefaultInfo(
            default_output = archive,
            other_outputs = [descriptor],
            sub_targets = {
                "descriptor": [DefaultInfo(default_output = descriptor)],
            },
        ),
        PackageEvidenceInfo(
            archive = archive,
            descriptor = descriptor,
        ),
    ]

_package_task = rule(
    impl = _package_task_impl,
    attrs = {
        "package_path": attrs.string(),
        "kind": attrs.string(),
        "platform": attrs.string(),
        "sources": attrs.list(attrs.source()),
        "configs": attrs.list(attrs.source()),
        "deps": attrs.list(attrs.dep()),
        "closure_descriptor": attrs.source(),
        "_tool": attrs.default_only(attrs.exec_dep(
            default = "toolchains//:package_evidence_tool",
            providers = [RunInfo],
        )),
    },
)

def package_task(name, package_path, kind, platform, sources, configs, deps, closure_descriptor):
    """Create a deterministic package evidence archive and import descriptor."""
    _package_task(
        name = name,
        package_path = package_path,
        kind = kind,
        platform = platform,
        sources = sources,
        configs = configs,
        deps = deps,
        closure_descriptor = closure_descriptor,
    )
