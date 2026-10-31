import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'
import { cargoBuck2PackageProjection } from '../buck2-tools/core/cargo-buck2-package-projection.ts'

const projection = cargoBuck2PackageProjection({ buildProduct: true, sourceUrl: import.meta.url })

// Execute library contract tests through Buck's full repository authority.
export default createGenieOutput({
  ...projection,
  stringify: (context) => `load("//buck2/rust:defs.bzl", "rust_test_receipt")
${projection.stringify(context)}
native.rust_test(
    name = "tests",
    crate = "ci_storage_tests",
    crate_root = "src/lib.rs",
    srcs = glob(["src/**/*.rs"]),
    edition = "2021",
    deps = [
        "//rust/third-party:clap",
        "//rust/third-party:flate2",
        "//rust/third-party:proptest",
        "//rust/third-party:rustix",
        "//rust/third-party:serde",
        "//rust/third-party:serde_json",
        "//rust/third-party:sha2",
        "//rust/third-party:tar",
        "//rust/third-party:tempfile",
        "//rust/third-party:ureq",
    ],
    visibility = ["PUBLIC"],
)

rust_test_receipt(
    name = "tests-receipt",
    test = ":tests",
    visibility = ["PUBLIC"],
)
`,
})
