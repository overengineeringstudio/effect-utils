"""Linux containment probes run through the shared production action boundary."""

load("//buck2:hermetic.bzl", "hermetic_bun_command", "hermetic_sandboxed_action", "ts_action", "ts_action_attrs")
load("//buck2/platforms:defs.bzl", "cache_guarded_rule", "host_execution_constraints", "ts_action_admission_status")
load("//buck2/toolchains:ts_sandbox.bzl", "TsSandboxToolchainInfo")

def _ts_sandbox_probe_impl(ctx):
    if ts_action_admission_status(ctx) != "linux-bwrap":
        # Native Darwin actions still run; containment is explicitly unsupported.
        unsupported = ctx.actions.write_json("unsupported.json", {
            "status": "unsupported",
            "boundary": "darwin-unsandboxed",
            "reason": "Linux Bubblewrap containment probes require Linux",
        })
        return [DefaultInfo(default_output = unsupported)]
    sandbox = ctx.attrs._ts_sandbox[TsSandboxToolchainInfo]
    if ctx.attrs.non_ts:
        receipt = ctx.actions.declare_output("receipt", dir = True)
        summary = receipt.project("summary.json")
        hermetic_sandboxed_action(
            ctx,
            sandbox,
            {"rust-shell": sandbox.closure_paths["rust-shell"]},
            cmd_args([sandbox.shell, "--noprofile", "--norc", ctx.attrs.probe, ctx.attrs.probe, summary]),
            inputs = [ctx.attrs.probe],
            outputs = [receipt],
            cacheable = False,
            category = "bash_sandbox_negative_probes",
            identifier = ctx.attrs.name,
        )
        return [DefaultInfo(default_output = summary)]
    closure = ctx.actions.write_json("bun-closure.json", sandbox.closure_paths["bun"])
    receipt = ctx.actions.declare_output("receipt", dir = True)
    summary = receipt.project("summary.json")
    inputs = [ctx.attrs.probe, closure]
    args = cmd_args([
        hermetic_bun_command(ctx, sandbox.bun, sandbox_inputs = inputs),
        ctx.attrs.probe,
        "--input", ctx.attrs.probe,
        "--closure", closure,
        "--output", summary,
    ])
    ts_action(
        ctx,
        args,
        inputs = inputs,
        outputs = [receipt],
        # A containment receipt must execute, not borrow an earlier action receipt.
        cacheable = False,
        category = "ts_sandbox_negative_probes",
        identifier = ctx.attrs.name,
        local_only = True,
    )
    return [DefaultInfo(default_output = summary)]

_ts_sandbox_probe = cache_guarded_rule(
    cache_eligible = lambda ctx: False,
    impl = _ts_sandbox_probe_impl,
    attrs = dict(ts_action_attrs(), **{
        "probe": attrs.source(),
        "non_ts": attrs.bool(default = False),
    }),
)

def ts_sandbox_probe(name, **kwargs):
    _ts_sandbox_probe(
        name = name,
        exec_compatible_with = host_execution_constraints() + kwargs.pop("exec_compatible_with", []),
        **kwargs
    )
