"""Prototype: can Buck memoize the real contract DAG without broad invalidation?"""

load("@capabilities//:defs.bzl", "CAPABILITIES")
load("//buck2/platforms:defs.bzl", "cache_guarded_rule", "host_execution_constraints")
load("//buck2/toolchains:configured.bzl", "BuckStoreDirectoryInfo", "BuckSupportToolInfo", "store_directory", "support_tool")
load("//buck2:static_checks.bzl", "StaticSourceSetInfo")
load("//buck2/toolchains:defs.bzl", "ConfiguredRustToolchainInfo", "host_capability_platform")
load("//buck2/products:defs.bzl", "BuildProductInfo")
load("//buck2/tests/ts_sandbox:probe.bzl", "TsSandboxProbeInfo")

def _contract_slug(task):
    return task.replace(":", "-")

def _cpu_weight_args(demand):
    """Project the declared CPU demand into Buck local-execution concurrency weight."""
    if demand == "single-thread":
        # One pool slot: the task runs one sequential process and stays
        # independently schedulable next to other single-thread contracts.
        return {"weight": 1}
    if demand.startswith("bounded:"):
        count = demand[len("bounded:"):]
        if not count.isdigit() or int(count) < 1:
            fail("quick contract bounded CPU demand must be a positive integer: {}".format(demand))
        return {"weight": int(count)}
    if demand == "whole-pool":
        # The task's tooling spawns host-wide workers (live Buck daemons,
        # watchers, pool-parallel generators, rustc) that no supported
        # per-action thread bound admits; reserve the entire local pool so
        # the contract DAG cannot oversubscribe the host.
        return {"weight_percentage": 100}
    fail("unknown quick contract CPU demand: {}".format(demand))

def _contract_impl(ctx):
    tool = ctx.attrs.runtime[BuckSupportToolInfo]
    verdict = ctx.actions.declare_output("passed.json")
    digest = ctx.attrs.membership_digest
    if ctx.attrs.membership and (len(digest) != 64 or any([character not in "0123456789abcdef" for character in digest.elems()])):
        fail("quick contract {} requires a valid membership SHA256; invoke Buck through the managed entrypoint (quick_contracts.membership_{})".format(ctx.attrs.task, _contract_slug(ctx.attrs.task)))
    membership = ctx.actions.write_json("membership.json", {
        "schemaVersion": 1,
        "task": ctx.attrs.task,
        "membership": ctx.attrs.membership,
        "membership_mode": ctx.attrs.membership_mode,
        "digest": digest,
    })
    sources = {}
    for dependency in ctx.attrs.source_sets:
        source_set = dependency[StaticSourceSetInfo]
        for source in source_set.files:
            path = source.short_path if not source_set.prefix else source_set.prefix + "/" + source.short_path
            if path in sources:
                fail("duplicate quick contract input {}".format(path))
            sources[path] = source
    predecessors = []
    for dependency in ctx.attrs.requires:
        predecessors.extend(dependency[DefaultInfo].default_outputs)
    # Local actions inherit daemon-startup env. Resolve the owning receipt below
    # the task boundary instead of preserving a stale daemon's profile override.
    context = {"NIX_CONFIG": "builders =", "WORKTREE_CAPABILITIES_PROFILE": ""}
    actor = ctx.attrs.agent_actor
    if actor:
        context["FRACTAL_AGENT"] = actor
        context["ST_AGENT"] = actor
    if ctx.attrs.policy_path:
        context["WORKTREE_POLICY_PATH"] = ctx.attrs.policy_path
    native_inputs = []
    if ctx.attrs.native_ts_sandbox != None:
        probe = ctx.attrs.native_ts_sandbox[TsSandboxProbeInfo]
        context.update({
            "QUICK_CONTRACT_NATIVE_INPUTS": "1",
            "TS_SANDBOX_LAUNCHER": cmd_args(probe.launcher),
            "TS_SANDBOX_PROBE_OUTPUT": cmd_args(probe.summary),
            "BWRAP_BIN": probe.sandbox.bubblewrap,
            "BUN_BIN": probe.sandbox.bun,
            "BASH_BIN": probe.sandbox.shell,
        })
        native_inputs = [probe.launcher, probe.summary] + probe.sandbox.inputs + probe.sandbox.bun_inputs
    # These checkout/fixture proofs are intentionally on the NONREMOTE platform.
    # Same-daemon DICE reuse is allowed; shared/persistent action-cache admission
    # is not implied by local_only or by an isolated fixture's successful result.
    ctx.actions.run(
        cmd_args(
            [tool.store_path, verdict.as_output()],
            hidden = [sources[path] for path in sorted(sources)] + predecessors + native_inputs + [
                membership, tool.executable, tool.manifest,
            ],
        ),
        env = context,
        local_only = True,
        allow_cache_upload = False,
        category = "quick_contract_fixture" if ctx.attrs.cache_policy == "local-fixture" else "quick_contract_validation",
        identifier = ctx.attrs.task,
        **_cpu_weight_args(ctx.attrs.cpu_demand)
    )
    return [DefaultInfo(default_output = verdict)]

