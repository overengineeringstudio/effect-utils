"""Crate archives for non-vendored Reindeer graphs.

Reindeer emits one `crate_archive` per registry crate (`[buck] http_archive =
"crate_archive"`). A normal build downloads it exactly like `http_archive`,
pinned by the `Cargo.lock` sha256. A sandboxed Nix build has no network: it
sets `nix_store.crates_root` to a Nix store tree of `<sha256>.tgz` fixed-output
fetches (`nix/workspace-tools/lib/buck2-cargo-archives.nix`), and the archive is
copied from there, re-verified, and extracted offline by the capability tool.
"""

load("//buck2/toolchains:defs.bzl", "BunToolchainInfo")

def _nix_crate_archive_impl(ctx):
    root = read_config("nix_store", "crates_root", "")
    if not root.startswith("/nix/store/"):
        fail("nix_store.crates_root must be an immutable Nix store path: {}".format(root))
    archive = ctx.actions.declare_output("archive.crate")
    ctx.actions.run(
        cmd_args([
            ctx.attrs._bun[BunToolchainInfo].executable,
            ctx.attrs._nix_archive,
            "--root",
            root,
            "--sha256",
            ctx.attrs.sha256,
            "--output",
            archive.as_output(),
        ]),
        category = "cargo_nix_archive",
        identifier = ctx.label.name,
        local_only = True,
        allow_cache_upload = True,
    )
    out = ctx.actions.declare_output(ctx.label.name, dir = True)
    ctx.actions.run(
        cmd_args([
            ctx.attrs._archive_tool[RunInfo],
            "extract-crate",
            "--archive",
            archive,
            "--out",
            out.as_output(),
            "--strip-prefix",
            ctx.attrs.strip_prefix,
        ]),
        category = "cargo_extract",
        identifier = ctx.label.name,
        allow_cache_upload = True,
    )
    return [DefaultInfo(default_output = out)]

_nix_crate_archive = rule(
    impl = _nix_crate_archive_impl,
    attrs = {
        "sha256": attrs.string(),
        "strip_prefix": attrs.string(),
        "_archive_tool": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:archive_tool",
            providers = [RunInfo],
        )),
        "_bun": attrs.default_only(attrs.exec_dep(
            default = "//buck2/toolchains:bun",
            providers = [BunToolchainInfo],
        )),
        "_nix_archive": attrs.default_only(attrs.source(
            default = "//buck2/dependencies:nix-archive.ts",
        )),
    },
)

def crate_archive(name, urls, sha256, strip_prefix, visibility = [], **kwargs):
    """Declares one sha256-pinned registry crate, acquired offline under Nix."""
    if len(sha256) != 64 or sha256.lower() != sha256:
        fail("crate_archive {} needs a lowercase hex sha256".format(name))
    if read_config("nix_store", "crates_root", "") == "":
        native.http_archive(
            name = name,
            urls = urls,
            sha256 = sha256,
            strip_prefix = strip_prefix,
            visibility = visibility,
            **kwargs
        )
    else:
        _nix_crate_archive(
            name = name,
            sha256 = sha256,
            strip_prefix = strip_prefix,
            visibility = visibility,
        )
