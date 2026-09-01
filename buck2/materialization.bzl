"""Generic TypeScript package-tree assembly from declared Buck artifacts."""

load("//buck2/toolchains:defs.bzl", "BunToolchainInfo")


PackageTreeInfo = provider(fields = {
    "tree": Artifact,
})


def _require_relative_path(value, field):
    if not value:
        fail("{} must not be empty".format(field))
    if value.startswith("/") or "\\" in value:
        fail("{} must be a portable relative path: {}".format(field, value))
    for component in value.split("/"):
        if component == "" or component == "." or component == "..":
            fail("{} must be normalized: {}".format(field, value))


def _add_mapped_sources(args, flag, sources):
    for destination in sorted(sources.keys()):
        _require_relative_path(destination, flag)
        args.add(flag, destination, sources[destination])

def _package_tree_impl(ctx):
    node_modules = ctx.attrs.node_modules
    out = ctx.actions.declare_output("package_tree", dir = True)
    _require_relative_path(ctx.attrs.runtime_entry, "runtime entry")

    # The runner is staged as a directory holding its complete relative-import
    # closure, so a sibling `./module.ts` import resolves inside the action.
    # Only the declared modules are present: an undeclared one fails closed.
    runtime_tree = ctx.attrs.runtime[DefaultInfo].default_outputs[0]
    args = cmd_args([
        ctx.attrs._bun[BunToolchainInfo].executable,
        cmd_args(runtime_tree, format = "{}/" + ctx.attrs.runtime_entry),
        "--output",
        out.as_output(),
        "--node-modules",
        node_modules,
    ])
    _add_mapped_sources(args, "--file", ctx.attrs.files)
    _add_mapped_sources(args, "--workspace-file", ctx.attrs.workspace_files)
    for link_path in sorted(ctx.attrs.workspace_links.keys()):
        target_path = ctx.attrs.workspace_links[link_path]
        _require_relative_path(link_path, "workspace link")
        _require_relative_path(target_path, "workspace link target")
        args.add("--workspace-link", link_path, target_path)
    ctx.actions.run(
        args,
        category = "package_tree",
        identifier = ctx.attrs.name,
        local_only = True,
        allow_cache_upload = True,
    )
    return [
        DefaultInfo(default_output = out),
        PackageTreeInfo(tree = out),
    ]


_package_tree = rule(
    impl = _package_tree_impl,
    attrs = {
        "node_modules": attrs.source(),
        "files": attrs.dict(key = attrs.string(), value = attrs.source()),
        "workspace_files": attrs.dict(
            key = attrs.string(),
            value = attrs.source(),
            default = {},
        ),
        "workspace_links": attrs.dict(
            key = attrs.string(),
            value = attrs.string(),
            default = {},
        ),
        "runtime": attrs.dep(providers = [DefaultInfo]),
        "runtime_entry": attrs.string(),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:bun",
            providers = [BunToolchainInfo],
        )),
    },
)


def package_tree(name, node_modules, files, runtime, runtime_entry, workspace_siblings = {}, **kwargs):
    """Assembles one package tree; sibling specs carry files plus node_modules-relative links."""
    workspace_files = {}
    workspace_links = {}
    for sibling_name in sorted(workspace_siblings.keys()):
        _require_relative_path(sibling_name, "workspace sibling")
        sibling = workspace_siblings[sibling_name]
        sibling_root = ".workspace-siblings/{}".format(sibling_name)
        for destination, source in sibling.get("files", {}).items():
            _require_relative_path(destination, "workspace sibling file")
            workspace_files["{}/{}".format(sibling_root, destination)] = source
        for link in sibling.get("links", []):
            _require_relative_path(link, "workspace sibling link")
            link_path = "node_modules/{}".format(link)
            if link_path in workspace_links:
                fail("duplicate workspace sibling link: {}".format(link_path))
            workspace_links[link_path] = sibling_root
    _package_tree(
        name = name,
        node_modules = node_modules,
        files = files,
        runtime = runtime,
        runtime_entry = runtime_entry,
        workspace_files = workspace_files,
        workspace_links = workspace_links,
        **kwargs
    )


def export_materialization_inputs(inputs):
    """Exports explicit root inputs for package-local rules."""
    for source in inputs:
        native.export_file(
            name = source,
            src = source,
            visibility = ["PUBLIC"],
        )
