"""Manifest-only pnpm materialization and generic TypeScript package trees."""

load("@effect_utils//buck2/toolchains:defs.bzl", "PnpmMaterializerToolchainInfo")

PnpmNodeModulesInfo = provider(fields = {
    "editor_inputs": Artifact,
    "node_modules": Artifact,
    "toolchain_identity": str,
})

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


def _pnpm_node_modules_impl(ctx):
    toolchain = ctx.attrs._materializer[PnpmMaterializerToolchainInfo]
    runtime = ctx.actions.copied_dir(
        "pnpm_materializer_runtime",
        {
            "buck2-materializer.ts": ctx.attrs.runtime,
            "pnpm-deploy-normalizer.ts": ctx.attrs.normalizer,
            "pnpm-install-descriptor.ts": ctx.attrs.descriptor_module,
        },
    )
    runtime_entry = runtime.project("buck2-materializer.ts")
    descriptor = ctx.actions.declare_output("pnpm_install_descriptor", dir = True)
    # `runtime_entry` is a projection from a copied directory; keep the authored
    # modules as explicit hidden inputs so implementation edits always move the action key.
    prune_args = cmd_args([
        toolchain.bun,
        runtime_entry,
        "prune-node-modules",
        "--output",
        descriptor.as_output(),
        "--package-name",
        ctx.attrs.package_name,
        "--pnpm",
        toolchain.pnpm,
        "--store-dir",
        toolchain.store_dir,
        "--root-package-json",
        ctx.attrs.root_package_json,
        "--lockfile",
        ctx.attrs.lockfile,
        "--workspace-manifest",
        ctx.attrs.workspace_manifest,
    ], hidden = [ctx.attrs.runtime, ctx.attrs.descriptor_module, ctx.attrs.normalizer])
    _add_mapped_sources(prune_args, "--package-manifest", ctx.attrs.workspace_package_manifests)
    _add_mapped_sources(prune_args, "--patch", ctx.attrs.patches)
    ctx.actions.run(
        prune_args,
        category = "pnpm_pruned_lock",
        identifier = ctx.attrs.name,
        local_only = True,
        allow_cache_upload = True,
    )

    out = ctx.actions.declare_output("node_modules", dir = True)
    install_args = cmd_args([
        toolchain.bun,
        runtime_entry,
        "materialize-node-modules",
        "--output",
        out.as_output(),
        "--descriptor",
        descriptor,
        "--pnpm",
        toolchain.pnpm,
        "--store-dir",
        toolchain.store_dir,
    ], hidden = [ctx.attrs.runtime, ctx.attrs.descriptor_module, ctx.attrs.normalizer])
    ctx.actions.run(
        install_args,
        category = "pnpm_node_modules",
        identifier = ctx.attrs.name,
        local_only = True,
        allow_cache_upload = True,
    )
    return [
        DefaultInfo(default_output = out),
        PnpmNodeModulesInfo(
            editor_inputs = descriptor,
            node_modules = out,
            toolchain_identity = toolchain.identity,
        ),
    ]


pnpm_node_modules = rule(
    impl = _pnpm_node_modules_impl,
    attrs = {
        "package_name": attrs.string(),
        "root_package_json": attrs.source(),
        "lockfile": attrs.source(),
        "workspace_manifest": attrs.source(),
        "workspace_package_manifests": attrs.dict(
            key = attrs.string(),
            value = attrs.source(),
        ),
        "patches": attrs.dict(
            key = attrs.string(),
            value = attrs.source(),
            default = {},
        ),
        "runtime": attrs.source(),
        "descriptor_module": attrs.source(),
        "normalizer": attrs.source(),
        "_materializer": attrs.default_only(attrs.exec_dep(
            default = "effect_utils//toolchains:pnpm_materializer",
            providers = [PnpmMaterializerToolchainInfo],
        )),
    },
)


def _pnpm_editor_inputs_impl(ctx):
    editor_inputs = ctx.attrs.node_modules[PnpmNodeModulesInfo].editor_inputs
    return [DefaultInfo(default_output = editor_inputs)]


pnpm_editor_inputs = rule(
    impl = _pnpm_editor_inputs_impl,
    attrs = {
        "node_modules": attrs.dep(providers = [PnpmNodeModulesInfo]),
    },
)


def _package_tree_impl(ctx):
    node_modules = ctx.attrs.node_modules[PnpmNodeModulesInfo].node_modules
    out = ctx.actions.declare_output("package_tree", dir = True)
    args = cmd_args([
        ctx.attrs._materializer[PnpmMaterializerToolchainInfo].bun,
        ctx.attrs.runtime,
        "assemble-package-tree",
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
        "node_modules": attrs.dep(providers = [PnpmNodeModulesInfo]),
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
        "runtime": attrs.source(),
        "_materializer": attrs.default_only(attrs.exec_dep(
            default = "effect_utils//toolchains:pnpm_materializer",
            providers = [PnpmMaterializerToolchainInfo],
        )),
    },
)


def package_tree(name, node_modules, files, runtime, workspace_siblings = {}, **kwargs):
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
        workspace_files = workspace_files,
        workspace_links = workspace_links,
        **kwargs
    )


def export_materialization_inputs(inputs):
    """Exports an explicit manifest-only root input set for package-local rules."""
    for source in inputs:
        native.export_file(
            name = source,
            src = source,
            visibility = ["PUBLIC"],
        )
