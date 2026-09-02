"""Lockfile-derived pnpm closure rules (decision 0022).

Generated-data API
------------------
A translator calls ``pnpm_platform_configurations()`` once in its generated
package, then declares:

* ``pnpm_package(name, package_name, url, sha256, bins = {}, patches = [])`` once per
  resolved package version. ``sha256`` is the lowercase hex value from the
  freshness-gated sidecar; the rule performs the only network action and the
  capability-backed archive tool extracts the npm ``package/`` tree offline.
* ``pnpm_importer(name, *_by_platform, ...)`` once per importer. Every
  package-bearing map has exactly the keys ``linux_x86_64``, ``linux_aarch64``,
  and ``macos_aarch64``. The macro owns the mandatory cpu/os ``select()``.

``packages_by_platform`` maps each snapshot's pnpm-encoded, single-component
virtual-store key (including its peer identity) to a ``pnpm_package`` target.
Metadata maps use these records:

* packageDependencies: ``"<source-key>\\t<dependency-name>" -> <target-key>``
* rootDependencies: ``<dependency-name> -> <target-key>``
* bins: ``<bin-name> -> "<target-key>\\t<package-relative-entrypoint>"``
* packageWorkspaceDependencies: ``"<package-key>\\t<name>" -> <workspace-key>``
* workspacePackageDependencies: ``"<workspace-key>\\t<name>" -> <package-key>``

Each package's ``bins`` maps its executable names to package-relative files.
The selected dependency edges derive the nested package/workspace ``.bin``
links; ``bins_by_platform`` declares only the importer's root ``.bin`` links.

``workspace_trees`` maps a stable, single-component workspace key to a declared
package-tree artifact. ``workspace_workspace_dependencies`` uses
``"<source-workspace-key>\\t<name>" -> <target-workspace-key>``;
``root_workspace_dependencies`` maps root names to workspace keys. Assembly is
an offline action and never reads a package-manager store.
"""

load("//buck2/toolchains:defs.bzl", "BunToolchainInfo")

PnpmPackageInfo = provider(fields = {
    "bins": provider_field(dict[str, str]),
    "package_name": str,
    "tree": Artifact,
})

PnpmDeclaredClosureInfo = provider(fields = {
    "manifest": Artifact,
    "node_modules": Artifact,
    "toolchain_identity": str,
})

_PLATFORMS = ["linux_aarch64", "linux_x86_64", "macos_aarch64"]
_PLATFORM_CONFIGURATIONS = {
    "linux_x86_64": ":_pnpm_linux_x86_64",
    "linux_aarch64": ":_pnpm_linux_aarch64",
    "macos_aarch64": ":_pnpm_macos_aarch64",
}


def _require_sha256(value):
    if len(value) != 64:
        fail("pnpm package sha256 must contain exactly 64 lowercase hex digits")
    for character in value.elems():
        if character not in "0123456789abcdef":
            fail("pnpm package sha256 must contain exactly 64 lowercase hex digits")

def _require_url(value):
    if not value.startswith("https://"):
        fail("pnpm package URL must use https: {}".format(value))


def _require_portable_path(value, field):
    if not value or value.startswith("/") or "\\" in value or "\x00" in value:
        fail("{} must be a non-empty portable relative path: {}".format(field, value))
    for component in value.split("/"):
        if component == "" or component == "." or component == "..":
            fail("{} must be normalized: {}".format(field, value))


def _require_store_key(value, field):
    _require_portable_path(value, field)
    if "/" in value:
        fail("{} must be one virtual-store path component: {}".format(field, value))


def _record(value, field):
    parts = value.split("\t")
    if len(parts) != 2:
        fail("{} must use the owner\\tname record encoding: {}".format(field, value))
    _require_store_key(parts[0], "{} owner".format(field))
    _require_portable_path(parts[1], "{} name".format(field))
    return parts


def _fetch_impl(ctx):
    _require_sha256(ctx.attrs.sha256)
    _require_url(ctx.attrs.url)
    out = ctx.actions.download_file(
        "package.tgz",
        ctx.attrs.url,
        sha256 = ctx.attrs.sha256,
    )
    return [DefaultInfo(default_output = out)]


_fetch = rule(
    impl = _fetch_impl,
    attrs = {
        "sha256": attrs.string(),
        "url": attrs.string(),
    },
)


def _extract_impl(ctx):
    out = ctx.actions.declare_output("package", dir = True)
    strip_prefix = "package"
    if ctx.attrs.package_name.startswith("@types/"):
        strip_prefix = ctx.attrs.package_name.split("/")[-1]
    args = cmd_args([
        ctx.attrs._archive_tool[RunInfo],
        "extract-npm",
        "--archive",
        ctx.attrs.archive,
        "--out",
        out.as_output(),
        "--strip-prefix",
        strip_prefix,
    ])
    for patch in ctx.attrs.patches:
        args.add("--patch", patch)
    ctx.actions.run(
        args,
        category = "pnpm_extract",
        identifier = ctx.attrs.name,
        allow_cache_upload = True,
    )
    for name, entrypoint in ctx.attrs.bins.items():
        _require_portable_path(name, "package bin name")
        _require_portable_path(entrypoint, "package bin entrypoint")
    return [
        DefaultInfo(default_output = out),
        PnpmPackageInfo(bins = ctx.attrs.bins, package_name = ctx.attrs.package_name, tree = out),
    ]


