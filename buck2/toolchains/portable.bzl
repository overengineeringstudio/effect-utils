"""Portable Nix-exported toolchain archive identities for local Buck actions.

Consumers must remain local_only until a configured execution-platform
constraint replaces the host_info binding. Provider construction alone cannot
constrain a downstream action's executor.
"""

PortableToolchainInfo = provider(fields = [
    "archive",
    "archive_sha256",
    "descriptor",
    "descriptor_sha256",
    "entrypoint",
    "expected_platform",
    "tree",
])

_CONTROL_CHARACTERS = "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f\x7f"

def _validate_entrypoint(value):
    if not value:
        fail("entrypoint must not be empty")
    for character in value.elems():
        if character in _CONTROL_CHARACTERS:
            fail("entrypoint must not contain control characters")
    if value.startswith("/") or "\\" in value:
        fail("entrypoint must be a portable normalized relative path")
    for component in value.split("/"):
        if component == "" or component == "." or component == "..":
            fail("entrypoint must be a portable normalized relative path")

def _validate_sha256(value, field):
    if len(value) != 64:
        fail("{} must contain 64 lowercase hexadecimal characters".format(field))
    for character in value.elems():
        if character not in "0123456789abcdef":
            fail("{} must contain 64 lowercase hexadecimal characters".format(field))

def _validate_platform(value):
    if not value:
        fail("expected_platform must not be empty")
    for character in value.elems():
        if character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._+-":
            fail("expected_platform must be a portable platform identifier")

def _local_host_platform():
    """Return the Nix system identity for this explicitly local-only lane."""
    info = host_info()
    if info.arch.is_x86_64:
        architecture = "x86_64"
    elif info.arch.is_aarch64:
        architecture = "aarch64"
    else:
        fail("portable_toolchain does not support this local host architecture")
    if info.os.is_linux:
        operating_system = "linux"
    elif info.os.is_macos:
        operating_system = "darwin"
    else:
        fail("portable_toolchain does not support this local host operating system")
    return architecture + "-" + operating_system

def _portable_toolchain_impl(ctx):
    _validate_entrypoint(ctx.attrs.entrypoint)
    _validate_platform(ctx.attrs._local_host_platform)
    _validate_sha256(ctx.attrs.archive_sha256, "archive_sha256")
    _validate_sha256(ctx.attrs.descriptor_sha256, "descriptor_sha256")
    out = ctx.actions.declare_output("toolchain", dir = True)
    ctx.actions.run(
        cmd_args([
            ctx.attrs._bootstrap[RunInfo],
            "stage",
            "--archive",
            ctx.attrs.archive,
            "--descriptor",
            ctx.attrs.descriptor,
            "--archive-sha256",
            ctx.attrs.archive_sha256,
            "--descriptor-sha256",
            ctx.attrs.descriptor_sha256,
            "--entrypoint",
            ctx.attrs.entrypoint,
            "--expected-platform",
            ctx.attrs._local_host_platform,
            "--out",
            out.as_output(),
        ]),
        env = {"PATH": "/nonexistent"},
        category = "buck2_portable_toolchain_stage",
        identifier = "verified_archive",
        local_only = True,
    )
    executable = cmd_args(out, format = "{}/" + ctx.attrs.entrypoint)
    return [
        DefaultInfo(default_output = out),
        RunInfo(args = executable),
        PortableToolchainInfo(
            archive = ctx.attrs.archive,
            archive_sha256 = ctx.attrs.archive_sha256,
            descriptor = ctx.attrs.descriptor,
            descriptor_sha256 = ctx.attrs.descriptor_sha256,
            entrypoint = ctx.attrs.entrypoint,
            expected_platform = ctx.attrs._local_host_platform,
            tree = out,
        ),
    ]

portable_toolchain = rule(
    impl = _portable_toolchain_impl,
    attrs = {
        "archive": attrs.source(),
        "archive_sha256": attrs.string(),
        "descriptor": attrs.source(),
        "descriptor_sha256": attrs.string(),
        "entrypoint": attrs.string(),
        # Local-only host binding. This is deliberately not a claim about a
        # configured remote execution platform; that binding is deferred.
        "_local_host_platform": attrs.default_only(attrs.string(default = _local_host_platform())),
        # Nix realizes the stage-0 verifier. Consumer actions execute only the
        # independently verified archive entrypoint.
        "_bootstrap": attrs.default_only(attrs.exec_dep(
            default = "toolchains//:portable_toolchain",
            providers = [RunInfo],
        )),
    },
)

