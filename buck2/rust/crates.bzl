"""Crate archives for non-vendored Reindeer graphs.

Reindeer emits one `crate_archive` per registry crate (`[buck] http_archive =
"crate_archive"`). A normal build downloads it exactly like `http_archive`,
pinned by the `Cargo.lock` sha256. A sandboxed Nix build has no network: it
sets `nix_store.crates_root` to a Nix store tree of `<sha256>.tgz` archives
(`nix/workspace-tools/lib/buck2-cargo-archives.nix`), which are copied,
verified, and extracted offline by the capability tool.

Git dependencies take the same path. Reindeer emits `git_fetch(name, repo, rev)`
without a digest; selecting `[buck] git_fetch = "git_archive"` routes them to
`pinned_git_archive`, which resolves `(repo, rev)` in the workspace's committed
`git-archives.json` sidecar. Ordinary GitHub commit tarballs use the reviewed
sha256; declared Nix flake sources carry a source-derived archive digest:
    [buck]
    git_fetch = "git_archive"
    buckfile_imports = '''
    load("//buck2/rust:crates.bzl", "crate_archive", "pinned_git_archive")
    load(":git-archives.json", git_archive_pins = "value")
    git_archive = pinned_git_archive(git_archive_pins)
    '''
"""

load("//buck2/platforms:defs.bzl", "cache_guarded_rule")
load("//buck2/toolchains:defs.bzl", "BunToolchainInfo")

def _nix_crate_archive_impl(ctx):
    root = read_config("nix_store", "crates_root", "")
    if not root.startswith("/nix/store/"):
        fail("nix_store.crates_root must be an immutable Nix store path: {}".format(root))
    archive = ctx.actions.declare_output("archive.crate")
    command = [
        ctx.attrs._bun[BunToolchainInfo].executable,
        ctx.attrs._nix_archive,
        "--root",
        root,
        "--sha256",
        ctx.attrs.sha256,
        "--output",
        archive.as_output(),
    ]
    if ctx.attrs.source_repo != None:
        command.extend(["--source-repo", ctx.attrs.source_repo, "--source-rev", ctx.attrs.source_rev])
    ctx.actions.run(
        cmd_args(command),
        category = "cargo_nix_archive",
        identifier = ctx.label.name,
        local_only = True,
        allow_cache_upload = True,
    )
    out = ctx.actions.declare_output(ctx.attrs.out or ctx.label.name, dir = True)
    ctx.actions.run(
        cmd_args([
            ctx.attrs._archive_tool[RunInfo],
            ctx.attrs.extract_command,
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
    return [DefaultInfo(
        default_output = out,
        sub_targets = {
            path: [DefaultInfo(default_output = out.project(path))]
            for path in ctx.attrs.sub_targets
        },
    )]

_nix_crate_archive = cache_guarded_rule(
    impl = _nix_crate_archive_impl,
    attrs = {
        "extract_command": attrs.enum(["extract-crate", "extract-git-archive"], default = "extract-crate"),
        "out": attrs.option(attrs.string(), default = None),
        "sha256": attrs.string(),
        "strip_prefix": attrs.string(),
        "source_repo": attrs.option(attrs.string(), default = None),
        "source_rev": attrs.option(attrs.string(), default = None),
        "sub_targets": attrs.list(attrs.string(), default = []),
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

def _github_repository(repo):
    prefix = "https://github.com/"
    if not repo.startswith(prefix):
        fail("git_archive supports only https://github.com repositories: {}".format(repo))
    path = repo[len(prefix):].removesuffix(".git").removesuffix("/")
    parts = path.split("/")
    if len(parts) != 2 or parts[0] == "" or parts[1] == "":
        fail("git_archive needs a https://github.com/<owner>/<repo> URL: {}".format(repo))
    return path.lower()

def pinned_git_archive(pins):
    """Binds a workspace's `git-archives.json` pins into Reindeer's `git_fetch` rule slot."""
    if type(pins) != "dict" or pins.get("schema") != "effect-utils/buck2-git-archives/v1":
        fail("git-archives.json must carry schema effect-utils/buck2-git-archives/v1")
    by_source = {}
    for pin in pins.get("archives", []):
        by_source[(_github_repository(pin["repo"]), pin["rev"])] = pin

    def git_archive(name, repo, rev, sub_targets = [], visibility = [], **kwargs):
        """One commit of a GitHub repository, pinned by its tarball sha256."""
        pin = by_source.get((_github_repository(repo), rev))
        if pin == None:
            fail("git_archive {}: {}@{} has no git-archives.json pin (run the buck2:rust-deps generate task)".format(name, repo, rev))
        sha256 = pin["sha256"]
        if len(sha256) != 64 or sha256.lower() != sha256:
            fail("git_archive {} needs a lowercase hex sha256".format(name))
        source_kind = pin.get("source", "github")
        if source_kind not in ("github", "nix"):
            fail("git_archive {} has unknown source type {}".format(name, source_kind))

        # Reindeer addresses the checkout as `<name without .git>/<path in repo>`.
        out = name.removesuffix(".git")
        if source_kind == "nix" and read_config("nix_store", "crates_root", "") == "":
            fail("git_archive {}: {}@{} needs nix_store.crates_root for its pinned Nix source archive".format(name, repo, rev))
        if read_config("nix_store", "crates_root", "") == "":
            native.http_archive(
                name = name,
                urls = [pin["url"]],
                sha256 = sha256,
                strip_prefix = pin["strip_prefix"],
                type = "tar.gz",
                out = out,
                sub_targets = sub_targets,
                visibility = visibility,
                **kwargs
            )
        else:
            _nix_crate_archive(
                name = name,
                extract_command = "extract-git-archive",
                out = out,
                sha256 = sha256,
                source_repo = repo,
                source_rev = rev,
                strip_prefix = pin["strip_prefix"],
                sub_targets = sub_targets,
                visibility = visibility,
            )

    return git_archive
