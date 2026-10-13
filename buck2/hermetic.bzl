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


def hermetic_action(ctx, arguments, env = {}, cacheable = True, nix_outer_context = False, **kwargs):
    tool = ctx.attrs._action_env[BuckSupportToolInfo]
    # GNU env expands only these executor-owned variables before -i. No shell
    # runs first (BASH_ENV/NODE_OPTIONS/etc must not affect the launcher).
    context = "-i BUCK_SCRATCH_PATH=${BUCK_SCRATCH_PATH} TMPDIR=${TMPDIR}"
    if nix_outer_context:
        # These identities are verifier inputs, not TS-runner environment.
        context += " NIX_BUILD_TOP=${NIX_BUILD_TOP} HOME=${HOME}"
    args = cmd_args([
        tool.store_path,
        "--coreutils-prog=env",
        "-S",
        context,
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


def _ts_action_launcher(ctx, sandbox, command, inputs, outputs, verify_nix_outer = False):
    action_env = ctx.attrs._action_env[BuckSupportToolInfo]
    launcher = ctx.actions.declare_output("ts-sandbox.sh")
    verification = []
    if verify_nix_outer:
        verification = [
            "outer_failures=()",
            'outer_top=""',
            'if [[ "${NIX_BUILD_TOP:-}" == /* && -d "${NIX_BUILD_TOP:-}" ]] && outer_top="$(cd -P -- "$NIX_BUILD_TOP" 2>/dev/null && pwd -P)" && [[ "$outer_top" != / ]]; then',
            "  :",
            "else",
            '  outer_top=""',
            '  outer_failures+=("NIX_BUILD_TOP must identify an existing absolute build directory")',
            "fi",
            "outer_cwd_ok=false",
            'if [[ -n "$outer_top" ]]; then',
            '  case "$PWD/" in "$outer_top/"*) outer_cwd_ok=true ;; esac',
            "fi",
            'if [[ "$outer_cwd_ok" != true ]]; then outer_failures+=("action cwd must be under NIX_BUILD_TOP"); fi',
            'outer_root=""',
            'if [[ "$outer_cwd_ok" == true ]]; then',
            '  outer_root="$PWD"',
            '  while [[ ! -f "$outer_root/.buckroot" ]]; do',
            '    if [[ "$outer_root" == "$outer_top" ]]; then outer_root=""; break; fi',
            '    outer_root="${outer_root%/*}"',
            "  done",
            "fi",
            'if [[ -z "$outer_root" ]]; then outer_failures+=("Buck root (.buckroot) must be under NIX_BUILD_TOP"); fi',
            "outer_home_ok=false",
            'if [[ "${HOME:-}" == /homeless-shelter ]]; then',
            "  outer_home_ok=true",
            'elif [[ -n "$outer_top" && "${HOME:-}" == /* && -d "${HOME:-}" ]] && outer_home_real="$(cd -P -- "$HOME" 2>/dev/null && pwd -P)"; then',
            '  case "$outer_home_real/" in "$outer_top/"*) outer_home_ok=true ;; esac',
            "fi",
            'if [[ "$outer_home_ok" != true ]]; then outer_failures+=("HOME must equal /homeless-shelter or resolve under NIX_BUILD_TOP"); fi',
            "outer_network_ok=false",
            "outer_devices=0",
            "if [[ -r /proc/net/dev ]]; then",
            "  outer_network_ok=true",
            "  while IFS=: read -r outer_interface outer_counters; do",
            '    if [[ -z "$outer_counters" ]]; then continue; fi',
            '    outer_interface="${outer_interface//[[:space:]]/}"',
            "    ((outer_devices += 1))",
            '    if [[ "$outer_interface" != lo ]]; then outer_network_ok=false; fi',
            "  done < /proc/net/dev",
            "fi",
            'if [[ "$outer_network_ok" != true || "$outer_devices" != 1 ]]; then outer_failures+=("/proc/net/dev must contain only lo, including lo"); fi',
            "outer_host_writable=false",
            "for outer_host_path in /home /home/* /root /nix/var; do",
            '  if [[ -w "$outer_host_path" ]]; then outer_host_writable=true; fi',
            "done",
            "if [[ -r /etc/passwd ]]; then",
            "  while IFS=: read -r outer_user _ outer_uid _ _ outer_home _; do",
            '    if [[ "$outer_uid" != "$EUID" ]]; then continue; fi',
            "    outer_passwd_home_in_build=false",
            '    if [[ -n "$outer_top" && -d "$outer_home" ]] && outer_passwd_home="$(cd -P -- "$outer_home" 2>/dev/null && pwd -P)"; then',
            '      case "$outer_passwd_home/" in "$outer_top/"*) outer_passwd_home_in_build=true ;; esac',
            "    fi",
            '    if [[ "$outer_passwd_home_in_build" != true && -w "$outer_home" ]]; then outer_host_writable=true; fi',
            '    for outer_host_path in "/nix/var/nix/gcroots/per-user/$outer_user" "/nix/var/nix/profiles/per-user/$outer_user"; do',
            '      if [[ -w "$outer_host_path" ]]; then outer_host_writable=true; fi',
            "    done",
            "  done < /etc/passwd",
            "fi",
            'if [[ "$outer_host_writable" == true ]]; then outer_failures+=("host homes and /nix/var must not be writable"); fi',
            'if [[ "${#outer_failures[@]}" != 0 ]]; then',
            '  printf "%s\\n" "TS sandbox: outer sandbox declared but not verified; required: NIX_BUILD_TOP set with action cwd and Buck root (.buckroot) beneath it; HOME=/homeless-shelter or physically under NIX_BUILD_TOP; /proc/net/dev contains only lo; host homes (/home, /home/*, /root, current passwd home outside the build root) and /nix/var are not writable." >&2',
            '  printf "Failed criterion: %s\\n" "${outer_failures[@]}" >&2',
            "  exit 1",
            "fi",
            "unset HOME NIX_BUILD_TOP",
        ]
    ctx.actions.write(launcher, [
        "set -euo pipefail",
        # Physical cwd and optional outer preflight precede any output write.
        "cd -P -- .",
    ] + verification + [
        'case "$BUCK_SCRATCH_PATH" in /*) scratch="$BUCK_SCRATCH_PATH" ;; *) scratch="$PWD/$BUCK_SCRATCH_PATH" ;; esac',
        cmd_args([
            cmd_args(action_env.store_path, quote = "shell"),
            "--coreutils-prog=mkdir", "-p", "--",
            [_ts_sandbox_absolute(output) for output in outputs],
        ], delimiter = " "),
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
    if status in ["darwin-unsandboxed", "nix-outer-sandboxed"]:
        suffix = "_darwin_unsandboxed" if status == "darwin-unsandboxed" else "_nix_outer_sandboxed"
        kwargs["category"] = kwargs["category"] + suffix
        # Nix's declared derivation boundary cannot nest bwrap; neither this
        # outer-sandbox mode nor native Darwin is admitted to the action cache.
        command = _ts_action_launcher(
            ctx,
            sandbox,
            cmd_args(["exec", cmd_args(arguments, quote = "shell")], delimiter = " "),
            inputs,
            outputs,
            verify_nix_outer = status == "nix-outer-sandboxed",
        )
        hermetic_action(ctx, command, cacheable = False, nix_outer_context = status == "nix-outer-sandboxed", **kwargs)
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
