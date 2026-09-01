# The package-tree runner and its complete relative-import closure, staged side
# by side in one directory so the runner's sibling imports resolve inside the
# action. A Buck action sees only declared inputs: a module missing here fails
# closed at run time instead of silently reaching into the source tree.
# Declared in genie/buck2/runtime-modules.ts and gated by
# genie/buck2/buck2-runtime-closure.unit.test.ts.
filegroup(
    name = "package_tree_runtime",
    srcs = {
        "package-tree.ts": "packages/@overeng/buck2-tools/src/package-tree.ts",
        "real-path.ts": "packages/@overeng/buck2-tools/src/real-path.ts",
    },
    visibility = ["PUBLIC"],
)

# Hermetic TypeScript actions execute this source with their pinned Bun runtime.
# Single-file staging: this runner must import nothing relative.
export_file(
    name = "packages/@overeng/buck2-tools/src/typescript-runner.ts",
    src = "packages/@overeng/buck2-tools/src/typescript-runner.ts",
    visibility = ["PUBLIC"],
)

# Stateless completeness gate: Git supplies candidates and Buck remains the sole owner matcher.
# Single-file staging: this runner must import nothing relative.
export_file(
    name = "packages/@overeng/buck2-tools/src/owned-files.ts",
    src = "packages/@overeng/buck2-tools/src/owned-files.ts",
    visibility = ["PUBLIC"],
)
