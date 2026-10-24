import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'
import { cargoBuck2PackageProjection } from '../buck2-tools/core/cargo-buck2-package-projection.ts'

const projection = cargoBuck2PackageProjection({ sourceUrl: import.meta.url })

// The workspace projector publishes Rust libraries; this crate also admits its
// shared wire conformance suite to the repository's full CI authority.
export default createGenieOutput({
  ...projection,
  stringify: (context) => `load("//buck2/rust:defs.bzl", "rust_test_receipt")
${projection.stringify(context)}
native.rust_test(
    name = "conformance",
    crate = "work_storage_conformance",
    crate_root = "tests/conformance.rs",
    srcs = ["tests/conformance.rs"],
    edition = "2021",
    deps = [
        ":lib",
        "//rust/third-party:serde",
        "//rust/third-party:serde_json",
    ],
    env = {
        "OUT_DIR": "$(location :work-storage-build-script-run[out_dir])",
    },
    visibility = ["PUBLIC"],
)

rust_test_receipt(
    name = "conformance-receipt",
    test = ":conformance",
    visibility = ["PUBLIC"],
)
`,
})
