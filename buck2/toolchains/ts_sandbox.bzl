"""Nix-pinned Linux TS containment capability; Darwin is explicitly excluded."""

load("@capabilities//:defs.bzl", "CAPABILITIES", "GENERATION")
load("//buck2/toolchains:defs.bzl", "host_capability_platform", "require_capability", "require_capability_closure")

TsSandboxToolchainInfo = provider(fields = {
    "bubblewrap": str,
    "bun": str,
    "bun_inputs": list[Artifact],
    "closure_paths": dict[str, list[str]],
    "inputs": list[Artifact],
    "shell": str,
})

def _ts_sandbox_toolchain_impl(ctx):
    return [
        DefaultInfo(other_outputs = ctx.attrs.inputs),
        TsSandboxToolchainInfo(
            bubblewrap = ctx.attrs.bubblewrap,
            bun = ctx.attrs.bun,
            bun_inputs = ctx.attrs.bun_inputs,
            closure_paths = ctx.attrs.closure_paths,
            inputs = ctx.attrs.inputs,
            shell = ctx.attrs.shell,
        ),
    ]

_ts_sandbox_toolchain = rule(
    impl = _ts_sandbox_toolchain_impl,
    attrs = {
        "bubblewrap": attrs.string(),
        "bun": attrs.string(),
        "bun_inputs": attrs.list(attrs.source()),
        "closure_paths": attrs.dict(attrs.string(), attrs.list(attrs.string())),
        "inputs": attrs.list(attrs.source()),
        "shell": attrs.string(),
    },
)

def ts_sandbox_toolchain(name, **kwargs):
    platform = host_capability_platform()
    # Only launcher capabilities are mandatory. Bun is an optional payload
    # capability; the TS wrapper, not the shared launcher, declares its inputs.
    tool_ids = ["rust-shell"]
    if host_info().os.is_linux:
        tool_ids.append("bubblewrap")
    # A scoped root lacking any sandbox capability declares no sandbox target.
    # Every TS action rule depends on this target, so its analysis then fails;
    # no action can fall back to unsandboxed execution.
    for tool_id in tool_ids:
        if tool_id not in CAPABILITIES.get(platform, {}):
            return
    if "bun" in CAPABILITIES.get(platform, {}):
        tool_ids = ["bun"] + tool_ids
    bun_inputs = []
    inputs = []
    closures = {}
    executables = {}
    for tool_id in tool_ids:
        metadata = require_capability(CAPABILITIES, GENERATION, platform, tool_id)
        closures[tool_id] = require_capability_closure(CAPABILITIES, GENERATION, platform, tool_id)
        executables[tool_id] = metadata["executableStorePath"]
        capability = "capabilities//generations/{}/{}/{}".format(GENERATION, platform, tool_id)
        if tool_id == "bun":
            bun_inputs.extend([capability + ":executable", capability + ":manifest"])
        else:
            inputs.extend([capability + ":executable", capability + ":manifest"])
    _ts_sandbox_toolchain(
        name = name,
        bubblewrap = executables.get("bubblewrap", ""),
        bun = executables.get("bun", ""),
        bun_inputs = bun_inputs,
        shell = executables["rust-shell"],
        closure_paths = closures,
        inputs = inputs,
        **kwargs
    )
