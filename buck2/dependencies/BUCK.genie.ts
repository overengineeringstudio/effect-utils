// @genie-bootstrap
import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'
import { loadRealPnpmLockData } from './generate.ts'
import {
  renderPnpmPackageTargets,
  renderPnpmPlatformGatedPackages,
  renderPnpmStoreBuck,
} from './pnpm-store-buck.ts'
import { makePnpmStoreProjection } from './pnpm-store.ts'

const { metadata, sidecar } = loadRealPnpmLockData()
const store = makePnpmStoreProjection({ metadata, sidecar })

export default createGenieOutput({
  data: { store },
  stringify: () =>
    `# Generated file - DO NOT EDIT
# Source: pnpm-lock.yaml
# Store fingerprint: ${store.fingerprint}

load("//buck2:materialization.bzl", "export_materialization_inputs", "runtime_modules")
load("//buck2:static_checks.bzl", "static_source_set")

static_source_set(
    name = "static_sources",
    prefix = "buck2/dependencies",
    srcs = glob(["*.json", "*.ts"]),
    visibility = ["PUBLIC"],
)


# The root Buck suite asserts over this package's own generated declaration and
# over the store fingerprint sidecar, so both are declared inputs, not just
# generated output.
export_materialization_inputs(
    glob(["*.ts", "fixtures/**"], exclude = ["assemble-store.ts"]) + ["BUCK", "pnpm-lock.sha256.json"],
)

# Preserve source-relative imports in one enumerated runtime shared by every
# archive acquisition. Exported files alone do not retain their source topology.
runtime_modules(
    name = "shared_archive_runtime",
    srcs = {
        "buck2/dependencies/shared-archive.ts": ":shared-archive.ts",
        "packages/@overeng/buck2-tools/src/public-archive-origin.ts": "//packages/@overeng/buck2-tools:src/public-archive-origin.ts",
        "packages/@overeng/buck2-tools/src/materialization-archives.ts": "//packages/@overeng/buck2-tools:src/materialization-archives.ts",
        "packages/@overeng/buck2-tools/src/materialization-metadata.ts": "//packages/@overeng/buck2-tools:src/materialization-metadata.ts",
        "packages/@overeng/buck2-tools/src/materialization-recipes.ts": "//packages/@overeng/buck2-tools:src/materialization-recipes.ts",
        "packages/@overeng/buck2-tools/src/editor-view-sharing.ts": "//packages/@overeng/buck2-tools:src/editor-view-sharing.ts",
        "packages/@overeng/buck2-tools/src/editor-view-leases.ts": "//packages/@overeng/buck2-tools:src/editor-view-leases.ts",
    },
    visibility = ["PUBLIC"],
)

runtime_modules(
    name = "shared_recipe_runtime",
    srcs = {
        "buck2/dependencies/shared-recipe.ts": ":shared-recipe.ts",
        "packages/@overeng/buck2-tools/src/public-archive-origin.ts": "//packages/@overeng/buck2-tools:src/public-archive-origin.ts",
        "packages/@overeng/buck2-tools/src/materialization-archives.ts": "//packages/@overeng/buck2-tools:src/materialization-archives.ts",
        "packages/@overeng/buck2-tools/src/materialization-metadata.ts": "//packages/@overeng/buck2-tools:src/materialization-metadata.ts",
        "packages/@overeng/buck2-tools/src/materialization-recipes.ts": "//packages/@overeng/buck2-tools:src/materialization-recipes.ts",
        "packages/@overeng/buck2-tools/src/editor-view-sharing.ts": "//packages/@overeng/buck2-tools:src/editor-view-sharing.ts",
        "packages/@overeng/buck2-tools/src/editor-view-leases.ts": "//packages/@overeng/buck2-tools:src/editor-view-leases.ts",
    },
    visibility = ["PUBLIC"],
)

load("//buck2/dependencies:defs.bzl", "pnpm_package", "pnpm_platform_gated_packages")

${renderPnpmPlatformGatedPackages({ metadata })}
${renderPnpmPackageTargets({ metadata, sidecar })}
${renderPnpmStoreBuck(store)}`,
})
