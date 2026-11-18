import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'
import { cargoBuck2PackageProjection } from '../buck2-tools/core/cargo-buck2-package-projection.ts'

const projection = cargoBuck2PackageProjection({
  sourceUrl: import.meta.url,
  compileTimeResources: [{ path: 'rust/cli-build-identity/resources/golden.json' }],
})

export default createGenieOutput({
  ...projection,
  stringify: (context) => `load("//buck2/rust:defs.bzl", "rust_test_receipt")
${projection.stringify(context)}
native.export_file(
    name = "resources/golden.json",
    src = "resources/golden.json",
    visibility = ["PUBLIC"],
)

native.rust_test(
    name = "golden",
    crate = "cli_build_identity_golden",
    crate_root = "tests/golden.rs",
    srcs = ["tests/golden.rs", "resources/golden.json"],
    edition = "2021",
    deps = [
        ":lib",
        "//rust/third-party:serde",
        "//rust/third-party:serde_json",
    ],
    visibility = ["PUBLIC"],
)

rust_test_receipt(
    name = "golden-receipt",
    test = ":golden",
    visibility = ["PUBLIC"],
)
`,
})
