load("//buck2:materialization.bzl", "export_materialization_inputs")

# Exact root-package inputs consumed by admitted TypeScript package trees.
_TYPESCRIPT_PACKAGE_INPUTS = [
    "packages/@overeng/buck2-tools/src/package-tree.ts",
]

export_materialization_inputs(_TYPESCRIPT_PACKAGE_INPUTS)

# Hermetic TypeScript actions execute this source with their pinned Bun runtime.
export_file(
    name = "packages/@overeng/buck2-tools/src/typescript-runner.ts",
    src = "packages/@overeng/buck2-tools/src/typescript-runner.ts",
    visibility = ["PUBLIC"],
)

# Stateless completeness gate: Git supplies candidates and Buck remains the sole owner matcher.
export_file(
    name = "packages/@overeng/buck2-tools/src/owned-files.ts",
    src = "packages/@overeng/buck2-tools/src/owned-files.ts",
    visibility = ["PUBLIC"],
)
