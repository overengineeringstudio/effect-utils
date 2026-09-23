import { describe, expect, it } from 'vitest'

import { buck2RulesInventory } from '../../nix/buck2-rules/inventory.json.genie.ts'

const expectedFiles = [
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
  'buck2/static_checks.bzl',
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

describe('Buck rules product inventory', () => {
  it('is one sorted, duplicate-free declaration of the complete distribution surface', () => {
    expect(buck2RulesInventory).toEqual({
      schema: 'effect-utils/buck2-rules-inventory/v1',
      files: expectedFiles,
    })
    expect([...buck2RulesInventory.files].toSorted()).toEqual(buck2RulesInventory.files)
    expect(new Set(buck2RulesInventory.files).size).toBe(buck2RulesInventory.files.length)
  })

  it('contains runtime and capability inputs but no effect-utils package product targets', () => {
    expect(buck2RulesInventory.files).toContain('buck2-member.json')
    expect(buck2RulesInventory.files).toContain(
      'packages/@overeng/megarepo/src/composition/capabilities/capability-projection.ts',
    )
    expect(buck2RulesInventory.files).toContain(
      'packages/@overeng/buck2-tools/src/typescript-runner.ts',
    )
    expect(buck2RulesInventory.files).not.toContain('buck2/dependencies/BUCK')
    expect(
      buck2RulesInventory.files.filter(
        (path) =>
          path.startsWith('packages/@overeng/') &&
          path.startsWith('packages/@overeng/buck2-tools/') === false &&
          path !== 'packages/@overeng/megarepo/src/buck2-manifest.ts' &&
          path.startsWith('packages/@overeng/megarepo/src/composition/capabilities/') === false,
      ),
    ).toEqual([])
  })
})
