"""Reusable effect-tsgo actions over a Buck-materialized package view.

The package view and all normalized roots reachable through its links are the
complete declared action input. The pinned runner hashes every declared input
before and after execution so TypeScript actions remain write-free.
"""

load("//buck2:hermetic.bzl", "hermetic_bun_command", "ts_action", "ts_action_attrs")
load("//buck2/materialization.bzl", "PackageTreeInfo")
load("//buck2/platforms:defs.bzl", "cache_guarded_rule", "ts_action_admission_status", "ts_action_cache_eligible", "ts_action_execution_constraints")
load("//buck2/toolchains:configured.bzl", "BuckSupportToolInfo")
load("//buck2/toolchains:defs.bzl", "EffectTsgoToolchainInfo")

TsgoTypecheckInfo = provider(fields = {
    "admission_status": str,
    "toolchain_identity": str,
    "verdict": Artifact,
})

TsgoEmitInfo = provider(fields = {
    "admission_status": str,
    "directory": Artifact,
    "toolchain_identity": str,
})

def _require_relative_path(value, field):
    if not value:
        fail("{} must not be empty".format(field))
    if value.startswith("/"):
        fail("{} must be relative to package_tree: {}".format(field, value))
    for component in value.split("/"):
        if component == "" or component == "." or component == "..":
            fail("{} must be normalized: {}".format(field, value))

def _tsgo_typecheck_impl(ctx):
    _require_relative_path(ctx.attrs.project, "project")
    toolchain = ctx.attrs._tsgo[EffectTsgoToolchainInfo]
    package_tree = ctx.attrs.package_tree[PackageTreeInfo]
    verdict = ctx.actions.declare_output("typecheck.ok")

    inputs = [toolchain.runner] + package_tree.read_roots
    args = cmd_args([
        hermetic_bun_command(ctx, toolchain.bun, sandbox_inputs = inputs),
        toolchain.runner,
        "typecheck",
        toolchain.executable,
        package_tree.tree,
        ctx.attrs.project,
        verdict.as_output(),
    ])
    fingerprint = ctx.attrs._fingerprint_tool[BuckSupportToolInfo]
    args.add("--fingerprint-tool", fingerprint.store_path)
    args.add(cmd_args(hidden = [fingerprint.executable, fingerprint.manifest]))
    for read_root in package_tree.read_roots:
        args.add("--read-root", read_root)
    ts_action(
        ctx,
        args,
        inputs = inputs,
        outputs = [verdict],
        tools = ["effect-tsgo", "buck2-fingerprint"],
        category = "tsgo_typecheck",
        identifier = ctx.attrs.name,
        local_only = True,
    )
    return [
        DefaultInfo(default_output = verdict),
        TsgoTypecheckInfo(
            admission_status = ts_action_admission_status(ctx),
            toolchain_identity = toolchain.identity,
            verdict = verdict,
        ),
    ]

_tsgo_typecheck = cache_guarded_rule(
    cache_eligible = ts_action_cache_eligible,
    impl = _tsgo_typecheck_impl,
    attrs = dict(ts_action_attrs(), **{
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "project": attrs.string(default = "tsconfig.json"),
        "_tsgo": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:effect_tsgo",
            providers = [EffectTsgoToolchainInfo],
        )),
        "_fingerprint_tool": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:fingerprint_tool",
            providers = [BuckSupportToolInfo],
        )),
    }),
)

def tsgo_typecheck(name, **kwargs):
    _tsgo_typecheck(
        name = name,
        exec_compatible_with = ts_action_execution_constraints(kwargs.pop("exec_compatible_with", [])),
        **kwargs
    )

def _tsgo_emit_impl(ctx):
    _require_relative_path(ctx.attrs.project, "project")
    _require_relative_path(ctx.attrs.out_dir, "out_dir")
    if ctx.attrs.declaration_entrypoint:
        _require_relative_path(ctx.attrs.declaration_entrypoint, "declaration_entrypoint")
    toolchain = ctx.attrs._tsgo[EffectTsgoToolchainInfo]
    package_tree = ctx.attrs.package_tree[PackageTreeInfo]
    directory = ctx.actions.declare_output(ctx.attrs.out_dir, dir = True)

    inputs = [toolchain.runner] + package_tree.read_roots + ctx.attrs.declaration_sources.values()
    args = cmd_args([
        hermetic_bun_command(ctx, toolchain.bun, sandbox_inputs = inputs),
        toolchain.runner,
        "emit",
        toolchain.executable,
        package_tree.tree,
        ctx.attrs.project,
        ctx.attrs.out_dir,
        ctx.attrs.declaration_entrypoint,
        directory.as_output(),
    ])
    fingerprint = ctx.attrs._fingerprint_tool[BuckSupportToolInfo]
    args.add("--fingerprint-tool", fingerprint.store_path)
    args.add(cmd_args(hidden = [fingerprint.executable, fingerprint.manifest]))
    for read_root in package_tree.read_roots:
        args.add("--read-root", read_root)
    for declaration_path in sorted(ctx.attrs.declaration_sources.keys()):
        _require_relative_path(declaration_path, "declaration source")
        args.add("--copy-declaration", declaration_path)
    args.add(cmd_args(hidden = ctx.attrs.declaration_sources.values()))
    ts_action(
        ctx,
        args,
        inputs = inputs,
        outputs = [directory],
        tools = ["effect-tsgo", "buck2-fingerprint"],
        category = "tsgo_emit",
        identifier = ctx.attrs.name,
        local_only = True,
    )
    return [
        DefaultInfo(default_output = directory),
        TsgoEmitInfo(
            directory = directory,
            admission_status = ts_action_admission_status(ctx),
            toolchain_identity = toolchain.identity,
        ),
    ]

_tsgo_emit = cache_guarded_rule(
    cache_eligible = ts_action_cache_eligible,
    impl = _tsgo_emit_impl,
    attrs = dict(ts_action_attrs(), **{
        "package_tree": attrs.dep(providers = [PackageTreeInfo]),
        "project": attrs.string(default = "tsconfig.json"),
        "out_dir": attrs.string(default = "dist"),
        "declaration_entrypoint": attrs.string(default = ""),
        "declaration_sources": attrs.dict(
            key = attrs.string(),
            value = attrs.source(),
            default = {},
        ),
        "_tsgo": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:effect_tsgo",
            providers = [EffectTsgoToolchainInfo],
        )),
        "_fingerprint_tool": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:fingerprint_tool",
            providers = [BuckSupportToolInfo],
        )),
    }),
)

def tsgo_emit(name, **kwargs):
    _tsgo_emit(
        name = name,
        exec_compatible_with = ts_action_execution_constraints(kwargs.pop("exec_compatible_with", [])),
        **kwargs
    )
