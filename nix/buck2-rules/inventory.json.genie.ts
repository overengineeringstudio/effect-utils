import { projectionArtifact } from '../../packages/@overeng/genie/src/runtime/mod.ts'

const files = [
  'BUCK',
  'buck2-member.json',
  'buck2/dependencies/defs.bzl',
  'buck2/editor_view.bzl',
  'buck2/go/defs.bzl',
  'buck2/javascript.bzl',
  'buck2/materialization.bzl',
  'buck2/package_tools.bzl',
  'buck2/platforms/BUCK',
  'buck2/platforms/defs.bzl',
  'buck2/products/BUCK',
  'buck2/products/defs.bzl',
  'buck2/provenance/BUCK',
  'buck2/provenance/defs.bzl',
  'buck2/rust/BUCK',
  'buck2/rust/defs.bzl',
  'buck2/rust/toolchains.bzl',
  'buck2/toolchains/BUCK',
  'buck2/toolchains/configured.bzl',
  'buck2/toolchains/defs.bzl',
  'buck2/toolchains/provider_identity_fixture.bzl',
  'buck2/typescript.bzl',
  'packages/@overeng/buck2-tools/src/owned-files.ts',
  'packages/@overeng/buck2-tools/src/package-command-runner.ts',
  'packages/@overeng/buck2-tools/src/package-tree.ts',
  'packages/@overeng/buck2-tools/src/real-path.ts',
  'packages/@overeng/buck2-tools/src/typescript-runner.ts',
  'packages/@overeng/megarepo/src/buck2-manifest.ts',
  'packages/@overeng/megarepo/src/composition/capabilities/capability-projection.ts',
  'packages/@overeng/megarepo/src/composition/capabilities/composition-capability-resolver-schema.ts',
] as const

export const buck2RulesInventory = {
  schema: 'effect-utils/buck2-rules-inventory/v1',
  files,
} as const

export default projectionArtifact.json({
  schemaVersion: 1,
  data: buck2RulesInventory,
  project: (inventory) => inventory,
})
