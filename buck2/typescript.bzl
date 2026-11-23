"""Reusable effect-tsgo actions over a Buck-materialized package view.

The package view and all normalized roots reachable through its links are the
complete declared action input. The pinned runner hashes every declared input
before and after execution so TypeScript actions remain write-free.
"""

load("//buck2:hermetic.bzl", "hermetic_bun_command", "ts_action", "ts_action_attrs")
load("//buck2/materialization.bzl", "PackageTreeInfo")
load("//buck2/platforms:defs.bzl", "cache_guarded_rule", "nativelink_pilot_execution_constraints", "nativelink_pilot_target", "ts_action_admission_status", "ts_action_cache_eligible", "ts_action_execution_constraints")
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
    verdict_directory = ctx.actions.declare_output("verdict", dir = True)
    verdict = verdict_directory.project("typecheck.ok")

    inputs = [toolchain.runner] + package_tree.read_roots
    args = cmd_args([
        hermetic_bun_command(ctx, toolchain.bun, sandbox_inputs = inputs),
        toolchain.runner,
        "workspace-check" if ctx.attrs.workspace_build else "typecheck",
        toolchain.executable,
        package_tree.tree,
        ctx.attrs.project,
        verdict,
    ])
    fingerprint = ctx.attrs._fingerprint_tool[BuckSupportToolInfo]
    args.add("--fingerprint-tool", fingerprint.store_path)
    args.add(cmd_args(hidden = [fingerprint.executable, fingerprint.manifest]))
    isolation = ctx.attrs._darwin_emit_isolation
    if ctx.attrs.workspace_build:
        if isolation not in ["sandbox-exec", "nix-build-sandbox"]:
            fail("Unknown Darwin workspace isolation mode: {}".format(isolation))
        args.add("--darwin-isolation", isolation)
    for read_root in package_tree.read_roots:
        args.add("--read-root", read_root)
    ts_action(
        ctx,
        args,
        inputs = inputs,
        outputs = [verdict_directory],
        tool_closures = {
            "buck2-fingerprint": fingerprint.closure_store_paths,
            "effect-tsgo": toolchain.closure_paths,
        },
        tool_inputs = toolchain.inputs + [fingerprint.executable, fingerprint.manifest],
        category = "tsgo_workspace_check" if ctx.attrs.workspace_build else "tsgo_typecheck",
        identifier = ctx.attrs.name,
        # Referenced workspace builds are not enrolled in the single-project pilot.
        remote_pilot = not ctx.attrs.workspace_build and nativelink_pilot_target(ctx.label.package, ctx.attrs.name),
        inherit_nix_build_environment = ctx.attrs.workspace_build and isolation == "nix-build-sandbox",
        # tsgo is a Go binary and Bun sizes its work pool from GOMAXPROCS:
        # this real thread setting binds both to the declared CPU budget,
        # and the matching weight lets the local pool admit host/2 concurrent
        # typechecks instead of host-wide goroutine sets per action.
        env = {"GOMAXPROCS": "2"},
        weight = 2,
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
        "workspace_build": attrs.bool(default = False),
        "_darwin_emit_isolation": attrs.default_only(attrs.string(
            default = read_root_config("typescript", "darwin_emit_isolation", "sandbox-exec"),
        )),
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
        exec_compatible_with = nativelink_pilot_execution_constraints(name, ts_action_execution_constraints(kwargs.pop("exec_compatible_with", []))),
        **kwargs
    )

def tsgo_workspace_check(name, **kwargs):
    """Force-check the authored project-reference graph in an isolated writable copy."""
    _tsgo_typecheck(
        name = name,
        workspace_build = True,
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
        directory,
    ])
    fingerprint = ctx.attrs._fingerprint_tool[BuckSupportToolInfo]
    args.add("--fingerprint-tool", fingerprint.store_path)
    args.add(cmd_args(hidden = [fingerprint.executable, fingerprint.manifest]))
    isolation = ctx.attrs._darwin_emit_isolation
    if isolation not in ["sandbox-exec", "nix-build-sandbox"]:
        fail("Unknown Darwin emit isolation mode: {}".format(isolation))
    args.add("--darwin-isolation", isolation)
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
        tool_closures = {
            "buck2-fingerprint": fingerprint.closure_store_paths,
            "effect-tsgo": toolchain.closure_paths,
        },
        tool_inputs = toolchain.inputs + [fingerprint.executable, fingerprint.manifest],
        category = "tsgo_emit",
        identifier = ctx.attrs.name,
        remote_pilot = nativelink_pilot_target(ctx.label.package, ctx.attrs.name),
        inherit_nix_build_environment = isolation == "nix-build-sandbox",
        # Same declared budget as typecheck: GOMAXPROCS binds tsgo's goroutines
        # and Bun's pool; weight matches so emit never claims more slots.
        env = {"GOMAXPROCS": "2"},
        weight = 2,
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
        "_darwin_emit_isolation": attrs.default_only(attrs.string(
            default = read_root_config("typescript", "darwin_emit_isolation", "sandbox-exec"),
        )),
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
        exec_compatible_with = nativelink_pilot_execution_constraints(name, ts_action_execution_constraints(kwargs.pop("exec_compatible_with", []))),
        **kwargs
    )
