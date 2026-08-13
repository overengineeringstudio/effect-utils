"""Native Rust graph for otel-scrape."""

load("@prelude//:prelude.bzl", "native")
load("//buck2:rust_product.bzl", "rust_build_product")

_EXECUTION = ["//buck2/platforms:x86_64_linux_local_store_execution"]
_TARGET = [
    "prelude//abi/constraints:musl",
    "prelude//cpu/constraints:x86_64",
    "prelude//os/constraints:linux",
    "//buck2/platforms:static",
]

def otel_scrape_targets(binary_name, binary_path, dev_deps, edition, library_name, library_path, library_sources, normal_deps, package_name, package_version):
    compile_identity = read_config("rust_toolchain", "compile_identity", "")
    if len(compile_identity) != 71 or not compile_identity.startswith("sha256:"):
        fail("rust_toolchain.compile_identity must be a Nix-authored sha256 identity")
    common = {
        "edition": edition,
        "exec_compatible_with": _EXECUTION,
        "target_compatible_with": _TARGET,
    }
    compile_env = {
        "CARGO_PKG_NAME": package_name,
        "CARGO_PKG_VERSION": package_version,
        # The Nix-authored semantic identity is an explicit compile-action key
        # input in addition to the immutable executable paths in the provider.
        "EFFECT_UTILS_BUCK2_TOOLCHAIN_IDENTITY": compile_identity,
    }
    native.rust_library(
        name = "lib",
        crate = library_name,
        crate_root = library_path,
        srcs = library_sources,
        deps = normal_deps,
        env = compile_env,
        visibility = ["PUBLIC"],
        **common
    )
    native.rust_binary(
        name = binary_name,
        crate = binary_name.replace("-", "_"),
        crate_root = binary_path,
        srcs = [binary_path],
        deps = [":lib"],
        env = compile_env,
        visibility = ["PUBLIC"],
        **common
    )
    native.rust_test(
        name = "unit",
        crate = library_name + "_unit",
        crate_root = library_path,
        srcs = library_sources,
        deps = normal_deps + dev_deps,
        env = compile_env,
        **common
    )
    rust_build_product(
        name = "product",
        binary = ":" + binary_name,
        binary_name = binary_name,
        compile_identity = compile_identity,
        visibility = ["PUBLIC"],
    )
