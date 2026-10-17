"""Real-action fixture for the vendored Prelude interception seam."""
load("//adapter-source/prelude/rust:action_adapter.bzl", "adapt_rustc_action")

def _fixture_rust_adapter_impl(ctx):
    output = ctx.actions.declare_output("result.txt")
    diagnostic = ctx.actions.declare_output("diag.txt")
    sidecar = ctx.actions.declare_output("sidecar", dir = True)
    shell = read_root_config("fixture", "shell")
    coreutils = read_root_config("fixture", "coreutils")
    command = cmd_args(
        shell, "--noprofile", "--norc", "-c",
        'printf "result\\n" > "$1"; printf "diagnostic\\n" > "$2"; "$4" --coreutils-prog=mkdir -p "$3"; printf "sidecar\\n" > "$3/hidden.txt"',
        "--", output.as_output(), diagnostic.as_output(),
        cmd_args(sidecar, ignore_artifacts = True), coreutils,
        hidden = [sidecar.as_output()],
    )
    options = {}
    if read_root_config("fixture", "bypass_adapter", "false") != "true":
        adapter = None if read_root_config("fixture", "missing_adapter", "false") == "true" else RunInfo(args = cmd_args(shell, ctx.attrs.adapter))
        command, options = adapt_rustc_action(ctx, command, adapter, "fixture")
    ctx.actions.run(command, category = "rust_adapter_posture", **options)
    return [DefaultInfo(default_output = output, other_outputs = [diagnostic, sidecar])]

fixture_rust_adapter = rule(
    impl = _fixture_rust_adapter_impl,
    attrs = {"adapter": attrs.source(default = "//:rust-action-adapter.sh")},
)
