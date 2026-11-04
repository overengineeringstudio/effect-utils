"""Internal library-product rejection fixtures; not part of the rules product."""

load("@prelude//:prelude.bzl", "native")
load("//buck2/platforms:defs.bzl", "host_platform_label")
load("//buck2/rust:library.bzl", "rust_product_library")

def panic_rejection(route, overrides):
    """Declares referenced and unused abort dependencies under an unwind product."""
    native.rust_library(
        name = "panic_" + route,
        crate_root = "generic.rs",
        srcs = ["generic.rs"],
        edition = "2024",
        **overrides
    )
    native.rust_library(
        name = "transitive_panic_" + route,
        crate_root = "bridge.rs",
        srcs = ["bridge.rs"],
        named_deps = {"generic_leaf": ":panic_" + route},
        edition = "2024",
    )
    rust_product_library(
        name = "reject_panic_" + route,
        library = ":transitive_panic_" + route,
        recipe = "library-panic-rejection/v1",
        target_platform = host_platform_label(),
    )
    # generic.rs never mentions this dependency: only the closure probe loads it.
    native.rust_library(
        name = "unused_panic_" + route,
        crate_root = "generic.rs",
        srcs = ["generic.rs"],
        deps = [":panic_" + route],
        edition = "2024",
    )
    rust_product_library(
        name = "reject_panic_unused_" + route,
        library = ":unused_panic_" + route,
        recipe = "library-unused-panic-rejection/v1",
        target_platform = host_platform_label(),
    )