quick_contract = cache_guarded_rule(
    impl = _contract_impl,
    attrs = {
        "task": attrs.string(),
        "runtime": attrs.exec_dep(providers = [BuckSupportToolInfo]),
        "source_sets": attrs.list(attrs.dep(providers = [StaticSourceSetInfo])),
        "membership": attrs.list(attrs.string()),
        "membership_mode": attrs.enum(["tracked", "tracked-and-untracked"]),
        "membership_digest": attrs.string(),
        "requires": attrs.list(attrs.dep()),
        "cache_policy": attrs.enum(["local-validation", "local-fixture"]),
        "cpu_demand": attrs.string(),
        "agent_actor": attrs.string(),
        "policy_path": attrs.string(),
        "native_ts_sandbox": attrs.option(attrs.dep(providers = [TsSandboxProbeInfo]), default = None),
    },
)

def _provider_contract_impl(ctx):
    # Resolving these configured deps runs the original toolchain/product
    # implementations, including their shared-provider and platform guards.
    # This is an analysis verdict, not a recursive `buck2 audit` action.
    verdict = ctx.actions.write_json("passed.json", {
        "task": ctx.attrs.task,
        "status": "passed",
    })
    predecessors = []
    for dependency in ctx.attrs.requires:
        predecessors.extend(dependency[DefaultInfo].default_outputs)
    return [DefaultInfo(default_output = verdict, other_outputs = predecessors)]

_provider_contract = cache_guarded_rule(
    impl = _provider_contract_impl,
    attrs = {
        "task": attrs.string(),
        "toolchain": attrs.toolchain_dep(providers = [ConfiguredRustToolchainInfo]),
        "product": attrs.dep(providers = [BuildProductInfo]),
        "requires": attrs.list(attrs.dep()),
    },
)

def _quick_contracts_impl(ctx):
    runtime = ctx.attrs.runtime[BuckStoreDirectoryInfo]
    verdicts = []
    for contract in ctx.attrs.contracts:
        verdicts.extend(contract[DefaultInfo].default_outputs)
    inputs = list(verdicts)
    for contract in ctx.attrs.contracts:
        inputs.extend(contract[DefaultInfo].other_outputs)
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
        native_providers = spec.get("native_providers")
        if native_providers != None:
            _provider_contract(
                name = target,
                task = task,
                toolchain = native_providers["toolchain"],
                product = native_providers["product"],
                requires = [":" + name + "__" + _contract_slug(dependency) for dependency in spec["requires"]],
                default_target_platform = "//buck2/platforms:host_platform",
                exec_compatible_with = host_execution_constraints(),
                visibility = kwargs.get("visibility", []),
            )
            targets.append(":" + target)
            continue
        cpu_demand = spec.get("cpu_demand")
        if cpu_demand == None:
            fail("quick contract {} requires a cpu_demand declaration in nix/quick-contracts-targets.json; regenerate the owning BUCK with genie:run".format(task))
        quick_contract(
            name = target,
            task = task,
            runtime = "//buck2/toolchains:quick_contract_" + _contract_slug(task),
            source_sets = spec["source_sets"],
            membership = spec["membership"],
            membership_mode = spec["membership_mode"],
            membership_digest = read_root_config("quick_contracts", "membership_" + _contract_slug(task), ""),
            requires = [":" + name + "__" + _contract_slug(dependency) for dependency in spec["requires"]],
            cache_policy = spec["cache_policy"],
            cpu_demand = cpu_demand,
            agent_actor = read_root_config("quick_contracts", "agent_actor", ""),
            policy_path = read_root_config("quick_contracts", "policy_path", ""),
            native_ts_sandbox = spec.get("native_ts_sandbox") if host_info().os.is_linux else None,
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
