"""Reusable effect-tsgo actions over a Buck-materialized package tree.

The package tree is the complete declared action input: package sources,
tsconfig, and a pruned node_modules closure. Producing that tree belongs to the
03-materialization boundary; these rules deliberately do not interpret the
non-authoritative TypeScript input-plan evidence.

The action shape follows
context/buck2/02-execution/.experiments/2026-08-25-tsgo-rule-prototype.md.
"""

load("@effect_utils//buck2/toolchains:defs.bzl", "EffectTsgoToolchainInfo")

TsgoTypecheckInfo = provider(fields = {
    "toolchain_identity": str,
    "verdict": Artifact,
})

TsgoEmitInfo = provider(fields = {
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
    verdict = ctx.actions.declare_output("typecheck.ok")

    # The pinned runner hashes the complete input tree before and after tsgo.
    # Disabling both composite and incremental mode makes --noEmit write-free;
    # the byte invariant turns any compiler regression into an action failure.
    args = cmd_args([
        toolchain.bun,
        toolchain.runner,
        "typecheck",
        toolchain.executable,
        ctx.attrs.package_tree,
        ctx.attrs.project,
        verdict.as_output(),
    ])
    ctx.actions.run(
        args,
        category = "tsgo_typecheck",
        identifier = ctx.attrs.name,
        local_only = True,
    )
    return [
        DefaultInfo(default_output = verdict),
        TsgoTypecheckInfo(
            toolchain_identity = toolchain.identity,
            verdict = verdict,
        ),
    ]


tsgo_typecheck = rule(
    impl = _tsgo_typecheck_impl,
    attrs = {
        "package_tree": attrs.source(),
        "project": attrs.string(default = "tsconfig.json"),
        "_tsgo": attrs.default_only(attrs.exec_dep(
            default = "effect_utils//toolchains:effect_tsgo",
            providers = [EffectTsgoToolchainInfo],
        )),
    },
)


def _tsgo_emit_impl(ctx):
    _require_relative_path(ctx.attrs.project, "project")
    _require_relative_path(ctx.attrs.out_dir, "out_dir")
    _require_relative_path(ctx.attrs.declaration_entrypoint, "declaration_entrypoint")
    toolchain = ctx.attrs._tsgo[EffectTsgoToolchainInfo]
    directory = ctx.actions.declare_output(ctx.attrs.out_dir, dir = True)

    # The pinned runner copies the input tree with platform filesystem APIs,
    # replaces out_dir with the sole writable output, makes all staged inputs
    # read-only, invokes tsgo directly, validates declarations, and restores
    # write bits only while removing staging. No host shell or PATH tool enters
    # the action contract.
    args = cmd_args([
        toolchain.bun,
        toolchain.runner,
        "emit",
        toolchain.executable,
        ctx.attrs.package_tree,
        ctx.attrs.project,
        ctx.attrs.out_dir,
        ctx.attrs.declaration_entrypoint,
        directory.as_output(),
    ])
    ctx.actions.run(
        args,
        category = "tsgo_emit",
        identifier = ctx.attrs.name,
        local_only = True,
    )
    return [
        DefaultInfo(default_output = directory),
        TsgoEmitInfo(
            directory = directory,
            toolchain_identity = toolchain.identity,
        ),
    ]


tsgo_emit = rule(
    impl = _tsgo_emit_impl,
    attrs = {
        "package_tree": attrs.source(),
        "project": attrs.string(default = "tsconfig.json"),
        "out_dir": attrs.string(default = "dist"),
        "declaration_entrypoint": attrs.string(default = "src/mod.d.ts"),
        "_tsgo": attrs.default_only(attrs.exec_dep(
            default = "effect_utils//toolchains:effect_tsgo",
            providers = [EffectTsgoToolchainInfo],
        )),
    },
)
