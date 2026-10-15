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


def _ts_sandbox_absolute(artifact):
    return cmd_args(cmd_args(artifact, quote = "shell"), format = '"$PWD"/{}')


def _ts_action_launcher(ctx, sandbox, command, inputs, outputs):
    action_env = ctx.attrs._action_env[BuckSupportToolInfo]
    launcher = ctx.actions.declare_output("ts-sandbox.sh")
    ctx.actions.write(launcher, [
        "set -euo pipefail",
        # Both executors own directory outputs before the child can write a receipt.
        # Shell startup is scrubbed first; its builtin owns the physical cwd.
        "cd -P -- .",
        'case "$BUCK_SCRATCH_PATH" in /*) scratch="$BUCK_SCRATCH_PATH" ;; *) scratch="$PWD/$BUCK_SCRATCH_PATH" ;; esac',
        cmd_args([
            cmd_args(action_env.store_path, quote = "shell"),
            "--coreutils-prog=mkdir", "-p", "--",
            [_ts_sandbox_absolute(output) for output in outputs],
        ], delimiter = " "),
        # Private /tmp must not turn the native fingerprint cap into a per-action
        # cap. Create persistent host inodes without truncation, then expose only
        # a read-only mount; payload commands cannot replace semaphore files.
        "fingerprint_locks=/tmp/effect-utils-buck2-fingerprint-v1",
        cmd_args([
            cmd_args(action_env.store_path, quote = "shell"),
            '--coreutils-prog=mkdir -p -m 755 -- "$fingerprint_locks"',
        ], delimiter = " "),
        '[[ -d "$fingerprint_locks" && ! -L "$fingerprint_locks" ]]',
        '(umask 022; for slot in admission slot-0 slot-1 slot-2 slot-3; do if [[ ! -e "$fingerprint_locks/$slot" ]]; then (set -o noclobber; : > "$fingerprint_locks/$slot") || [[ -f "$fingerprint_locks/$slot" ]]; fi; done)',
        command,
        "",
    ], allow_args = True)
    return cmd_args([
        sandbox.shell, "--noprofile", "--norc", launcher,
    ], hidden = inputs + sandbox.inputs + [output.as_output() for output in outputs])


def ts_action(ctx, arguments, inputs, outputs, tools = [], cacheable = True, **kwargs):
    """Runs directory-output TS actions; Linux bind argv is fixed at analysis."""
    status = ts_action_admission_status(ctx)
    kwargs["local_only"] = True
    sandbox = ctx.attrs._ts_sandbox[TsSandboxToolchainInfo]
    if status == "darwin-unsandboxed":
        kwargs["category"] = kwargs["category"] + "_darwin_unsandboxed"
        # Unsupported admission is not refusal to execute the native macOS lane.
        command = _ts_action_launcher(
            ctx,
            sandbox,
            cmd_args(["exec", cmd_args(arguments, quote = "shell")], delimiter = " "),
            inputs,
            outputs,
        )
        hermetic_action(ctx, command, cacheable = False, **kwargs)
        return
    if not sandbox.bubblewrap:
        fail("TS sandbox: declared Bubblewrap capability missing; unsandboxed execution is forbidden")
    closure = {}
    for tool_id in ["bun"] + tools:
        for path in sandbox.closure_paths[tool_id]:
            closure[path] = None
    bind_args = cmd_args([
        "exec",
        cmd_args(sandbox.bubblewrap, quote = "shell"),
        "--unshare-all", "--unshare-user", "--die-with-parent", "--new-session",
        "--disable-userns", "--clearenv",
        "--proc", "/proc", "--remount-ro", "/proc",
        "--dev", "/dev", "--remount-ro", "/dev",
        "--tmpfs", "/tmp",
        "--ro-bind", '"$fingerprint_locks"', "/tmp/effect-utils-buck2-fingerprint-v1",
        "--bind", '"$scratch"', '"$scratch"',
        "--dir", '"$PWD"',
    ], delimiter = " ")
    for output in outputs:
        bind_args.add("--bind", _ts_sandbox_absolute(output), _ts_sandbox_absolute(output))
    unique_inputs = {}
    for artifact in inputs:
        unique_inputs[artifact] = None
    for artifact in unique_inputs:
        bind_args.add("--ro-bind", cmd_args(artifact, quote = "shell"), _ts_sandbox_absolute(artifact))
    for path in sorted(closure.keys()):
        bind_args.add("--ro-bind", cmd_args(path, quote = "shell"), cmd_args(path, quote = "shell"))
    bind_args.add(
        "--remount-ro", "/", "--chdir", '"$PWD"',
        "--setenv", "LC_ALL", "C", "--setenv", "TZ", "UTC",
        "--setenv", "TMPDIR", "/tmp", "--setenv", "BUCK_SCRATCH_PATH", '"$scratch"',
        "--setenv", "PWD", '"$PWD"',
        "--", cmd_args(arguments, quote = "shell"),
    )
    command = _ts_action_launcher(ctx, sandbox, bind_args, inputs, outputs)
    hermetic_action(ctx, command, cacheable = cacheable, **kwargs)
