"""Attested executor capabilities provisioned by the activated Nix profile."""

load("//buck2/platforms:defs.bzl", "host_execution_constraints")
load("//buck2/toolchains:defs.bzl", "host_capability_platform")
load("@capabilities//:defs.bzl", "CAPABILITIES")

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

def _support_tool_impl(ctx):
    platform = host_capability_platform()
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
    platform = host_capability_platform()
    metadata = CAPABILITIES[platform][tool_id]
    capability = "capabilities//generations/{}/{}/{}".format(metadata["generation"], platform, tool_id)
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

BuckStoreDirectoryInfo = provider(fields = {
    "closure_identity": str,
    "closure_store_paths": list[str],
    "content_digest": str,
    "directory": Artifact,
    "manifest": Artifact,
    "protocol": str,
    "store_path": str,
})

def _store_directory_impl(ctx):
    return [
        DefaultInfo(default_output = ctx.attrs.directory, other_outputs = [ctx.attrs.manifest]),
        BuckStoreDirectoryInfo(
            closure_identity = ctx.attrs.closure_identity,
            closure_store_paths = ctx.attrs.closure_store_paths,
            content_digest = ctx.attrs.content_digest,
            directory = ctx.attrs.directory,
            manifest = ctx.attrs.manifest,
            protocol = ctx.attrs.protocol,
            store_path = ctx.attrs.store_path,
        ),
    ]

_store_directory = rule(
    impl = _store_directory_impl,
    attrs = {
        "closure_identity": attrs.string(),
        "closure_store_paths": attrs.list(attrs.string()),
        "content_digest": attrs.string(),
        "directory": attrs.source(),
        "manifest": attrs.source(),
        "protocol": attrs.string(),
        "store_path": attrs.string(),
    },
)

def store_directory(name, protocol, input_id, **kwargs):
    """Expose one consumer-owned immutable Nix directory to Buck actions."""
    platform = host_capability_platform()
    metadata = CAPABILITIES[platform][input_id]
    store_path = metadata.get("directoryStorePath")
    closure = metadata.get("closureStorePaths")
    if not store_path or not store_path.startswith("/nix/store/") or store_path.count("/") != 3:
        fail("store_directory {} needs a normalized immutable directory path".format(input_id))
    if metadata.get("generation") == None or not metadata.get("contentDigest"):
        fail("store_directory {} needs a generation and content digest".format(input_id))
    if metadata.get("closureIdentity") != store_path or not closure or store_path not in closure:
        fail("store_directory {} needs the declared closure of its directory".format(input_id))
    if closure != sorted({path: None for path in closure}):
        fail("store_directory {} needs sorted, unique closure paths".format(input_id))
    for path in closure:
        if not path.startswith("/nix/store/") or path.count("/") != 3:
            fail("store_directory {} has a non-normalized closure path".format(input_id))
    capability = "capabilities//generations/{}/{}/{}".format(metadata["generation"], platform, input_id)
    _store_directory(
        name = name,
        closure_identity = metadata["closureIdentity"],
        closure_store_paths = closure,
        content_digest = metadata["contentDigest"],
        directory = capability + ":directory",
        manifest = capability + ":manifest",
        protocol = protocol,
        store_path = store_path,
        exec_compatible_with = host_execution_constraints(),
        **kwargs
    )
