
def _target_impl(ctx):
    return [DefaultInfo(), PlatformInfo(label = str(ctx.label.raw_target()), configuration = ConfigurationInfo(constraints = {}, values = {}))]

target_platform = rule(impl = _target_impl, attrs = {})

def _platforms_impl(ctx):
    cfg = ConfigurationInfo(constraints = {}, values = {})
    plats = []
    for name, props in ctx.attrs.pools.items():
        plats.append(ExecutionPlatformInfo(
            label = ctx.label.raw_target().with_sub_target(name) if False else ctx.label.raw_target(),
            configuration = cfg,
            executor_config = CommandExecutorConfig(
                local_enabled = False,
                remote_enabled = True,
                use_limited_hybrid = False,
                remote_execution_properties = props,
                remote_execution_use_case = "buck2-default",
                remote_output_paths = "output_paths",
            ),
        ))
    return [DefaultInfo(), ExecutionPlatformRegistrationInfo(platforms = plats)]

execution_platforms = rule(impl = _platforms_impl, attrs = {"pools": attrs.dict(attrs.string(), attrs.dict(attrs.string(), attrs.string()))})

def _probe_impl(ctx):
    out = ctx.actions.declare_output(ctx.label.name + ".txt")
    cmd = cmd_args(ctx.attrs.argv, hidden = ctx.attrs.srcs)
    cmd.add(out.as_output())
    cmd.add(ctx.attrs.srcs)
    ctx.actions.run(cmd, category = "probe", env = ctx.attrs.env, allow_cache_upload = True)
    return [DefaultInfo(default_output = out)]

probe = rule(impl = _probe_impl, attrs = {
    "argv": attrs.list(attrs.string()),
    "srcs": attrs.list(attrs.source(), default = []),
    "env": attrs.dict(attrs.string(), attrs.string(), default = {}),
})
