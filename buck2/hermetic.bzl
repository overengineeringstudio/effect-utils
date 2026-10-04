"""Audited local actions: explicit cached execution platform and scrubbed env.

The execution constraint gates reads AND writes. allow_cache_upload alone only
controls writes. Admission applies to every run action in a target, so macros
must opt in only after auditing the target's complete action set.
"""

load("//buck2/platforms:defs.bzl", "root_allow_cache_uploads", "root_remote_cache_enabled")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")


def hermetic_attrs():
    return {
        "_action_env": attrs.default_only(attrs.exec_dep(
            default = "@rules//buck2/toolchains:tool_action_env",
            providers = [BuckSupportToolInfo],
        )),
    }


def hermetic_execution_constraints(constraints = []):
    return constraints + ["@rules//buck2/platforms:cache_hermetic"]


def hermetic_bun_command(ctx, executable, config_name = "runner-bunfig.toml"):
    # env -i cannot prevent Bun reloading .env or executing bunfig preloads.
    # An empty declared config, not an ambient file, owns runner startup.
    return cmd_args([
        executable,
        "--no-env-file",
        "--no-install",
        cmd_args(ctx.actions.write(config_name, ""), format = "--config={}"),
    ])


def hermetic_action(ctx, arguments, env = {}, cacheable = True, **kwargs):
    tool = ctx.attrs._action_env[BuckSupportToolInfo]
    # GNU env expands only these executor-owned variables before -i. No shell
    # runs first (BASH_ENV/NODE_OPTIONS/etc must not affect the launcher).
    args = cmd_args([
        tool.store_path,
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
