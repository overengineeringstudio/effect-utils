"""Content-addressed Go module supply and a vendored-mode Go binary rule.

Two decisions are baked in here.

**Supply.** Third-party Go code arrives exactly the way decision 0023 admits every
other external source: one `http_archive` per module version over the immutable
`<proxy>/<module>/@v/<version>.zip`, pinned by `sha256`. There is no `vendorHash`
fixed-output derivation, no `go mod download` in a build action, and no network in
any action. The pin table is generated (see
`go/third-party/external-go-modules.bzl.genie.ts`) and freshness-gated against
`go.mod`/`go.sum`, which are the single declared pin set.

**Assembly.** The archives are assembled into a `vendor/` tree next to the
first-party sources and compiled with a single `go build -mod=vendor`. That is
deliberately *not* prelude's per-package `go_library`/`go_binary` graph: those
rules require `GOROOT` as a Buck `Artifact` (`prelude//go:go_stdlib.bzl`'s
`goroot: dynattrs.value(Artifact)`), which for a Nix-realized Go distribution
means copying a 250 MB store path into `buck-out` before anything compiles. See
`buck2/toolchains/defs.bzl:nix_go_toolchain` for the prelude-native toolchain,
which is provided for members that want that graph.
"""

load("@prelude//:paths.bzl", "paths")
load("@prelude//go_bootstrap:go_bootstrap.bzl", "GoBootstrapToolchainInfo")

def go_module_archives(pins, input_digest, visibility = ["PUBLIC"]):
    """Declares one `http_archive` per pinned Go module version.

    `strip_prefix` removes the `<module>@<version>/` directory the module-zip
    format mandates, so each archive's output *is* the module root and can be
    dropped straight into `vendor/<module path>`.
    """
    if not input_digest.startswith("sha256:"):
        fail("go_module_archives: pin table carries no input digest")
    for pin in pins:
        native.http_archive(
            name = _archive_name(pin["path"], pin["version"]),
            urls = [pin["url"]],
            sha256 = pin["sha256"],
            type = "zip",
            strip_prefix = "{}@{}".format(pin["path"], pin["version"]),
            visibility = visibility,
        )

def go_vendor_map(pins, package):
    """Maps module import path -> archive target label, for `go_vendored_binary`."""
    return {
        pin["path"]: "{}:{}".format(package, _archive_name(pin["path"], pin["version"]))
        for pin in pins
    }

def _archive_name(path, version):
    return "{}@{}".format(path, version).replace("/", "_")

def _go_vendored_binary_impl(ctx: AnalysisContext) -> list[Provider]:
    toolchain = ctx.attrs._go_bootstrap_toolchain[GoBootstrapToolchainInfo]

    # The build tree the action sees: first-party package sources at the module
    # root, the generated `vendor/modules.txt`, and one entry per module archive.
    # A Buck action sees only declared inputs, so a module missing from the pin
    # table fails closed at compile time rather than reaching for a module cache.
    tree = {}
    for src in ctx.attrs.srcs:
        # Source `short_path`s are already package-relative; `package_root` only
        # matters when the Go module root is a subdirectory of the Buck package.
        if ctx.attrs.package_root == None:
            tree[src.short_path] = src
        else:
            tree[paths.relativize(src.short_path, ctx.attrs.package_root)] = src
    tree["go.mod"] = ctx.attrs.go_mod
    tree["go.sum"] = ctx.attrs.go_sum
    tree["vendor/modules.txt"] = ctx.attrs.modules_txt
    for import_path, dep in ctx.attrs.vendor.items():
        outputs = dep[DefaultInfo].default_outputs
        if len(outputs) != 1:
            fail("go_vendored_binary: vendor entry {} must produce exactly one directory".format(import_path))
        tree["vendor/" + import_path] = outputs[0]

    srcs_dir = ctx.actions.copied_dir("__go_module__", tree)

    output = ctx.actions.declare_output(ctx.attrs.binary_name or ctx.label.name)

    build_flags = ["-mod=vendor", "-trimpath"]
    if ctx.attrs.tags:
        build_flags += ["-tags", ",".join(ctx.attrs.tags)]
    if ctx.attrs.ldflags:
        build_flags += ["-ldflags", " ".join(ctx.attrs.ldflags)]

    ctx.actions.run(
        cmd_args([
            toolchain.go_wrapper,
            toolchain.go,
            ["--workdir", srcs_dir],
            "--",
            "build",
            build_flags,
            ["-o", cmd_args(output.as_output(), relative_to = srcs_dir)],
            ctx.attrs.package,
        ]),
        env = {
            # No cgo: the product is a self-contained static ELF, which is the
            # `elf-static/v1` runtime contract's easy case and needs no C toolchain.
            "CGO_ENABLED": "0",
            "GO111MODULE": "on",
            # Vendor mode plus a dead proxy: if anything tries to resolve a module
            # from the network the action fails instead of succeeding impurely.
            "GOFLAGS": "-mod=vendor",
            "GONOSUMCHECK": "1",
            "GOPROXY": "off",
            "GOSUMDB": "off",
            "GOARCH": toolchain.env_go_arch,
            "GOOS": toolchain.env_go_os,
            # Never let `go` download a different toolchain for a newer `go` directive.
            "GOTOOLCHAIN": "local",
        },
        category = "go_vendored_binary",
        identifier = ctx.label.name,
        # GOCACHE lives in BUCK_SCRATCH_PATH (prelude's `go_wrapper.py` sets it),
        # so the compile cache is per-action and never leaks between builds.
        allow_cache_upload = True,
    )

    return [
        DefaultInfo(default_output = output),
        RunInfo(args = [output]),
    ]

go_vendored_binary = rule(
    impl = _go_vendored_binary_impl,
    attrs = {
        "binary_name": attrs.option(attrs.string(), default = None),
        "go_mod": attrs.source(),
        "go_sum": attrs.source(),
        "ldflags": attrs.list(attrs.string(), default = []),
        "modules_txt": attrs.source(),
        "package": attrs.string(default = "."),
        "package_root": attrs.option(attrs.string(), default = None),
        "srcs": attrs.list(attrs.source(), default = []),
        "tags": attrs.list(attrs.string(), default = []),
        "vendor": attrs.dict(attrs.string(), attrs.dep(), default = {}),
        "_go_bootstrap_toolchain": attrs.toolchain_dep(
            default = "toolchains//:go_bootstrap",
            providers = [GoBootstrapToolchainInfo],
        ),
    },
)
