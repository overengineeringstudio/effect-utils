import { describe, expect, it } from 'bun:test'

import type { PackageInfo } from '../../common/types.ts'
import { defineCatalog } from './catalog.ts'
import { packageJson } from './mod.ts'
import { validatePackageRecompositionForPackage } from './validators/recompose.ts'

const catalog = defineCatalog({ effect: '3.19.14' })
const repo = { repoName: 'test-repo' }
const workspace = ({ repoName, memberPath }: { repoName: string; memberPath: string }) => ({
  repoName,
  memberPath,
})

describe('install-mode inherited optional peers', () => {
  it.each([
    {
      description: 'skips an optional peer by default',
      optional: true,
      optIn: false,
      installed: false,
    },
    {
      description: 'installs an opted-in optional peer',
      optional: true,
      optIn: true,
      installed: true,
    },
    {
      description: 'installs an explicitly required peer',
      optional: false,
      optIn: false,
      installed: true,
    },
    {
      description: 'installs a peer without metadata',
      optional: undefined,
      optIn: false,
      installed: true,
    },
  ])('$description', ({ optional, optIn, installed }) => {
    const utils = packageJson(
      {
        name: '@test/utils',
        version: '1.0.0',
        ...(optional === undefined ? {} : { peerDependenciesMeta: { effect: { optional } } }),
      },
      catalog.compose({
        workspace: workspace({ repoName: repo.repoName, memberPath: 'packages/utils' }),
        peerDependencies: { external: catalog.peers('effect') },
      }),
    )
    const core = packageJson(
      { name: '@test/core', version: '1.0.0' },
      catalog.compose({
        workspace: workspace({ repoName: repo.repoName, memberPath: 'packages/core' }),
        dependencies: { workspace: [utils] },
      }),
    )

    // Exercise both direct and transitive inheritance through the public API.
    for (const pkg of [utils, core]) {
      const composed = catalog.compose({
        workspace: workspace({ repoName: repo.repoName, memberPath: 'packages/app' }),
        dependencies: { workspace: [pkg] },
        mode: 'install',
        optionalPeerInstalls: optIn === true ? ['effect'] : [],
      })

      expect(composed.dependencies).toHaveProperty(pkg.data.name, 'workspace:^')
      expect(Object.keys(composed.dependencies)).toHaveLength(installed === true ? 2 : 1)
      if (installed === true) {
        expect(composed.dependencies).toHaveProperty('effect', catalog.effect)
      } else {
        expect(composed.dependencies).not.toHaveProperty('effect')
      }
    }
  })

  it('does not require a catalog version for a skipped optional peer', () => {
    const utils = packageJson(
      {
        name: '@test/utils',
        version: '1.0.0',
        peerDependenciesMeta: { missing: { optional: true } },
      },
      catalog.compose({
        workspace: workspace({ repoName: repo.repoName, memberPath: 'packages/utils' }),
        peerDependencies: { external: { missing: '^1.0.0' } },
      }),
    )

    expect(
      catalog.compose({
        workspace: workspace({ repoName: repo.repoName, memberPath: 'packages/app' }),
        dependencies: { workspace: [utils] },
        mode: 'install',
      }).dependencies,
    ).toEqual({ '@test/utils': 'workspace:^' })
  })

  it.each([
    { optional: true, private: true, issues: 0 },
    { optional: false, private: true, issues: 1 },
    { optional: true, private: false, issues: 1 },
  ])('validates an omitted peer (optional=$optional, private=$private)', (testCase) => {
    const packages: PackageInfo[] = [
      {
        name: '@test/utils',
        path: 'packages/utils',
        peerDependencies: catalog.peers('effect'),
        peerDependenciesMeta: { effect: { optional: testCase.optional } },
      },
      {
        name: '@test/app',
        path: 'packages/app',
        private: testCase.private,
        dependencies: { '@test/utils': 'workspace:^' },
      },
    ]

    expect(
      validatePackageRecompositionForPackage({
        ctx: {
          location: '.',
          cwd: '/workspace',
          workspace: {
            packages,
            byName: new Map(packages.map((pkg) => [pkg.name, pkg])),
          },
        },
        pkgName: '@test/app',
      }),
    ).toHaveLength(testCase.issues)
  })

  it('rejects a ranged optional peer installed through optionalDependencies', () => {
    const packages: PackageInfo[] = [
      {
        name: '@test/utils',
        path: 'packages/utils',
        peerDependencies: catalog.peers('effect'),
        peerDependenciesMeta: { effect: { optional: true } },
      },
      {
        name: '@test/app',
        path: 'packages/app',
        private: true,
        dependencies: { '@test/utils': 'workspace:^' },
        optionalDependencies: { effect: '^2.0.0' },
      },
    ]

    const issues = validatePackageRecompositionForPackage({
      ctx: {
        location: '.',
        cwd: '/workspace',
        workspace: {
          packages,
          byName: new Map(packages.map((pkg) => [pkg.name, pkg])),
        },
      },
      pkgName: '@test/app',
    })

    expect(issues).toHaveLength(1)
    expect(issues[0]?.rule).toBe('recompose-local-peer-range')
    expect(issues[0]?.dependency).toBe('effect')
  })
})
