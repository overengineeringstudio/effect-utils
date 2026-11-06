// Generated file - DO NOT EDIT
// Source: production-helpers.BUCK.genie.ts
load("//buck2/package_tools.bzl", "package_command_runtime")
load("//buck2:materialization.bzl", "runtime_modules")
load("//buck2:materialization.bzl", "export_materialization_inputs", "package_view")
load("//buck2:editor_view.bzl", "editor_view_inputs")
load("//buck2:static_checks.bzl", "STATIC_SOURCE_EXCLUDES", "STATIC_SOURCE_GLOBS", "static_source_set")
load("//buck2:typescript.bzl", "tsgo_emit", "tsgo_typecheck")
load("//buck2:package_tools.bzl", "npm_package_archive")

export_file(
    name = "package.json",
    src = "package.json",
    visibility = ["PUBLIC"],
)

alias(
    name = "node_modules",
    actual = "//buck2/dependencies:view_packages_overeng_buck2_tools_e521acf736cf",
    visibility = ["PUBLIC"],
)

package_view(
    name = "package_tree",
    dependency_view = "//buck2/dependencies:view_packages_overeng_buck2_tools_e521acf736cf",
    files = {
        "package.json": "package.json",
        "src/bun-test-preload.ts": "src/bun-test-preload.ts",
        "src/bun-test-runner.ts": "src/bun-test-runner.ts",
        "src/bun-test-timeout.ts": "src/bun-test-timeout.ts",
        "src/editor-view-lifecycle.ts": "src/editor-view-lifecycle.ts",
        "src/javascript-runner.ts": "src/javascript-runner.ts",
        "src/package-command-runner.ts": "src/package-command-runner.ts",
        "src/package-tree.ts": "src/package-tree.ts",
        "src/real-path.ts": "src/real-path.ts",
        "src/test-verdict.ts": "src/test-verdict.ts",
        "src/typescript-runner.ts": "src/typescript-runner.ts",
        "tsconfig.json": "tsconfig.json",
    },
    workspace_dist = {
    },
    generated_dependencies = {
    },
    workspace_dependency_views = {
    },
    strip_project_references = True,
    runtime = "//packages/@overeng/buck2-tools:package_tree_runtime",
    runtime_entry = "package-tree.ts",
    visibility = ["PUBLIC"],
)

package_view(
    name = "product_package_tree",
    dependency_view = "//buck2/dependencies:product_view_packages_overeng_buck2_tools_e521acf736cf",
    files = {
        "package.json": "package.json",
        "src/bun-test-preload.ts": "src/bun-test-preload.ts",
        "src/bun-test-runner.ts": "src/bun-test-runner.ts",
        "src/bun-test-timeout.ts": "src/bun-test-timeout.ts",
        "src/editor-view-lifecycle.ts": "src/editor-view-lifecycle.ts",
        "src/javascript-runner.ts": "src/javascript-runner.ts",
        "src/package-command-runner.ts": "src/package-command-runner.ts",
        "src/package-tree.ts": "src/package-tree.ts",
        "src/real-path.ts": "src/real-path.ts",
        "src/test-verdict.ts": "src/test-verdict.ts",
        "src/typescript-runner.ts": "src/typescript-runner.ts",
        "tsconfig.json": "tsconfig.json",
    },
    workspace_dist = {
    },
    generated_dependencies = {
    },
    workspace_dependency_views = {
    },
    strip_project_references = True,
    runtime = "//packages/@overeng/buck2-tools:package_tree_runtime",
    runtime_entry = "package-tree.ts",
    visibility = ["PUBLIC"],
)

runtime_modules(
    name = "package_tree_runtime",
    srcs = {
        "package-tree.ts": "src/package-tree.ts",
        "real-path.ts": "src/real-path.ts",
    },
    visibility = ["PUBLIC"],
)

filegroup(
    name = "package_command_runtime_files",
    srcs = {
        "package-command-runner.ts": "src/package-command-runner.ts",
        "real-path.ts": "src/real-path.ts",
        "typescript-runner.ts": "src/typescript-runner.ts",
        "node_modules": ":node_modules",
    },
    visibility = ["PUBLIC"],
)

package_command_runtime(
    name = "package_command_runtime",
    files = ":package_command_runtime_files",
    dependency_view = ":node_modules",
    visibility = ["PUBLIC"],
)

runtime_modules(
    name = "javascript_action_runtime",
    srcs = {
        "javascript-runner.ts": "src/javascript-runner.ts",
        "bun-test-runner.ts": "src/bun-test-runner.ts",
        "bun-test-timeout.ts": "src/bun-test-timeout.ts",
        "bun-test-preload.ts": "src/bun-test-preload.ts",
        "test-verdict.ts": "src/test-verdict.ts",
        "typescript-runner.ts": "src/typescript-runner.ts",
    },
    visibility = ["PUBLIC"],
)

export_file(
    name = "typescript-runner.ts",
    src = "src/typescript-runner.ts",
    visibility = ["PUBLIC"],
)
