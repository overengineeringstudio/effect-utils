import { describe, expect, it } from 'vitest'

import cacheTargets from '../../nix/buck2-products/cache-targets.json.genie.ts'
import { assertPublishedPackageClosure } from './package-product-inventory.ts'
import { productBuildCapabilities } from './product-capabilities.ts'

const workspaceNames = new Set(['@overeng/content-address', '@overeng/effect-rust'])
const contentAddress = {
  name: '@overeng/content-address',
  dependencies: { '@overeng/effect-rust': 'workspace:^' },
}
const effectRust = { name: '@overeng/effect-rust' }

describe('published package product inventory', () => {
  it('publishes the content-address runtime dependency as a package product', () => {
    expect(cacheTargets.data).toContainEqual({
      buildCapabilities: ['action-env', 'archive-tool', 'buck2-fingerprint', 'bun', 'effect-tsgo', 'product'],
      kind: 'package',
      name: '@overeng/effect-rust',
      outputName: 'overeng-effect-rust.tgz',
      packagePath: 'packages/@overeng/effect-rust',
      packageTreePath: 'packages/@overeng/effect-rust',
      target: 'effect_utils//packages/@overeng/effect-rust:dist-package',
      version: '0.1.0',
    })
    expect(() =>
      assertPublishedPackageClosure({ packages: [contentAddress, effectRust], workspaceNames }),
    ).not.toThrow()
  })

  it('rejects the missing product that previously escaped publication', () => {
    expect(() =>
      assertPublishedPackageClosure({ packages: [contentAddress], workspaceNames }),
    ).toThrow(
      'Published package @overeng/content-address has dependencies on unpublished workspace package @overeng/effect-rust',
    )
  })

  it.each(['optionalDependencies', 'peerDependencies'] as const)(
    'rejects unpublished workspace %s even with a registry version range',
    (field) => {
      expect(() =>
        assertPublishedPackageClosure({
          packages: [{ name: contentAddress.name, [field]: { '@overeng/effect-rust': '^0.1.0' } }],
          workspaceNames,
        }),
      ).toThrow(`has ${field} on unpublished workspace package @overeng/effect-rust`)
    },
  )

  it('does not require external dependencies or build-only workspace tools to be products', () => {
    const packageWithBuildTools = {
      name: contentAddress.name,
      dependencies: { effect: '4.0.0' },
      devDependencies: { '@overeng/effect-rust': 'workspace:^' },
    }
    expect(() =>
      assertPublishedPackageClosure({ packages: [packageWithBuildTools], workspaceNames }),
    ).not.toThrow()
  })
})

describe('product capability inventory', () => {
  it('keeps the fingerprint mutation proof only on npm emission/typecheck', () => {
    expect(productBuildCapabilities({ kind: 'package' })).toContain('buck2-fingerprint')
    for (const product of [
      { kind: 'native', cargoWorkspaceRoot: 'rust' },
      { kind: 'native' },
      { kind: 'compiled-executable' },
      { kind: 'javascript' },
    ] as const) {
      expect(productBuildCapabilities(product)).not.toContain('buck2-fingerprint')
    }
  })

  it('declares only the pnpm tree and Bun action capabilities for portable bundles', () => {
    for (const product of cacheTargets.data.filter((product) => product.kind === 'javascript')) {
      expect(product.buildCapabilities).toEqual(['action-env', 'archive-tool', 'bun'])
    }
  })

  it('projects deterministic unique capability lists for every inventory product', () => {
    for (const product of cacheTargets.data) {
      expect(product.buildCapabilities).toEqual([...new Set(product.buildCapabilities)].toSorted())
    }
  })
})
