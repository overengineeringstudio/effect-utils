"""Audited local actions: explicit cached execution platform and scrubbed env.

The execution constraint gates reads AND writes. allow_cache_upload alone only
controls writes. Admission applies to every run action in a target, so macros
must opt in only after auditing the target's complete action set.
"""

load("//buck2/platforms:defs.bzl", "root_allow_cache_uploads", "root_remote_cache_enabled", "ts_action_admission_status", "ts_action_policy_attrs")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("//buck2/toolchains:ts_sandbox.bzl", "TsSandboxToolchainInfo")


def hermetic_attrs():
    return {
        "_action_env": attrs.default_only(attrs.exec_dep(
            default = "@rules//buck2/toolchains:tool_action_env",
            providers = [BuckSupportToolInfo],
        )),
    }


def hermetic_execution_constraints(constraints = []):
    return constraints + ["@rules//buck2/platforms:cache_hermetic"]


def hermetic_bun_command(ctx, executable, config_name = "runner-bunfig.toml", sandbox_inputs = None):
    # env -i cannot prevent Bun reloading .env or executing bunfig preloads.
    # An empty declared config, not an ambient file, owns runner startup.
    config = ctx.actions.write(config_name, "")
    if sandbox_inputs != None:
        sandbox_inputs.append(config)
    return cmd_args([
        executable,
        "--no-env-file",
        "--no-install",
        cmd_args(config, format = "--config={}"),
    ])


def hermetic_action(ctx, arguments, env = {}, cacheable = True, **kwargs):
    tool = ctx.attrs._action_env[BuckSupportToolInfo]
    # GNU env expands only these executor-owned variables before -i. No shell
    # runs first (BASH_ENV/NODE_OPTIONS/etc must not affect the launcher).
    args = cmd_args([
        tool.store_path,
        "--coreutils-prog=env",
        "-S",
        "-i BUCK_SCRATCH_PATH=${BUCK_SCRATCH_PATH} TMPDIR=${TMPDIR}",
        "LC_ALL=C",
        "TZ=UTC",
    ], hidden = [tool.executable, tool.manifest])
    for name in sorted(env.keys()):
        args.add(cmd_args(env[name], format = name + "={}"))
    args.add(arguments)
    ctx.actions.run(
        args,
        allow_cache_upload = cacheable and root_remote_cache_enabled() and root_allow_cache_uploads(),
        **kwargs
    )


def ts_action_attrs():
    return dict(hermetic_attrs(), **dict(ts_action_policy_attrs(), **{
        "_ts_sandbox": attrs.default_only(attrs.exec_dep(
            default = "@rules//buck2/toolchains:ts_sandbox",
            providers = [TsSandboxToolchainInfo],
        )),
    }))


def ts_action(ctx, arguments, inputs, outputs, tools = [], cacheable = True, **kwargs):
    status = ts_action_admission_status(ctx)
    kwargs["local_only"] = True
    if status == "darwin-unsandboxed":
        kwargs["category"] = kwargs["category"] + "_darwin_unsandboxed"
        # Unsupported admission is not refusal to execute the required native
        # macOS lane. No remote-cache read platform or upload is permitted.
        hermetic_action(ctx, arguments, cacheable = False, **kwargs)
        return
    sandbox = ctx.attrs._ts_sandbox[TsSandboxToolchainInfo]
    if not sandbox.bubblewrap:
        fail("TS sandbox: declared Bubblewrap capability missing; unsandboxed execution is forbidden")
    closure = {}
    for tool_id in ["bun"] + tools:
        for path in sandbox.closure_paths[tool_id]:
            closure[path] = None
    manifest = ctx.actions.write_json("ts-sandbox.json", {
        "bubblewrap": sandbox.bubblewrap,
        "inputs": inputs,
        "outputs": outputs,
        "tools": sorted(closure.keys()),
    })
    command = cmd_args([
        hermetic_bun_command(ctx, sandbox.bun, config_name = "sandbox-launcher-bunfig.toml"),
        sandbox.launcher,
        manifest,
        arguments,
    ], hidden = inputs + sandbox.inputs + [output.as_output() for output in outputs])
    hermetic_action(ctx, command, cacheable = cacheable, **kwargs)
