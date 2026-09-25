import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { buck2RulesInventory } from '../../nix/buck2-rules/inventory.json.genie.ts'

const repoRoot = new URL('../../', import.meta.url)

const expectedFiles = [
  'buck2-member.json',
  'buck2/dependencies/acquire-archive.ts',
  'buck2/dependencies/assemble-store.ts',
  'buck2/dependencies/defs.bzl',
  'buck2/dependencies/nix-archive.ts',
  'buck2/dependencies/public-archive-origin.ts',
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
  'packages/@overeng/buck2-tools/src/javascript-runner.ts',
  'packages/@overeng/buck2-tools/src/owned-files.ts',
  'packages/@overeng/buck2-tools/src/package-command-runner.ts',
  'packages/@overeng/buck2-tools/src/package-tree.ts',
  'packages/@overeng/buck2-tools/src/real-path.ts',
  'packages/@overeng/buck2-tools/src/repository-policy-runner.ts',
  'packages/@overeng/buck2-tools/src/repository-validation-runner.ts',
  'packages/@overeng/buck2-tools/src/static-check-runner.ts',
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

  /* Rule defaults resolve inside the consumer's `rules` cell, so every source file they name must ship and be exported there (#1386 regression). */
  it('ships and exports every source file that shipped rule defaults reference', () => {
    const referenced = new Set<string>()
    for (const path of buck2RulesInventory.files.filter((file) => file.endsWith('.bzl'))) {
      const text = readFileSync(new URL(path, repoRoot), 'utf8')
      for (const match of text.matchAll(/default = "\/\/([^":]+):([^"]+\.(?:ts|js|sh|json))"/g)) {
        referenced.add(`${match[1]}:${match[2]}`)
      }
    }
    expect(referenced).toContain('buck2/dependencies:acquire-archive.ts')
    expect(referenced).toContain('packages/@overeng/buck2-tools:src/repository-validation-runner.ts')
    const rulesCell = readFileSync(new URL('nix/buck2-rules/default.nix', repoRoot), 'utf8')
    for (const label of referenced) {
      const [pkg, file] = label.split(':') as [string, string]
      expect(buck2RulesInventory.files).toContain(`${pkg}/${file}`)
      expect(rulesCell).toContain(`name = "${file}",`)
    }
  })
})
