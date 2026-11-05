# Generated file - DO NOT EDIT
# Source: BUCK.foreign.bzl.genie.ts

# Projection source: rust/work-storage/BUCK.foreign.bzl.genie.ts
# Projection schema version: 1
# Projection generator: effect-utils/rust/cargo-buck2-package-projection/foreign-source
# Semantic fingerprint: sha256:8f70684d6e90c77d773160f76c57ede97511e100b6d721c38173c2717bdf281c
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
    name = "cargo-source/src/lib.rs",
    src = "src/lib.rs",
    visibility = ["PUBLIC"],
)
