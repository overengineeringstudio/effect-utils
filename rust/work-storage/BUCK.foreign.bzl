# Generated file - DO NOT EDIT
# Source: BUCK.foreign.bzl.genie.ts

# Projection source: rust/work-storage/BUCK.foreign.bzl.genie.ts
# Projection schema version: 1
# Projection generator: effect-utils/rust/cargo-buck2-package-projection/foreign-source
# Semantic fingerprint: sha256:39fa56b52e716afb2f50f2c6264cd010fbaadc5aba1d8d0a19872f1c88a9efea
# Regenerate: devenv tasks run genie:run

load("@prelude//:prelude.bzl", "native")
native.export_file(
    name = "cargo-source/Cargo.toml",
    src = "Cargo.toml",
    visibility = ["PUBLIC"],
)

native.export_file(
    name = "cargo-source/build.rs",
    src = "build.rs",
    visibility = ["PUBLIC"],
)

native.export_file(
    name = "cargo-source/resources/conformance.json",
    src = "resources/conformance.json",
    visibility = ["PUBLIC"],
)

native.export_file(
    name = "cargo-source/resources/protocol.schema.json",
    src = "resources/protocol.schema.json",
    visibility = ["PUBLIC"],
)

native.export_file(
    name = "cargo-source/src/lib.rs",
    src = "src/lib.rs",
    visibility = ["PUBLIC"],
)
