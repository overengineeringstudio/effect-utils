"""Bounded, deliberately non-hermetic checkout contracts during task cutover."""

load("@capabilities//:defs.bzl", "CAPABILITIES")
load("//buck2/platforms:defs.bzl", "cache_guarded_rule")
load("//buck2/toolchains:configured.bzl", "BuckStoreDirectoryInfo", "store_directory")
load("//buck2:static_checks.bzl", "StaticSourceSetInfo")
load("//buck2/toolchains:defs.bzl", "host_capability_platform")

def _quick_contracts_impl(ctx):
    runtime = ctx.attrs.runtime[BuckStoreDirectoryInfo]
    inputs = []
    for source_set in ctx.attrs.source_sets:
        inputs.extend(source_set[StaticSourceSetInfo].files)
    # Build the admitted deterministic aggregate first. These live checks have no
    # verdict action: checkout census, daemons, Nix and interruption are runtime
    # observations and must execute even when every declared byte is unchanged.
    inputs.extend(ctx.attrs.quick[DefaultInfo].default_outputs)
    inputs.extend(ctx.attrs.quick[DefaultInfo].other_outputs)
    command = cmd_args(
        cmd_args(runtime.directory, format = "{}/bin/quick-contracts"),
        hidden = inputs + [runtime.manifest],
    )
    return [
        DefaultInfo(other_outputs = inputs),
        # Native run preserves caller-owned profile, policy and trace context.
        RunInfo(args = command),
    ]

quick_contracts = cache_guarded_rule(
    impl = _quick_contracts_impl,
    attrs = {
        "quick": attrs.dep(),
        "runtime": attrs.exec_dep(providers = [BuckStoreDirectoryInfo]),
        "source_sets": attrs.list(attrs.dep(providers = [StaticSourceSetInfo])),
    },
)

def _unprepared_runtime_impl(_ctx):
    fail("full quick contracts need a prepared profile: run devenv build effectUtils.quickContracts.capabilities, publish WORKTREE_CAPABILITIES_PROFILE, then run its quick-contracts/bin/quick-contracts-prepare ROOT GENERATION")

_unprepared_runtime = cache_guarded_rule(impl = _unprepared_runtime_impl, attrs = {})

def quick_contracts_runtime(name, **kwargs):
    """Keep unconfigured source queries valid even before stage-zero preparation."""
    if "quick-contracts" not in CAPABILITIES.get(host_capability_platform(), {}):
        _unprepared_runtime(name = name, **kwargs)
    else:
        store_directory(name = name, protocol = "effect-utils/quick-contracts/v1", input_id = "quick-contracts", **kwargs)
