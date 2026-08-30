"""Exact native product-platform identities admitted by the public Buck kernel."""

load("@prelude//cfg/exec_platform:marker.bzl", "get_exec_platform_marker")

ProductPlatformInfo = provider(fields = {
    "abi": str,
    "architecture": str,
    "os": str,
    "runtime_contract": str,
})

def _product_platform_impl(ctx):
    constraints = {}
    for dep in ctx.attrs.constraint_values:
        value = dep[ConstraintValueInfo]
        constraints[value.setting.label] = value
    configuration = ConfigurationInfo(constraints = constraints, values = {})
    return [
        DefaultInfo(),
        PlatformInfo(label = str(ctx.label.raw_target()), configuration = configuration),
        ProductPlatformInfo(
            abi = ctx.attrs.abi,
            architecture = ctx.attrs.architecture,
            os = ctx.attrs.os,
            runtime_contract = ctx.attrs.runtime_contract,
        ),
    ]

product_platform = rule(
    impl = _product_platform_impl,
    attrs = {
        "abi": attrs.string(),
        "architecture": attrs.string(),
        "os": attrs.string(),
        "runtime_contract": attrs.string(),
        "constraint_values": attrs.list(attrs.dep(providers = [ConstraintValueInfo])),
    },
)

def _remote_cache_enabled():
    return read_root_config("buck2", "remote_cache_enabled", "true") == "true"

def _allow_cache_uploads():
    return read_root_config("buck2", "allow_cache_uploads", "true") == "true"

def _native_execution_platform_impl(ctx):
    constraints = {}
    for dep in ctx.attrs.constraint_values:
        value = dep[ConstraintValueInfo]
        constraints[value.setting.label] = value
    configuration = ConfigurationInfo(constraints = constraints, values = {})
    platform = ExecutionPlatformInfo(
        label = ctx.label.raw_target(),
        configuration = configuration,
        executor_config = CommandExecutorConfig(
            local_enabled = True,
            remote_enabled = False,
            remote_cache_enabled = _remote_cache_enabled(),
            allow_cache_uploads = _allow_cache_uploads(),
            use_windows_path_separators = False,
        ),
    )
    return [
        DefaultInfo(),
        platform,
        PlatformInfo(label = str(ctx.label.raw_target()), configuration = configuration),
        ExecutionPlatformRegistrationInfo(
            platforms = [platform],
            exec_marker_constraint = get_exec_platform_marker(),
        ),
    ]

native_execution_platform = rule(
    impl = _native_execution_platform_impl,
    attrs = {
        "constraint_values": attrs.list(attrs.dep(providers = [ConstraintValueInfo])),
    },
)

def host_platform_label():
    host = host_info()
    if host.os.is_linux and host.arch.is_x86_64:
        return "effect_utils//buck2/platforms:linux_x86_64"
    if host.os.is_linux and host.arch.is_aarch64:
        return "effect_utils//buck2/platforms:linux_aarch64"
    if host.os.is_macos and host.arch.is_aarch64:
        return "effect_utils//buck2/platforms:macos_aarch64"
    fail("host_platform supports only x86_64-linux, aarch64-linux, and aarch64-darwin")

def host_execution_platform_label():
    host = host_info()
    if host.os.is_linux and host.arch.is_x86_64:
        return "effect_utils//buck2/platforms:exec_linux_x86_64"
    if host.os.is_linux and host.arch.is_aarch64:
        return "effect_utils//buck2/platforms:exec_linux_aarch64"
    if host.os.is_macos and host.arch.is_aarch64:
        return "effect_utils//buck2/platforms:exec_macos_aarch64"
    fail("host execution platform supports only x86_64-linux, aarch64-linux, and aarch64-darwin")

def native_execution_constraints(target_platform):
    """Returns the execution constraints for an admitted native target pair."""
    constraints = {
        "effect_utils//buck2/platforms:linux_x86_64": [
            "prelude//cpu/constraints:x86_64",
            "prelude//os/constraints:linux",
        ],
        "effect_utils//buck2/platforms:linux_aarch64": [
            "prelude//cpu/constraints:arm64",
            "prelude//os/constraints:linux",
        ],
        "effect_utils//buck2/platforms:macos_aarch64": [
            "prelude//cpu/constraints:arm64",
            "prelude//os/constraints:macos",
        ],
    }.get(target_platform)
    if constraints == None:
        fail("no native execution pair is admitted for target platform {}".format(target_platform))
    return constraints

def product_platform_constraints(target_platform):
    """Returns the complete target constraints for an admitted product platform."""
    constraints = {
        "effect_utils//buck2/platforms:linux_x86_64": [
            "prelude//abi/constraints:gnu",
            "prelude//cpu/constraints:x86_64",
            "prelude//os/constraints:linux",
        ],
        "effect_utils//buck2/platforms:linux_aarch64": [
            "prelude//abi/constraints:gnu",
            "prelude//cpu/constraints:arm64",
            "prelude//os/constraints:linux",
        ],
        "effect_utils//buck2/platforms:macos_aarch64": [
            "prelude//cpu/constraints:arm64",
            "prelude//os/constraints:macos",
        ],
    }.get(target_platform)
    if constraints == None:
        fail("no product constraints are admitted for target platform {}".format(target_platform))
    return constraints

def host_execution_constraints():
    host = host_info()
    if host.os.is_linux and host.arch.is_x86_64:
        return native_execution_constraints("effect_utils//buck2/platforms:linux_x86_64")
    if host.os.is_linux and host.arch.is_aarch64:
        return native_execution_constraints("effect_utils//buck2/platforms:linux_aarch64")
    if host.os.is_macos and host.arch.is_aarch64:
        return native_execution_constraints("effect_utils//buck2/platforms:macos_aarch64")
    fail("host execution constraints support only x86_64-linux, aarch64-linux, and aarch64-darwin")