_extract = rule(
    impl = _extract_impl,
    attrs = {
        "archive": attrs.source(),
        "bins": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "package_name": attrs.string(),
        "patches": attrs.list(attrs.source(), default = []),
        "_archive_tool": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:archive_tool",
            providers = [RunInfo],
        )),
    },
)


def pnpm_package(name, package_name, url, sha256, bins = {}, patches = [], **kwargs):
    """Declares one hash-pinned fetch and one offline npm extraction target."""
    _require_url(url)
    _require_portable_path(package_name, "package_name")
    _require_sha256(sha256)
    fetch_name = "{}__fetch".format(name)
    _fetch(
        name = fetch_name,
        sha256 = sha256,
        url = url,
        visibility = [],
    )
    _extract(
        name = name,
        archive = ":{}".format(fetch_name),
        bins = bins,
        package_name = package_name,
        patches = patches,
        **kwargs
    )


def _validate_package_map(packages):
    for key, dep in packages.items():
        _require_store_key(key, "package snapshot key")
        _require_portable_path(dep[PnpmPackageInfo].package_name, "package name")
        for name, entrypoint in dep[PnpmPackageInfo].bins.items():
            _require_portable_path(name, "package bin name")
            _require_portable_path(entrypoint, "package bin entrypoint")


def _validate_metadata(ctx):
    packages = ctx.attrs.packages
    workspaces = ctx.attrs.workspace_trees
    _validate_package_map(packages)
    for key in workspaces.keys():
        _require_store_key(key, "workspace key")

    for record, target in ctx.attrs.package_dependencies.items():
        source, _name = _record(record, "package_dependencies")
        if source not in packages or target not in packages:
            fail("package_dependencies record names a package excluded by the selected platform: {} -> {}".format(record, target))
    for name, target in ctx.attrs.root_dependencies.items():
        _require_portable_path(name, "root dependency")
        if target not in packages:
            fail("root_dependencies names a package excluded by the selected platform: {}".format(target))
    for name, value in ctx.attrs.bins.items():
        _require_portable_path(name, "bin name")
        target, entrypoint = _record(value, "bins")
        if target not in packages:
            fail("bins names a package excluded by the selected platform: {}".format(target))
        _require_portable_path(entrypoint, "bin entrypoint")
    for record, target in ctx.attrs.package_workspace_dependencies.items():
        source, _name = _record(record, "package_workspace_dependencies")
        if source not in packages or target not in workspaces:
            fail("package_workspace_dependencies has an unavailable endpoint: {} -> {}".format(record, target))
    for record, target in ctx.attrs.workspace_package_dependencies.items():
        source, _name = _record(record, "workspace_package_dependencies")
        if source not in workspaces or target not in packages:
            fail("workspace_package_dependencies has an unavailable endpoint: {} -> {}".format(record, target))
    for record, target in ctx.attrs.workspace_workspace_dependencies.items():
        source, _name = _record(record, "workspace_workspace_dependencies")
        if source not in workspaces or target not in workspaces:
            fail("workspace_workspace_dependencies has an unavailable endpoint: {} -> {}".format(record, target))
    for name, target in ctx.attrs.root_workspace_dependencies.items():
        _require_portable_path(name, "root workspace dependency")
        if target not in workspaces:
            fail("root_workspace_dependencies names unavailable workspace {}".format(target))

def _nested_bins(packages, dependencies, field):
    result = {}
    for record, target in dependencies.items():
        owner, _dependency_name = _record(record, field)
        package = packages[target][PnpmPackageInfo]
        for name, entrypoint in package.bins.items():
            key = "{}\t{}".format(owner, name)
            value = "{}\t{}".format(target, entrypoint)
            existing = result.get(key)
            if existing != None and existing != value:
                fail("{} exposes ambiguous bin {} from {} and {}".format(field, key, existing, value))
            result[key] = value
    return result