def _configured_portable_toolchain_impl(ctx):
    _validate_entrypoint(ctx.attrs.entrypoint)
    _validate_platform(ctx.attrs._local_host_platform)
    _validate_sha256(ctx.attrs.archive_sha256, "archive_sha256")
    _validate_sha256(ctx.attrs.descriptor_sha256, "descriptor_sha256")
    for path in [ctx.attrs.archive_path, ctx.attrs.descriptor_path]:
        if not path.startswith("/nix/store/"):
            fail("configured portable toolchain inputs must be immutable Nix store paths")
    out = ctx.actions.declare_output("toolchain", dir = True)
    ctx.actions.run(
        cmd_args([
            ctx.attrs._bootstrap[RunInfo],
            "stage",
            "--archive", ctx.attrs.archive_path,
            "--descriptor", ctx.attrs.descriptor_path,
            "--archive-sha256", ctx.attrs.archive_sha256,
            "--descriptor-sha256", ctx.attrs.descriptor_sha256,
            "--entrypoint", ctx.attrs.entrypoint,
            "--expected-platform", ctx.attrs._local_host_platform,
            "--out", out.as_output(),
        ]),
        env = {"PATH": "/nonexistent"},
        category = "buck2_portable_toolchain_stage",
        identifier = "configured_nix_export",
        local_only = True,
    )
    return [
        DefaultInfo(default_output = out),
        RunInfo(args = cmd_args(out, format = "{}/" + ctx.attrs.entrypoint)),
        PortableToolchainInfo(
            archive = ctx.attrs.archive_path,
            archive_sha256 = ctx.attrs.archive_sha256,
            descriptor = ctx.attrs.descriptor_path,
            descriptor_sha256 = ctx.attrs.descriptor_sha256,
            entrypoint = ctx.attrs.entrypoint,
            expected_platform = ctx.attrs._local_host_platform,
            tree = out,
        ),
    ]

configured_portable_toolchain = rule(
    impl = _configured_portable_toolchain_impl,
    attrs = {
        "archive_path": attrs.string(),
        "archive_sha256": attrs.string(),
        "descriptor_path": attrs.string(),
        "descriptor_sha256": attrs.string(),
        "entrypoint": attrs.string(),
        "_local_host_platform": attrs.default_only(attrs.string(default = _local_host_platform())),
        "_bootstrap": attrs.default_only(attrs.exec_dep(
            default = "toolchains//:portable_toolchain",
            providers = [RunInfo],
        )),
    },
)

def _portable_toolchain_fixture_impl(ctx):
    archive = ctx.actions.declare_output("artifact.tar")
    descriptor = ctx.actions.declare_output("descriptor.json")
    ctx.actions.run(
        cmd_args([
            ctx.attrs._bootstrap[RunInfo],
            "fixture",
            "--archive",
            archive.as_output(),
            "--descriptor",
            descriptor.as_output(),
        ]),
        env = {"PATH": "/nonexistent"},
        category = "buck2_portable_toolchain_fixture",
        identifier = "synthetic_nix_shape",
        local_only = True,
    )
    return [DefaultInfo(
        default_output = archive,
        other_outputs = [descriptor],
        sub_targets = {
            "descriptor": [DefaultInfo(default_output = descriptor)],
        },
    )]

portable_toolchain_fixture = rule(
    impl = _portable_toolchain_fixture_impl,
    attrs = {
        "_bootstrap": attrs.default_only(attrs.exec_dep(
            default = "toolchains//:portable_toolchain_fixture",
            providers = [RunInfo],
        )),
    },
)

def _portable_toolchain_probe_impl(ctx):
    out = ctx.actions.declare_output("portable-toolchain-evidence.txt")
    ctx.actions.run(
        cmd_args([ctx.attrs.tool[RunInfo], out.as_output()]),
        env = {"PATH": "/nonexistent"},
        category = "buck2_portable_toolchain_probe",
        identifier = "hostile_path",
        local_only = True,
    )
    return [DefaultInfo(default_output = out)]

portable_toolchain_probe = rule(
    impl = _portable_toolchain_probe_impl,
    attrs = {
        "tool": attrs.exec_dep(providers = [PortableToolchainInfo, RunInfo]),
    },
)
