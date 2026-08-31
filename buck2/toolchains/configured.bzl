"""Attested executor capabilities provisioned by the activated Nix profile."""

load("//buck2/platforms:defs.bzl", "host_execution_constraints")
load("//.buck2/capabilities:defs.bzl", "CAPABILITIES")

BuckSupportToolInfo = provider(fields = {
    "content_digest": str,
    "closure_identity": str,
    "execution_platform": str,
    "executable": Artifact,
    "manifest": Artifact,
    "protocol": str,
    "runtime_contract": str,
    "store_path": str,
    "tool_id": str,
})

def _host_platform():
    host = host_info()
    if host.os.is_linux and host.arch.is_x86_64:
        return "x86_64-linux"
    if host.os.is_linux and host.arch.is_aarch64:
        return "aarch64-linux"
    if host.os.is_macos and host.arch.is_aarch64:
        return "aarch64-macos"
    fail("support tools admit only x86_64-linux, aarch64-linux, and aarch64-macos")

def _support_tool_impl(ctx):
    platform = _host_platform()
    executable = ctx.attrs.executable
    manifest = ctx.attrs.manifest
    return [
        DefaultInfo(other_outputs = [executable, manifest]),
        RunInfo(args = cmd_args([
            executable,
            "--capability-manifest", manifest,
        ])),
        BuckSupportToolInfo(
            content_digest = ctx.attrs.content_digest,
            closure_identity = ctx.attrs.closure_identity,
            execution_platform = platform,
            executable = executable,
            manifest = manifest,
            protocol = ctx.attrs.protocol,
            runtime_contract = ctx.attrs.runtime_contract,
            store_path = ctx.attrs.store_path,
            tool_id = ctx.attrs.tool_id,
        ),
    ]

_support_tool = rule(
    impl = _support_tool_impl,
    attrs = {
        "content_digest": attrs.string(),
        "closure_identity": attrs.string(),
        "executable": attrs.source(),
        "manifest": attrs.source(),
        "protocol": attrs.string(),
        "runtime_contract": attrs.string(),
        "store_path": attrs.string(),
        "tool_id": attrs.string(),
    },
)

def support_tool(name, protocol, tool_id, **kwargs):
    platform = _host_platform()
    metadata = CAPABILITIES[platform][tool_id]
    capability = "//.buck2/capabilities/generations/{}/{}/{}".format(metadata["generation"], platform, tool_id)
    _support_tool(
        name = name,
        content_digest = metadata["contentDigest"],
        closure_identity = metadata["closureIdentity"],
        executable = capability + ":executable",
        manifest = capability + ":manifest",
        protocol = protocol,
        runtime_contract = "native-executable/v1",
        store_path = metadata["executableStorePath"],
        tool_id = tool_id,
        exec_compatible_with = host_execution_constraints(),
        **kwargs
    )
