"""Tiny executable graph exercising the production hermetic action boundary."""

load("//buck2:hermetic.bzl", "hermetic_action", "hermetic_attrs", "hermetic_execution_constraints")
load("//buck2/platforms:defs.bzl", "cache_guarded_rule")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")


def _probe_impl(ctx):
    tool = ctx.attrs.tool[BuckSupportToolInfo]
    output = ctx.actions.declare_output("result.txt")
    arguments = cmd_args([tool.store_path, ctx.attrs.script, ctx.attrs.mode, output.as_output()], hidden = [tool.executable, tool.manifest])
    if ctx.attrs.dependency:
        dependency = ctx.attrs.dependency[BuckSupportToolInfo]
        arguments.add(cmd_args(dependency.store_path, hidden = [dependency.executable, dependency.manifest]))
    hermetic_action(ctx, arguments, category = "capability_identity_" + ctx.attrs.mode, identifier = ctx.label.name, local_only = True)
    return [DefaultInfo(default_output = output)]


probe = cache_guarded_rule(
    impl = _probe_impl,
    attrs = dict(hermetic_attrs(), **{
        "dependency": attrs.option(attrs.exec_dep(providers = [BuckSupportToolInfo]), default = None),
        "mode": attrs.string(),
        "script": attrs.source(default = "probe.js"),
        "tool": attrs.exec_dep(providers = [BuckSupportToolInfo]),
    }),
)


def identity_probe(name, tool, mode, dependency = None):
    probe(
        name = name,
        tool = tool,
        mode = mode,
        dependency = dependency,
        exec_compatible_with = hermetic_execution_constraints(),
    )
