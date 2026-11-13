pnpm_platform_gated_packages(
    name = "platform_gated_packages",
    capabilities = {
    },
    families = {
    },
    visibility = ["PUBLIC"],
)


load(":defs.bzl", "pnpm_directory_package", "pnpm_platform_configurations", "pnpm_store_entry", "pnpm_store_scc", "pnpm_store_view")

pnpm_platform_configurations()

export_file(
    name = "assemble-store.ts",
    src = "assemble-store.ts",
    visibility = ["PUBLIC"],
)

pnpm_store_view(
    name = "view__cdb4ee2aea69",
    runtime = ":assemble-store.ts",
    direct = {
    },
    closure = {
    },
    bins = {
    },
    workspace_trees = {
    },
    workspace_dependencies = {
    },
    visibility = ["PUBLIC"],
)

pnpm_store_view(
    name = "product_view__cdb4ee2aea69",
    runtime = ":assemble-store.ts",
    direct = {
    },
    closure = {
    },
    bins = {
    },
    workspace_trees = {
    },
    workspace_dependencies = {
    },
    visibility = ["PUBLIC"],
)

pnpm_store_view(
    name = "external_view__cdb4ee2aea69",
    runtime = ":assemble-store.ts",
    direct = {
    },
    closure = {
    },
    bins = {
    },
    workspace_trees = {
    },
    workspace_dependencies = {
    },
    visibility = ["PUBLIC"],
)
