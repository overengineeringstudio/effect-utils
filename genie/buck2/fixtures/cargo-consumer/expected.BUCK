# Projection source: components/rust/consumer-cli/BUCK.genie.ts
# Projection schema version: 1
# Projection generator: effect-utils/rust/cargo-buck2-package-projection
# Semantic fingerprint: sha256:ffa7a6cfa51b2d5728927fd4e45c3b3a1f5396c953e565f0ae4b8d17ba976fd5
# Semantic inputs: components/rust/Cargo.lock, components/rust/Cargo.toml, components/rust/consumer-cli/BUCK.genie.ts, components/rust/consumer-cli/Cargo.toml, components/rust/consumer-cli/src/**/*.rs, components/rust/consumer-cli/tests/**/*.rs, components/rust/reindeer.toml, vendor/cargo/BUCK
# Regenerate: devenv tasks run genie:run

load("@prelude//:prelude.bzl", "native")
load("@rules//buck2:static_checks.bzl", "static_source_set")
load("@rules//buck2/products:defs.bzl", "build_product")
load("@rules//buck2/platforms:defs.bzl", "host_platform_label")
load("@rules//buck2/rust:defs.bzl", "rust_product_executable")
static_source_set(
    name = "static_sources",
    prefix = "components/rust/consumer-cli",
    srcs = [
        "BUCK",
        "BUCK.genie.ts",
        "Cargo.toml",
        "src/main.rs",
    ] + glob(["rust-toolchain.toml"]),
    visibility = ["PUBLIC"],
)

native.rust_binary(
    name = "consumer-cli",
    crate = "consumer_cli",
    crate_root = "src/main.rs",
    srcs = [
        "src/main.rs",
    ],
    deps = [
        "//vendor/cargo:serde",
    ],
    edition = "2024",
    env = {
        "CARGO_PKG_NAME": "consumer-cli",
        "CARGO_PKG_VERSION": "0.1.0",
    },
    visibility = [
        "PUBLIC",
    ],
)

rust_product_executable(
    name = "consumer-cli-product-executable",
    binary = ":consumer-cli",
    recipe = "cargo-workspace:consumer-cli@0.1.0",
    target_platform = host_platform_label(cell = "rules"),
)

build_product(
    name = "consumer-cli-product",
    entrypoint = "bin/consumer-cli",
    executable = ":consumer-cli-product-executable",
    product_name = "consumer-cli",
    target_platform = host_platform_label(cell = "rules"),
)
