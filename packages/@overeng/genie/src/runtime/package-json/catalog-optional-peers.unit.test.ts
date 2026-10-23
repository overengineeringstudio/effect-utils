import { describe, expect, it } from 'bun:test'

import { defineCatalog } from './catalog.ts'
import { packageJson } from './mod.ts'

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

      expect(composed.dependencies).toEqual({
        [pkg.data.name]: 'workspace:^',
        ...(installed === true ? { effect: catalog.effect } : {}),
      })
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
})
