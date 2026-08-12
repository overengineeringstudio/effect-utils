"""Execution tools realized outside Buck and admitted by immutable path identity."""

def _configured_exec_impl(ctx):
    if not ctx.attrs.path.startswith("/nix/store/"):
        fail("configured execution tool must be an immutable Nix store path")
    return [RunInfo(args = cmd_args(ctx.attrs.path))]

configured_exec = rule(
    impl = _configured_exec_impl,
    attrs = {
        "path": attrs.string(),
    },
)
