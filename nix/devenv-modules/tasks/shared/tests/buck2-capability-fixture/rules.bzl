"""Offline real action with the production pnpm_extract RunInfo input pattern."""

def _extract_impl(ctx):
    output = ctx.actions.declare_output("package", dir = True)
    ctx.actions.run(
        cmd_args([
            ctx.attrs.archive_tool[RunInfo],
            "extract-npm",
            "--archive",
            ctx.attrs.archive,
            "--out",
            output.as_output(),
            "--strip-prefix",
            "package",
            "--directory-input",
            ctx.attrs.directory,
        ]),
        category = "pnpm_extract",
        identifier = ctx.attrs.name,
        local_only = True,
    )
    return [DefaultInfo(default_output = output)]

pnpm_extract = rule(
    impl = _extract_impl,
    attrs = {
        "archive": attrs.source(),
        "archive_tool": attrs.exec_dep(providers = [RunInfo]),
        "directory": attrs.source(),
    },
)