def _importer_impl(ctx):
    _validate_metadata(ctx)
    package_bins = _nested_bins(ctx.attrs.packages, ctx.attrs.package_dependencies, "package_dependencies")
    workspace_bins = _nested_bins(ctx.attrs.packages, ctx.attrs.workspace_package_dependencies, "workspace_package_dependencies")
    manifest = ctx.actions.declare_output("assembly-manifest.json")
    ctx.actions.write_json(manifest, {
        "schema": "effect-utils/pnpm-declared-closure/v1",
        "packageDependencies": ctx.attrs.package_dependencies,
        "packageBins": package_bins,
        "rootDependencies": ctx.attrs.root_dependencies,
        "bins": ctx.attrs.bins,
        "packageWorkspaceDependencies": ctx.attrs.package_workspace_dependencies,
        "workspacePackageDependencies": ctx.attrs.workspace_package_dependencies,
        "workspaceWorkspaceDependencies": ctx.attrs.workspace_workspace_dependencies,
        "workspaceBins": workspace_bins,
        "rootWorkspaceDependencies": ctx.attrs.root_workspace_dependencies,
    }, pretty = True)

    out = ctx.actions.declare_output("node_modules", dir = True)
    toolchain = ctx.attrs._bun[BunToolchainInfo]
    args = cmd_args([
        toolchain.executable,
        ctx.attrs.runtime,
        "--output",
        out.as_output(),
        "--manifest",
        manifest,
    ])
    for key in sorted(ctx.attrs.packages.keys()):
        package = ctx.attrs.packages[key][PnpmPackageInfo]
        args.add("--package", key, package.package_name, package.tree)
    for key in sorted(ctx.attrs.workspace_trees.keys()):
        args.add("--workspace", key, ctx.attrs.workspace_trees[key])
    ctx.actions.run(
        args,
        category = "pnpm_importer",
        identifier = ctx.attrs.name,
        local_only = True,
        allow_cache_upload = True,
    )
    return [
        DefaultInfo(default_output = out, other_outputs = [manifest]),
        PnpmDeclaredClosureInfo(
            manifest = manifest,
            node_modules = out,
            toolchain_identity = toolchain.identity,
        ),
    ]


_importer = rule(
    impl = _importer_impl,
    attrs = {
        "packages": attrs.dict(key = attrs.string(), value = attrs.dep(providers = [PnpmPackageInfo])),
        "package_dependencies": attrs.dict(key = attrs.string(), value = attrs.string()),
        "root_dependencies": attrs.dict(key = attrs.string(), value = attrs.string()),
        "bins": attrs.dict(key = attrs.string(), value = attrs.string()),
        "workspace_trees": attrs.dict(key = attrs.string(), value = attrs.source(), default = {}),
        "package_workspace_dependencies": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "workspace_package_dependencies": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "workspace_workspace_dependencies": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "root_workspace_dependencies": attrs.dict(key = attrs.string(), value = attrs.string(), default = {}),
        "runtime": attrs.source(),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:bun",
            providers = [BunToolchainInfo],
        )),
    },
)


def pnpm_platform_configurations():
    """Declares the three cpu/os config settings owned by pnpm_importer selects."""
    native.config_setting(
        name = "_pnpm_linux_x86_64",
        constraint_values = [
            "prelude//cpu/constraints:x86_64",
            "prelude//os/constraints:linux",
        ],
        visibility = [],
    )
    native.config_setting(
        name = "_pnpm_linux_aarch64",
        constraint_values = [
            "prelude//cpu/constraints:arm64",
            "prelude//os/constraints:linux",
        ],
        visibility = [],
    )
    native.config_setting(
        name = "_pnpm_macos_aarch64",
        constraint_values = [
            "prelude//cpu/constraints:arm64",
            "prelude//os/constraints:macos",
        ],
        visibility = [],
    )


def _empty_platform_maps():
    return {platform: {} for platform in _PLATFORMS}


def _platform_select(values, field):
    if sorted(values.keys()) != _PLATFORMS:
        fail("{} must provide exactly these admitted platforms: {}".format(field, ", ".join(_PLATFORMS)))
    return select({_PLATFORM_CONFIGURATIONS[platform]: values[platform] for platform in _PLATFORMS})


def pnpm_importer(
        name,
        runtime,
        packages_by_platform,
        package_dependencies_by_platform,
        root_dependencies_by_platform,
        bins_by_platform,
        workspace_trees = {},
        package_workspace_dependencies_by_platform = None,
        workspace_package_dependencies_by_platform = None,
        workspace_workspace_dependencies = {},
        root_workspace_dependencies = {},
        **kwargs):
    """Assembles one importer; package-bearing inputs are always cpu/os selected."""
    _importer(
        name = name,
        runtime = runtime,
        packages = _platform_select(packages_by_platform, "packages_by_platform"),
        package_dependencies = _platform_select(package_dependencies_by_platform, "package_dependencies_by_platform"),
        root_dependencies = _platform_select(root_dependencies_by_platform, "root_dependencies_by_platform"),
        bins = _platform_select(bins_by_platform, "bins_by_platform"),
        workspace_trees = workspace_trees,
        package_workspace_dependencies = _platform_select(
            package_workspace_dependencies_by_platform if package_workspace_dependencies_by_platform != None else _empty_platform_maps(),
            "package_workspace_dependencies_by_platform",
        ),
        workspace_package_dependencies = _platform_select(
            workspace_package_dependencies_by_platform if workspace_package_dependencies_by_platform != None else _empty_platform_maps(),
            "workspace_package_dependencies_by_platform",
        ),
        workspace_workspace_dependencies = workspace_workspace_dependencies,
        root_workspace_dependencies = root_workspace_dependencies,
        **kwargs
    )
