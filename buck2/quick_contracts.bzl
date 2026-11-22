"""Prototype: can Buck memoize the real contract DAG without broad invalidation?"""

load("@capabilities//:defs.bzl", "CAPABILITIES")
load("//buck2/platforms:defs.bzl", "cache_guarded_rule", "host_execution_constraints")
load("//buck2/toolchains:configured.bzl", "BuckStoreDirectoryInfo", "BuckSupportToolInfo", "store_directory", "support_tool")
load("//buck2:static_checks.bzl", "StaticSourceSetInfo")
load("//buck2/toolchains:defs.bzl", "host_capability_platform")

def _contract_slug(task):
    return task.replace(":", "-")

def _contract_impl(ctx):
    tool = ctx.attrs.runtime[BuckSupportToolInfo]
    verdict = ctx.actions.declare_output("passed.json")
    membership = ctx.actions.write_json("membership.json", ctx.attrs.members)
    wanted = {path: None for path in ctx.attrs.input_paths}
    sources = {}
    for dependency in ctx.attrs.source_sets:
        source_set = dependency[StaticSourceSetInfo]
        for source in source_set.files:
            path = source.short_path if not source_set.prefix else source_set.prefix + "/" + source.short_path
            if path in wanted:
                if path in sources:
                    fail("duplicate quick contract input {}".format(path))
                sources[path] = source
    missing = sorted([path for path in wanted if path not in sources])
    if missing:
        fail("quick contract {} has undeclared inputs {}".format(ctx.attrs.task, missing))
    predecessors = []
    for dependency in ctx.attrs.requires:
        predecessors.extend(dependency[DefaultInfo].default_outputs)
    context = {"NIX_CONFIG": "builders ="}
    actor = ctx.attrs.agent_actor
    if actor:
        context["FRACTAL_AGENT"] = actor
        context["ST_AGENT"] = actor
    if ctx.attrs.policy_path:
        context["WORKTREE_POLICY_PATH"] = ctx.attrs.policy_path
    # These checkout/fixture proofs are intentionally on the NONREMOTE platform.
    # Same-daemon DICE reuse is allowed; shared/persistent action-cache admission
    # is not implied by local_only or by an isolated fixture's successful result.
    ctx.actions.run(
        cmd_args(
            [tool.store_path, verdict.as_output()],
            hidden = [sources[path] for path in sorted(sources)] + predecessors + [
                membership, tool.executable, tool.manifest,
            ],
        ),
        env = context,
        local_only = True,
        allow_cache_upload = False,
        category = "quick_contract_fixture" if ctx.attrs.cache_policy == "local-fixture" else "quick_contract_validation",
        identifier = ctx.attrs.task,
    )
    return [DefaultInfo(default_output = verdict)]

_contract = cache_guarded_rule(
    impl = _contract_impl,
    attrs = {
        "task": attrs.string(),
        "runtime": attrs.exec_dep(providers = [BuckSupportToolInfo]),
        "source_sets": attrs.list(attrs.dep(providers = [StaticSourceSetInfo])),
        "input_paths": attrs.list(attrs.string()),
        "members": attrs.list(attrs.string()),
        "requires": attrs.list(attrs.dep()),
        "cache_policy": attrs.enum(["local-validation", "local-fixture"]),
        "agent_actor": attrs.string(),
        "policy_path": attrs.string(),
    },
)

def _quick_contracts_impl(ctx):
    runtime = ctx.attrs.runtime[BuckStoreDirectoryInfo]
    verdicts = []
    for contract in ctx.attrs.contracts:
        verdicts.extend(contract[DefaultInfo].default_outputs)
    inputs = list(verdicts)
    for source_set in ctx.attrs.source_sets:
        inputs.extend(source_set[StaticSourceSetInfo].files)
    inputs.extend(ctx.attrs.quick[DefaultInfo].default_outputs)
    inputs.extend(ctx.attrs.quick[DefaultInfo].other_outputs)
    command = cmd_args(
        cmd_args(runtime.directory, format = "{}/bin/quick-contracts-report"),
        verdicts,
        hidden = inputs + [runtime.manifest],
    )
    return [
        DefaultInfo(other_outputs = inputs),
        # The uncached reporter retains caller-owned tool/authority preparation.
        RunInfo(args = command),
    ]

_quick_contracts = cache_guarded_rule(
    impl = _quick_contracts_impl,
    attrs = {
        "quick": attrs.dep(),
        "contracts": attrs.list(attrs.dep()),
        "runtime": attrs.exec_dep(providers = [BuckStoreDirectoryInfo]),
        "source_sets": attrs.list(attrs.dep(providers = [StaticSourceSetInfo])),
    },
)

def quick_contracts(name, quick, runtime, source_sets, contracts, **kwargs):
    capabilities = CAPABILITIES.get(host_capability_platform(), {})
    known = {"quick-contract-" + _contract_slug(task): task for task in contracts}
    selected = sorted([task for capability, task in known.items() if capability in capabilities])
    if not selected:
        _unprepared_runtime(name = name, **kwargs)
        return
    unknown = [
        key
        for key in capabilities
        if key.startswith("quick-contract-") and key not in known
    ]
    if unknown or len(selected) not in [22, 23]:
        fail("quick contracts need the complete evaluated host23/CI22 cohort; unknown={}".format(unknown))
    targets = []
    for task in selected:
        spec = contracts[task]
        missing = [dependency for dependency in spec["requires"] if dependency not in selected]
        if missing:
            fail("quick contract {} has omitted prerequisites {}".format(task, missing))
        target = name + "__" + _contract_slug(task)
        _contract(
            name = target,
            task = task,
            runtime = "//buck2/toolchains:quick_contract_" + _contract_slug(task),
            source_sets = spec["source_sets"],
            input_paths = spec["input_paths"],
            members = spec.get("members", []),
            requires = [":" + name + "__" + _contract_slug(dependency) for dependency in spec["requires"]],
            cache_policy = spec["cache_policy"],
            agent_actor = read_root_config("quick_contracts", "agent_actor", ""),
            policy_path = read_root_config("quick_contracts", "policy_path", ""),
            exec_compatible_with = host_execution_constraints(),
            visibility = kwargs.get("visibility", []),
        )
        targets.append(":" + target)
    _quick_contracts(
        name = name,
        quick = quick,
        runtime = runtime,
        source_sets = source_sets,
        contracts = targets,
        **kwargs
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
        for tool_id in sorted(CAPABILITIES.get(host_capability_platform(), {})):
            if tool_id.startswith("quick-contract-"):
                support_tool(
                    name = "quick_contract_" + tool_id.removeprefix("quick-contract-"),
                    protocol = "effect-utils/quick-contract-task/v1",
                    tool_id = tool_id,
                    **kwargs
                )
