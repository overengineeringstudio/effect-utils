# Generated file - DO NOT EDIT
# Source: BUCK.foreign.bzl.genie.ts

# Projection source: packages/@overeng/work-storage/BUCK.foreign.bzl.genie.ts
# Semantic fingerprint: sha256:d4196d1885a388d753e1afe5c8d84fc150a81cef3dcce9d5b51e1cce58890a86
# Regenerate: devenv tasks run genie:run

load("@prelude//:prelude.bzl", "native")
native.export_file(
    name = "conformance-fixtures",
    src = "fixtures/conformance.json",
    visibility = ["PUBLIC"],
)

native.export_file(
    name = "protocol-schema",
    src = "protocol.schema.json",
    visibility = ["PUBLIC"],
)
