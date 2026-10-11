"""Local prototype: project an immutable Nix interpreter into action inputs."""

def _sandbox_env_impl(ctx):
    env_tool = ctx.actions.declare_output("sandbox-env")
    ctx.actions.run(
        ["/nix/store/xjl7p8dvyk2j53kqf7f43kdj4ypbxz7g-coreutils-9.11/bin/cp", "/nix/store/xjl7p8dvyk2j53kqf7f43kdj4ypbxz7g-coreutils-9.11/bin/env", env_tool.as_output()],
        category = "sandbox_env_input",
        local_only = True,
        allow_cache_upload = False,
    )
    return [DefaultInfo(default_output = env_tool)]

sandbox_env = rule(impl = _sandbox_env_impl, attrs = {})
