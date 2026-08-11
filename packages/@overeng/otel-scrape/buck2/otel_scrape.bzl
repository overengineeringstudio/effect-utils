"""Native Rust targets for otel-scrape with validated Nix build identity.

All configured tools are immutable Nix paths. The integration-test execution
environment is deliberately explicit and does not inherit an ambient PATH.
"""

load("@prelude//:prelude.bzl", "native")
load("//buck2:binary_artifact.bzl", "native_binary_artifact")
load(":reindeer.bzl", "configured_store_root")

_HEX = "0123456789abcdef"
_DIGITS = "0123456789"

def _configured_text(section, key):
    value = read_root_config(section, key, "")
    if not value or "\n" in value or "\r" in value or "\x00" in value:
        fail("{}.{} must be a non-empty single-line value".format(section, key))
    return value

def _configured_path(section, key):
    value = _configured_text(section, key)
    parts = value.split("/")
    if (
        not value.startswith("/nix/store/") or
        len(parts) < 5 or
        parts[0] != "" or
        parts[1] != "nix" or
        parts[2] != "store" or
        any([part == "" or part == "." or part == ".." for part in parts[3:]])
    ):
        fail("{}.{} must be an immutable executable path under /nix/store".format(section, key))
    return value

def _require_chars(value, allowed, label):
    if any([character not in allowed for character in value.elems()]):
        fail("{} contains an invalid character".format(label))

def _nix_stamp():
    revision = _configured_text("buck2_build", "revision")
    if len(revision) != 40:
        fail("buck2_build.revision must be a full 40-character Git revision")
    _require_chars(revision, _HEX, "buck2_build.revision")

    commit_timestamp = _configured_text("buck2_build", "commit_timestamp")
    _require_chars(commit_timestamp, _DIGITS, "buck2_build.commit_timestamp")

    dirty = _configured_text("buck2_build", "dirty")
    if dirty != "true" and dirty != "false":
        fail("buck2_build.dirty must be exactly true or false")

    return '{"type":"nix","version":"0.0.0","rev":"' + revision + '","commitTs":' + commit_timestamp + ',"dirty":' + dirty + "}"

def _require_local_platform(platform):
    host = host_info()
    if not host.os.is_linux or not host.arch.is_x86_64:
        fail("otel-scrape Buck targets require an x86_64-linux local execution host")
    if platform != "x86_64-linux":
        fail("otel-scrape platform must be exactly x86_64-linux")

def _parent(path):
    return "/".join(path.split("/")[:-1])

def otel_scrape_targets(
        library_sources,
        integration_test_source,
        platform):
    """Declare the native library, binary, unit-test, and integration-test graph."""
    _require_local_platform(platform)
    library_env = {
        "CARGO_PKG_VERSION": "0.0.0",
    }
    binary_env = dict(library_env)
    binary_env["CLI_BUILD_STAMP"] = _nix_stamp()
    third_party = "//packages/@overeng/otel-scrape/buck2/third-party:"
    library_deps = [
        third_party + "getrandom",
        third_party + "libc",
        third_party + "serde",
        third_party + "serde_json",
        third_party + "sha2",
    ]

    native.rust_library(
        name = "lib",
        crate = "otel_scrape",
        crate_root = "src/lib.rs",
        edition = "2021",
        srcs = library_sources,
        deps = library_deps,
        env = library_env,
        visibility = ["PUBLIC"],
    )

    native.rust_binary(
        name = "otel-scrape",
        crate = "otel_scrape",
        crate_root = "src/main.rs",
        edition = "2021",
        srcs = ["src/main.rs"],
        deps = [":lib"],
        env = binary_env,
        visibility = ["PUBLIC"],
    )

    native_binary_artifact(
        name = "otel-scrape-artifact",
        binary = ":otel-scrape",
        binary_name = "otel-scrape",
        platform = platform,
        visibility = ["PUBLIC"],
    )

    native.rust_test(
        name = "unit",
        crate = "otel_scrape_unit",
        crate_root = "src/lib.rs",
        edition = "2021",
        srcs = library_sources,
        deps = library_deps + [third_party + "tempfile"],
        env = library_env,
    )

    sh = _configured_path("buck2_nix", "otel_scrape_sh")
    true_bin = _configured_path("buck2_nix", "otel_scrape_true")
    node = _configured_path("buck2_nix", "otel_scrape_node")
    rustc = _configured_path("buck2_nix", "otel_scrape_rustc")
    integration_path = ":".join([
        _parent(sh),
        _parent(true_bin),
        _parent(node),
        configured_store_root("clang_root") + "/bin",
        configured_store_root("binutils_root") + "/bin",
    ])

    native.rust_test(
        name = "cli",
        crate = "otel_scrape_cli_test",
        crate_root = integration_test_source,
        edition = "2021",
        srcs = [integration_test_source],
        deps = [
            ":lib",
            third_party + "serde_json",
            third_party + "sha2",
            third_party + "tempfile",
        ],
        env = {
            "CARGO_BIN_EXE_otel-scrape": "$(location :otel-scrape)",
            "PATH": integration_path,
            "RUSTC": rustc,
        },
        resources = [":otel-scrape"],
    )
