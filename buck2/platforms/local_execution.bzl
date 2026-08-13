"""Fail-closed local execution-platform registration."""

load("@prelude//cfg/exec_platform:marker.bzl", "get_exec_platform_marker")

def _local_execution_platform_impl(ctx):
    configured = ctx.attrs.platform[PlatformInfo]
    name = ctx.label.raw_target()
    execution = ExecutionPlatformInfo(
        label = name,
        configuration = configured.configuration,
        executor_config = CommandExecutorConfig(
            local_enabled = True,
            remote_enabled = False,
            use_windows_path_separators = ctx.attrs.use_windows_path_separators,
        ),
    )
    return [
        DefaultInfo(),
        execution,
        ExecutionPlatformRegistrationInfo(
            platforms = [execution],
            # No unspecified fallback: incompatible actions fail during
            # execution-platform resolution rather than running on the host.
            fallback = "error",
            exec_marker_constraint = get_exec_platform_marker(),
        ),
    ]

local_execution_platform = rule(
    impl = _local_execution_platform_impl,
    attrs = {
        "platform": attrs.dep(providers = [PlatformInfo]),
        "use_windows_path_separators": attrs.bool(),
    },
)
