"""Exact dependency-closure artifacts and strict staged projections.

The manifest is a generated, reviewable projection. Package artifacts remain
the build graph authority: every manifest member must have one exact Buck edge,
and every Buck edge must occur in the manifest.
"""

PackageArtifactInfo = provider(fields = [
    "artifact",
    "id",
    "projection_path",
    "sha256",
])

ClosureManifestInfo = provider(fields = [
    "artifact",
    "package_ids",
])

ClosureProjectionInfo = provider(fields = [
    "manifest",
    "package_ids",
    "tree",
])

def _validate_identifier(value, field):
    if not value:
        fail("{} must not be empty".format(field))
    if "\n" in value or "\r" in value or "\x00" in value:
        fail("{} contains a forbidden control character: {!r}".format(field, value))

def _validate_projection_path(value):
    _validate_identifier(value, "projection_path")
    if value.startswith("/"):
        fail("projection_path must be relative: {!r}".format(value))
    for component in value.split("/"):
        if component == "" or component == "." or component == "..":
            fail("projection_path is not normalized: {!r}".format(value))
    if value == "closure-manifest.json" or value.startswith("closure-manifest.json/"):
        fail("projection_path collides with reserved metadata path: {!r}".format(value))

def _validate_sha256(value):
    if len(value) != 64:
        fail("sha256 must contain exactly 64 lowercase hexadecimal characters")
    for character in value.elems():
        if character not in "0123456789abcdef":
            fail("sha256 must contain exactly 64 lowercase hexadecimal characters")

def _package_artifact_impl(ctx):
    _validate_identifier(ctx.attrs.id, "id")
    _validate_projection_path(ctx.attrs.projection_path)
    _validate_sha256(ctx.attrs.sha256)
    return [
        DefaultInfo(default_output = ctx.attrs.src),
        PackageArtifactInfo(
            artifact = ctx.attrs.src,
            id = ctx.attrs.id,
            projection_path = ctx.attrs.projection_path,
            sha256 = ctx.attrs.sha256,
        ),
    ]

package_artifact = rule(
    impl = _package_artifact_impl,
    attrs = {
        "id": attrs.string(),
        "projection_path": attrs.string(),
        "sha256": attrs.string(),
        # attrs.source accepts either a checked-in source or another target's
        # default output, which is the generated-package consumption hook.
        "src": attrs.source(),
    },
)

def _collect_packages(deps):
    packages = []
    ids = {}
    paths = {}
    ordered_paths = []
    previous_id = None
    for dep in deps:
        package = dep[PackageArtifactInfo]
        if package.id in ids:
            fail("duplicate package id: {}".format(package.id))
        if package.projection_path in paths:
            fail("duplicate package projection_path: {}".format(package.projection_path))
        for prior_path in ordered_paths:
            if package.projection_path.startswith(prior_path + "/") or prior_path.startswith(package.projection_path + "/"):
                fail("package projection_path file/ancestor collision: {} and {}".format(prior_path, package.projection_path))
        if previous_id != None and package.id <= previous_id:
            fail("packages must be declared in strictly increasing id order: {} then {}".format(previous_id, package.id))
        ids[package.id] = True
        paths[package.projection_path] = True
        ordered_paths.append(package.projection_path)
        previous_id = package.id
        packages.append(package)
    return packages

def _closure_manifest_impl(ctx):
    packages = _collect_packages(ctx.attrs.packages)
    out = ctx.actions.declare_output("closure-manifest.json")
    entries = []
    package_ids = []
    for package in packages:
        entries.append({
            "id": package.id,
            "projectionPath": package.projection_path,
            "sha256": package.sha256,
        })
        package_ids.append(package.id)
    ctx.actions.write_json(out, {
        "packages": entries,
        "schemaVersion": 1,
    }, pretty = True)
    return [
        DefaultInfo(default_output = out),
        ClosureManifestInfo(artifact = out, package_ids = package_ids),
    ]

closure_manifest = rule(
    impl = _closure_manifest_impl,
    attrs = {
        "packages": attrs.list(attrs.dep(providers = [PackageArtifactInfo])),
    },
)

def _strict_closure_projection_impl(ctx):
    packages = _collect_packages(ctx.attrs.packages)
    out = ctx.actions.declare_output("closure", dir = True)
    args = cmd_args([
        ctx.attrs._tool[RunInfo],
        "stage",
        "--manifest",
        ctx.attrs.manifest,
        "--out",
        out.as_output(),
    ])
    package_ids = []
    for package in packages:
        args.add("--package-id", package.id)
        args.add("--projection-path", package.projection_path)
        args.add("--sha256", package.sha256)
        args.add("--artifact", package.artifact)
        package_ids.append(package.id)
    ctx.actions.run(
        args,
        env = {"PATH": "/nonexistent"},
        category = "buck2_closure_stage",
        identifier = "strict",
    )
    return [
        DefaultInfo(default_output = out),
        ClosureProjectionInfo(
            manifest = ctx.attrs.manifest,
            package_ids = package_ids,
            tree = out,
        ),
    ]

strict_closure_projection = rule(
    impl = _strict_closure_projection_impl,
    attrs = {
        # This source may be a Genie output, closure_manifest output, or pinned
        # checked-in projection. The rule does not infer ambient dependencies.
        "manifest": attrs.source(),
        "packages": attrs.list(attrs.dep(providers = [PackageArtifactInfo])),
        "_tool": attrs.default_only(attrs.exec_dep(
            default = "//buck2/tools:closure_tool",
            providers = [RunInfo],
        )),
    },
)

def exact_dependency_closure(name, packages, visibility = None):
    """Generate and consume one canonical manifest from the same exact edges."""
    manifest_name = name + "__manifest"
    closure_manifest(
        name = manifest_name,
        packages = packages,
        visibility = [],
    )
    strict_closure_projection(
        name = name,
        manifest = ":" + manifest_name,
        packages = packages,
        visibility = visibility,
    )

def _closure_probe_impl(ctx):
    closure = ctx.attrs.closure[ClosureProjectionInfo]
    out = ctx.actions.declare_output("closure-evidence.json")
    ctx.actions.run(
        cmd_args([
            ctx.attrs._tool[RunInfo],
            "probe",
            "--tree",
            closure.tree,
            "--source",
            ctx.attrs.source,
            "--out",
            out.as_output(),
        ]),
        env = {"PATH": "/nonexistent"},
        category = "buck2_closure_probe",
        identifier = "evidence",
    )
    return [DefaultInfo(default_output = out)]

closure_probe = rule(
    impl = _closure_probe_impl,
    attrs = {
        "closure": attrs.dep(providers = [ClosureProjectionInfo]),
        "source": attrs.source(),
        "_tool": attrs.default_only(attrs.exec_dep(
            default = "//buck2/tools:closure_tool",
            providers = [RunInfo],
        )),
    },
)
