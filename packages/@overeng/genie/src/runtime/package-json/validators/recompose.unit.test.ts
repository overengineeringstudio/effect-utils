import { describe, expect, it } from 'vitest'

import type { GenieContext } from '../../mod.ts'
import type { PackageInfo } from '../../validation/mod.ts'
import { validatePackageRecompositionForPackage } from './recompose.ts'

const makePackage = (
  overrides: Partial<PackageInfo> & { name: string; path: string },
): PackageInfo => ({
  ...overrides,
})

const makeContext = (packages: PackageInfo[]): GenieContext => ({
  location: '.',
  cwd: '/workspace',
  workspace: {
    packages,
    byName: new Map(packages.map((p) => [p.name, p])),
  },
})

describe('validatePackageRecompositionForPackage', () => {
  it('returns no issues when there are no workspace deps', () => {
    const pkg = makePackage({
      name: '@test/app',
      path: 'packages/app',
      dependencies: { effect: '3.0.0' },
    })
    const ctx = makeContext([pkg])

    const issues = validatePackageRecompositionForPackage({ ctx, pkgName: '@test/app' })
    expect(issues).toEqual([])
  })

  it('returns no issues when peer deps are properly re-exported', () => {
    const upstream = makePackage({
      name: '@test/utils',
      path: 'packages/utils',
      peerDependencies: { effect: '^3.0.0' },
    })
    const downstream = makePackage({
      name: '@test/app',
      path: 'packages/app',
      dependencies: { '@test/utils': 'workspace:*' },
      peerDependencies: { effect: '^3.0.0' },
    })
    const ctx = makeContext([upstream, downstream])

    const issues = validatePackageRecompositionForPackage({ ctx, pkgName: '@test/app' })
    expect(issues).toEqual([])
  })

  it('reports missing peer dep from upstream (non-private)', () => {
    const upstream = makePackage({
      name: '@test/utils',
      path: 'packages/utils',
      peerDependencies: { effect: '^3.0.0', react: '^19.0.0' },
    })
    const downstream = makePackage({
      name: '@test/app',
      path: 'packages/app',
      dependencies: { '@test/utils': 'workspace:*' },
      peerDependencies: { effect: '^3.0.0' },
    })
    const ctx = makeContext([upstream, downstream])

    const issues = validatePackageRecompositionForPackage({ ctx, pkgName: '@test/app' })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      severity: 'error',
      packageName: '@test/app',
      dependency: 'react',
      rule: 'recompose-peer-deps',
      message: 'Missing peer dep "react" required by "@test/utils"',
    })
  })

  it('reports missing optional peer meta', () => {
    const upstream = makePackage({
      name: '@test/utils',
      path: 'packages/utils',
      peerDependencies: { react: '^19.0.0' },
      peerDependenciesMeta: { react: { optional: true } },
    })
    const downstream = makePackage({
      name: '@test/app',
      path: 'packages/app',
      dependencies: { '@test/utils': 'workspace:*' },
      peerDependencies: { react: '^19.0.0' },
      // missing peerDependenciesMeta for react
    })
    const ctx = makeContext([upstream, downstream])

    const issues = validatePackageRecompositionForPackage({ ctx, pkgName: '@test/app' })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      severity: 'error',
      rule: 'recompose-peer-meta',
    })
  })

  it('private package: skips peer meta check when dep satisfied via dependencies', () => {
    const upstream = makePackage({
      name: '@test/utils',
      path: 'packages/utils',
      peerDependencies: { react: '^19.0.0' },
      peerDependenciesMeta: { react: { optional: true } },
    })
    const downstream = makePackage({
      name: '@test/example',
      path: 'examples/my-example',
      private: true,
      dependencies: { '@test/utils': 'workspace:*', react: '^19.0.0' },
      // no peerDependencies or peerDependenciesMeta — should be fine for private packages
    })
    const ctx = makeContext([upstream, downstream])

    const issues = validatePackageRecompositionForPackage({ ctx, pkgName: '@test/example' })
    expect(issues).toEqual([])
  })

  it('reports missing patch from upstream', () => {
    const upstream = makePackage({
      name: '@test/utils',
      path: 'packages/utils',
      pnpm: { patchedDependencies: { 'some-pkg@1.0.0': 'patches/some-pkg.patch' } },
    })
    const downstream = makePackage({
      name: '@test/app',
      path: 'packages/app',
      dependencies: { '@test/utils': 'workspace:*' },
    })
    const ctx = makeContext([upstream, downstream])

    const issues = validatePackageRecompositionForPackage({ ctx, pkgName: '@test/app' })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      severity: 'error',
      rule: 'recompose-patches',
    })
  })

  it('private package: accepts peer dep satisfied via dependencies', () => {
    const upstream = makePackage({
      name: '@test/utils',
      path: 'packages/utils',
      peerDependencies: { effect: '^3.0.0' },
    })
    const downstream = makePackage({
      name: '@test/example',
      path: 'examples/my-example',
      private: true,
      dependencies: { '@test/utils': 'workspace:*', effect: '^3.0.0' },
    })
    const ctx = makeContext([upstream, downstream])

    const issues = validatePackageRecompositionForPackage({ ctx, pkgName: '@test/example' })
    expect(issues).toEqual([])
  })

  it('private package: accepts peer dep satisfied via devDependencies', () => {
    const upstream = makePackage({
      name: '@test/utils',
      path: 'packages/utils',
      peerDependencies: { effect: '^3.0.0' },
    })
    const downstream = makePackage({
      name: '@test/example',
      path: 'examples/my-example',
      private: true,
      dependencies: { '@test/utils': 'workspace:*' },
      devDependencies: { effect: '^3.0.0' },
    })
    const ctx = makeContext([upstream, downstream])

    const issues = validatePackageRecompositionForPackage({ ctx, pkgName: '@test/example' })
    expect(issues).toEqual([])
  })

  it('private package: accepts peer dep satisfied via peerDependencies', () => {
    const upstream = makePackage({
      name: '@test/utils',
      path: 'packages/utils',
      peerDependencies: { effect: '^3.0.0' },
    })
    const downstream = makePackage({
      name: '@test/example',
      path: 'examples/my-example',
      private: true,
      dependencies: { '@test/utils': 'workspace:*' },
      peerDependencies: { effect: '^3.0.0' },
    })
    const ctx = makeContext([upstream, downstream])

    const issues = validatePackageRecompositionForPackage({ ctx, pkgName: '@test/example' })
    expect(issues).toEqual([])
  })

  it('private package: reports missing dep when not in any dep field', () => {
    const upstream = makePackage({
      name: '@test/utils',
      path: 'packages/utils',
      peerDependencies: { effect: '^3.0.0' },
    })
    const downstream = makePackage({
      name: '@test/example',
      path: 'examples/my-example',
      private: true,
      dependencies: { '@test/utils': 'workspace:*' },
    })
    const ctx = makeContext([upstream, downstream])

    const issues = validatePackageRecompositionForPackage({ ctx, pkgName: '@test/example' })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      severity: 'error',
      packageName: '@test/example',
      dependency: 'effect',
      rule: 'recompose-peer-deps',
      message:
        'Missing dep "effect" (peer dep of "@test/utils") in dependencies or devDependencies',
    })
  })

  it('skips non-workspace dependencies', () => {
    const upstream = makePackage({
      name: 'lodash',
      path: 'packages/lodash',
      peerDependencies: { react: '^19.0.0' },
    })
    const downstream = makePackage({
      name: '@test/app',
      path: 'packages/app',
      dependencies: { lodash: '^4.17.0' }, // not a workspace spec
    })
    const ctx = makeContext([upstream, downstream])

    const issues = validatePackageRecompositionForPackage({ ctx, pkgName: '@test/app' })
    expect(issues).toEqual([])
  })

  it('handles file: and link: workspace specs', () => {
    const upstream = makePackage({
      name: '@test/utils',
      path: 'packages/utils',
      peerDependencies: { effect: '^3.0.0' },
    })
    const downstream = makePackage({
      name: '@test/app',
      path: 'packages/app',
      dependencies: { '@test/utils': 'file:../utils' },
      // missing peer dep
    })
    const ctx = makeContext([upstream, downstream])

    const issues = validatePackageRecompositionForPackage({ ctx, pkgName: '@test/app' })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ rule: 'recompose-peer-deps' })
  })

  it('returns empty when package not found in context', () => {
    const ctx = makeContext([])
    const issues = validatePackageRecompositionForPackage({ ctx, pkgName: '@test/nonexistent' })
    expect(issues).toEqual([])
  })

  it('returns empty when packageJson context is missing', () => {
    const ctx: GenieContext = { location: '.', cwd: '/workspace' }
    const issues = validatePackageRecompositionForPackage({ ctx, pkgName: '@test/app' })
    expect(issues).toEqual([])
  })

  it('checks optionalDependencies as well as dependencies', () => {
    const upstream = makePackage({
      name: '@test/utils',
      path: 'packages/utils',
      peerDependencies: { effect: '^3.0.0' },
    })
    const downstream = makePackage({
      name: '@test/app',
      path: 'packages/app',
      optionalDependencies: { '@test/utils': 'workspace:*' },
      // missing peer dep
    })
    const ctx = makeContext([upstream, downstream])

    const issues = validatePackageRecompositionForPackage({ ctx, pkgName: '@test/app' })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ rule: 'recompose-peer-deps' })
  })
})
