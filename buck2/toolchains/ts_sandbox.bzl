"""Nix-pinned Linux TS containment capability; Darwin is explicitly excluded."""

load("@capabilities//:defs.bzl", "CAPABILITIES", "GENERATION")
load("//buck2/toolchains:defs.bzl", "host_capability_platform", "require_capability", "require_capability_closure")

TsSandboxToolchainInfo = provider(fields = {
    "bubblewrap": str,
    "bun": str,
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
        "closure_paths": attrs.dict(attrs.string(), attrs.list(attrs.string())),
        "inputs": attrs.list(attrs.source()),
        "shell": attrs.string(),
    },
)

def ts_sandbox_toolchain(name, **kwargs):
    platform = host_capability_platform()
    # Reuse the existing pinned Bash capability; no shell runs inside the action.
    # Action tools (effect-tsgo, buck2-fingerprint) bind their closures from the
    # consuming rule's own toolchain deps, so package trees stay independent of them.
    tool_ids = ["bun", "rust-shell"]
    if host_info().os.is_linux:
        tool_ids.append("bubblewrap")
    # A scoped root lacking any sandbox capability declares no sandbox target.
    # Every TS action rule depends on this target, so its analysis then fails;
    # no action can fall back to unsandboxed execution.
    for tool_id in tool_ids:
        if tool_id not in CAPABILITIES.get(platform, {}):
            return
    inputs = []
    closures = {}
    executables = {}
    for tool_id in tool_ids:
        metadata = require_capability(CAPABILITIES, GENERATION, platform, tool_id)
        closures[tool_id] = require_capability_closure(CAPABILITIES, GENERATION, platform, tool_id)
        executables[tool_id] = metadata["executableStorePath"]
        capability = "capabilities//generations/{}/{}/{}".format(GENERATION, platform, tool_id)
        inputs.extend([capability + ":executable", capability + ":manifest"])
    _ts_sandbox_toolchain(
        name = name,
        bubblewrap = executables.get("bubblewrap", ""),
        bun = executables["bun"],
        shell = executables["rust-shell"],
        closure_paths = closures,
        inputs = inputs,
        **kwargs
    )
