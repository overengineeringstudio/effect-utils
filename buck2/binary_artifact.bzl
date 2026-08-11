"""Deterministic, relocatable packaging for one Buck-built native binary.

This is intentionally a local-only bridge: Nix supplies immutable packaging
tools, Buck owns the native binary action graph, and the resulting archive and
descriptor are suitable for strict import by Nix.
"""

_NIX_BASE32 = "0123456789abcdfghijklmnpqrsvwxyz"
_NIX_NAME = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-._?="

def _configured_nix_executable(key):
    value = read_root_config("buck2_rust", key, "")
    parts = value.split("/")
    if (
        not value.startswith("/nix/store/") or
        "\n" in value or
        "\r" in value or
        len(parts) < 5 or
        parts[0] != "" or
        parts[1] != "nix" or
        parts[2] != "store" or
        any([part == "" or part == "." or part == ".." for part in parts[3:]])
    ):
        fail("buck2_rust.{} must be an executable below an immutable absolute /nix/store path".format(key))
    store_name = parts[3]
    if len(store_name) < 34 or store_name[32] != "-":
        fail("buck2_rust.{} must use a canonical Nix store root".format(key))
    if any([character not in _NIX_BASE32 for character in store_name[:32].elems()]):
        fail("buck2_rust.{} must contain a canonical Nix base32 store hash".format(key))
    if any([character not in _NIX_NAME for character in store_name[33:].elems()]):
        fail("buck2_rust.{} must contain a canonical Nix store name".format(key))
    return value

def _configured_revision():
    value = read_root_config("buck2_build", "revision", "")
    if len(value) != 40 or any([character not in "0123456789abcdef" for character in value.elems()]):
        fail("buck2_build.revision must be a full lowercase 40-character Git SHA")
    return value

def _configured_commit_timestamp():
    value = read_root_config("buck2_build", "commit_timestamp", "")
    if not value or any([character not in "0123456789" for character in value.elems()]):
        fail("buck2_build.commit_timestamp must be a non-negative integer")
    return value

def _configured_dirty():
    value = read_root_config("buck2_build", "dirty", "")
    if value not in ["true", "false"]:
        fail("buck2_build.dirty must be true or false")
    return value

def _require_local_x86_64_linux(platform):
    host = host_info()
    if platform != "x86_64-linux":
        fail("native binary artifacts currently support only x86_64-linux")
    if not host.arch.is_x86_64 or not host.os.is_linux:
        fail("native binary artifacts require a local x86_64-linux execution host")

def _single_default_output(dep):
    outputs = dep[DefaultInfo].default_outputs
    if len(outputs) != 1:
        fail("native binary artifact dependency must expose exactly one default output")
    return outputs[0]

def _native_binary_artifact_impl(ctx):
    _require_local_x86_64_linux(ctx.attrs.platform)
    source_binary = _single_default_output(ctx.attrs.binary)
    binary = ctx.actions.declare_output(ctx.attrs.binary_name)
    archive = ctx.actions.declare_output("artifact.tar")
    descriptor = ctx.actions.declare_output("descriptor.json")
    args = cmd_args([
        ctx.attrs._python,
        ctx.attrs._builder,
        "--input",
        source_binary,
        "--output",
        binary.as_output(),
        "--archive",
        archive.as_output(),
        "--descriptor",
        descriptor.as_output(),
        "--binary-name",
        ctx.attrs.binary_name,
        "--binary-target",
        str(ctx.attrs.binary.label.raw_target()),
        "--platform",
        ctx.attrs.platform,
        "--target",
        str(ctx.label.raw_target()),
        "--python",
        ctx.attrs._python,
        "--builder-source",
        ctx.attrs._builder,
        "--patchelf",
        ctx.attrs._patchelf,
        "--strip",
        ctx.attrs._strip,
        "--revision",
        ctx.attrs._revision,
        "--commit-timestamp",
        ctx.attrs._commit_timestamp,
        "--dirty",
        ctx.attrs._dirty,
    ])
    ctx.actions.run(
        args,
        env = {"PATH": "/nonexistent"},
        category = "native_binary_artifact",
        identifier = ctx.attrs.binary_name,
        local_only = True,
    )
    return [
        DefaultInfo(
            default_output = archive,
            other_outputs = [binary, descriptor],
            sub_targets = {
                "artifact": [DefaultInfo(default_output = archive)],
                "binary": [DefaultInfo(default_output = binary)],
                "descriptor": [DefaultInfo(default_output = descriptor)],
            },
        ),
        RunInfo(args = cmd_args([binary])),
    ]

_native_binary_artifact = rule(
    impl = _native_binary_artifact_impl,
    attrs = {
        "binary": attrs.dep(),
        "binary_name": attrs.string(),
        "platform": attrs.string(),
        "_builder": attrs.default_only(attrs.source(default = "//buck2/tools:native_binary_artifact_builder_source")),
        "_patchelf": attrs.default_only(attrs.string(default = _configured_nix_executable("patchelf"))),
        "_python": attrs.default_only(attrs.string(default = _configured_nix_executable("python"))),
        "_strip": attrs.default_only(attrs.string(default = _configured_nix_executable("strip"))),
        "_revision": attrs.default_only(attrs.string(default = _configured_revision())),
        "_commit_timestamp": attrs.default_only(attrs.string(default = _configured_commit_timestamp())),
        "_dirty": attrs.default_only(attrs.string(default = _configured_dirty())),
    },
)

def native_binary_artifact(name, binary, binary_name, platform = "x86_64-linux", visibility = None):
    """Package one native binary as a deterministic, store-independent Nix input."""
    _native_binary_artifact(
        name = name,
        binary = binary,
        binary_name = binary_name,
        platform = platform,
        visibility = visibility,
    )
