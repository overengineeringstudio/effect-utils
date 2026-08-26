"""Reusable effect-tsgo typecheck over a Buck-materialized package tree.

The package tree is the complete declared action input: package sources,
tsconfig, and a pruned node_modules closure. Producing that tree belongs to the
03-materialization boundary; this rule deliberately does not interpret the
non-authoritative TypeScript input-plan evidence.

The action shape follows
context/buck2/02-execution/.experiments/2026-08-25-tsgo-rule-prototype.md.
"""

load("@root//buck2/toolchains:defs.bzl", "EffectTsgoToolchainInfo")

TsgoTypecheckInfo = provider(fields = {
    "toolchain_identity": str,
    "verdict": Artifact,
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

    # --noEmit keeps the declared package tree read-only and makes the small
    # verdict the only output. Passing the tree Artifact on argv makes its full
    # digest, including node_modules declarations, part of the action key.
    args = cmd_args([
        "/bin/sh",
        "-eu",
        "-c",
        "\"$1\" --project \"$2/$3\" --noEmit --pretty false\nprintf \"%s\\n\" \"$1\" > \"$4\"",
        "tsgo-typecheck",
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
            default = "toolchains//:effect_tsgo",
            providers = [EffectTsgoToolchainInfo],
        )),
    },
)
