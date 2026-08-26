"""Reusable effect-tsgo actions over a Buck-materialized package tree.

The package tree is the complete declared action input: package sources,
tsconfig, and a pruned node_modules closure. Producing that tree belongs to the
03-materialization boundary; these rules deliberately do not interpret the
non-authoritative TypeScript input-plan evidence.

The action shape follows
context/buck2/02-execution/.experiments/2026-08-25-tsgo-rule-prototype.md.
"""

load("@root//buck2/toolchains:defs.bzl", "EffectTsgoToolchainInfo")

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


def _tsgo_emit_impl(ctx):
    _require_relative_path(ctx.attrs.project, "project")
    _require_relative_path(ctx.attrs.out_dir, "out_dir")
    _require_relative_path(ctx.attrs.declaration_entrypoint, "declaration_entrypoint")
    toolchain = ctx.attrs._tsgo[EffectTsgoToolchainInfo]
    directory = ctx.actions.declare_output(ctx.attrs.out_dir, dir = True)

    # The materialized package tree remains immutable. tsgo sees an identical
    # writable staging layout, except that out_dir is a symlink to the sole
    # declared output. Making every other staged path read-only turns any
    # compiler write outside out_dir into an action failure.
    script = """package_tree="$2"
project="$3"
out_dir="$4"
declaration_entrypoint="$5"
output="$6"
staging="${TMPDIR:-/tmp}/tsgo-emit.$$"
trap 'rm -rf "$staging"' EXIT HUP INT TERM
mkdir -p "$staging/package"
cp -R "$package_tree"/. "$staging/package"/
rm -rf "$staging/package/$out_dir"
mkdir -p "$output"
output_abs=$(cd "$output" && pwd -P)
mkdir -p "$(dirname "$staging/package/$out_dir")"
ln -s "$output_abs" "$staging/package/$out_dir"
find "$staging/package" -type d -exec chmod a-w {} +
find "$staging/package" -type f -exec chmod a-w {} +
"$1" \
  --project "$staging/package/$project" \
  --outDir "$staging/package/$out_dir" \
  --noEmit false \
  --pretty false
if [ ! -f "$output/$declaration_entrypoint" ]; then
  printf '%s\n' "tsgo_emit: expected declaration entrypoint $out_dir/$declaration_entrypoint was not emitted" >&2
  exit 1
fi
"""
    args = cmd_args([
        "/bin/sh",
        "-eu",
        "-c",
        script,
        "tsgo-emit",
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
            default = "toolchains//:effect_tsgo",
            providers = [EffectTsgoToolchainInfo],
        )),
    },
)
