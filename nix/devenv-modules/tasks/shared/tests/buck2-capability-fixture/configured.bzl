"""Same generation-labelled executable/manifest boundary as production support_tool."""

load("@capabilities//:defs.bzl", "CAPABILITIES")

def _support_tool_impl(ctx):
    return [
        DefaultInfo(other_outputs = [ctx.attrs.executable, ctx.attrs.manifest]),
        RunInfo(args = cmd_args([
            ctx.attrs.executable,
            "--capability-manifest",
            ctx.attrs.manifest,
        ])),
    ]

_support_tool = rule(
    impl = _support_tool_impl,
    attrs = {"executable": attrs.source(), "manifest": attrs.source()},
)

def support_tool(name):
    platform = read_root_config("fixture", "platform")
    metadata = CAPABILITIES[platform]["archive-tool"]
    package = "capabilities//generations/{}/{}/archive-tool".format(metadata["generation"], platform)
    _support_tool(
        name = name,
        executable = package + ":executable",
        manifest = package + ":manifest",
        visibility = ["PUBLIC"],
    )

def support_directory():
    platform = read_root_config("fixture", "platform")
    metadata = CAPABILITIES[platform]["support-directory"]
    return "capabilities//generations/{}/{}/support-directory:directory".format(metadata["generation"], platform)
