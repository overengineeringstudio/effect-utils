// @genie-bootstrap
import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'
import { loadRealPnpmLockData } from './generate.ts'
import { generatePnpmSha256Sidecar, pnpmTargetName } from './pnpm-lock.ts'
import {
  renderPnpmPackageTargets,
  renderPnpmPlatformGatedPackages,
  renderPnpmStoreBuck,
} from './pnpm-store-buck.ts'
import { makePnpmStoreProjection } from './pnpm-store.ts'

const { metadata, sidecar } = loadRealPnpmLockData()
const store = makePnpmStoreProjection({ metadata, sidecar })
const effect = metadata.importers['packages/@overeng/genie']?.dependencies.effect
const effectPackage =
  effect?.kind === 'package' ? metadata.snapshots[effect.snapshot]?.package : undefined
const freshnessRuntime =
  effectPackage === undefined
    ? ''
    : `
alias(
    name = "declared_inputs_freshness_runtime",
    actual = ":${pnpmTargetName({ prefix: 'package', identity: effectPackage })}",
    visibility = ["PUBLIC"],
)
`

const output = createGenieOutput({
  data: { store },
  stringify: () =>
    `# Generated file - DO NOT EDIT
# Source: pnpm-lock.yaml
# Store fingerprint: ${store.fingerprint}

load("//buck2:materialization.bzl", "export_materialization_inputs")
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

load("//buck2/dependencies:defs.bzl", "pnpm_package", "pnpm_platform_gated_packages")

${renderPnpmPlatformGatedPackages({ metadata })}
${renderPnpmPackageTargets({ metadata, sidecar })}
${renderPnpmStoreBuck(store)}
${freshnessRuntime}`,
})

export default output

/** Offline freshness entry; consumer-owned loading preserves workspace projections. */
export const declaredInputsFreshness = async (context: Parameters<typeof output.stringify>[0]) => {
  const refuse = async (): Promise<never> => {
    throw new Error('offline sidecar cannot refresh archives')
  }
  const canonical = await generatePnpmSha256Sidecar({
    metadata,
    previous: sidecar,
    fetchArchive: refuse,
    readProductTarball: refuse,
  })
  return { buck: output.stringify(context), sidecar: `${JSON.stringify(canonical, null, 2)}\n` }
}
