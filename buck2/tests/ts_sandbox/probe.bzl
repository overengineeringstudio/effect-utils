"""Linux containment probes run through the production TS action boundary."""

load("//buck2:hermetic.bzl", "hermetic_bun_command", "ts_action", "ts_action_attrs")
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
    closure = ctx.actions.write_json("bun-closure.json", sandbox.closure_paths["bun"])
    summary = ctx.actions.declare_output("receipt/summary.json")
    inputs = [ctx.attrs.probe, closure]
    args = cmd_args([
        hermetic_bun_command(ctx, sandbox.bun, sandbox_inputs = inputs),
        ctx.attrs.probe,
        "--input", ctx.attrs.probe,
        "--closure", closure,
        "--output", summary.as_output(),
    ])
    ts_action(
        ctx,
        args,
        inputs = inputs,
        outputs = [summary],
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
    }),
)

def ts_sandbox_probe(name, **kwargs):
    _ts_sandbox_probe(
        name = name,
        exec_compatible_with = host_execution_constraints() + kwargs.pop("exec_compatible_with", []),
        **kwargs
    )
